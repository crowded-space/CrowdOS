import type { ContextPacket, RuntimeResult, RuntimeEvent } from '../types.js'
import type { EventBroker } from '../../event-broker/event-broker-gate.js'
import { BaseRuntime } from './base-runtime.js'
import { swarmGate } from '../../swarm/swarm-gate.js'

export class SwarmRuntime extends BaseRuntime {
  readonly type = 'swarm' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    // Rollback: SWARM_V1=false routes swarm → agentic (spec)
    if (!swarmGate.isV1Enabled()) {
      const { AgenticRuntime } = await import('./agentic-runtime.js')
      const agentic = new AgenticRuntime()
      return agentic.execute(packet, broker)
    }

    try {
      if (packet.abortSignal?.aborted) {
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: 'Run cancelled by user.',
          runtimeEvents,
          usage,
          status: 'cancelled',
        }
      }

      await this.kernel.setAgentStatus(broker, packet.agentId, 'working')
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId)

      const runId = packet.runId ?? packet.requestId

      // 1. Supervisor LLM → structured plan (with honest fallback)
      const planResult = await swarmGate.plan(packet, this.kernel as any, broker)
      const plan = planResult.plan
      usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

      // 2. Persist swarm_tasks DAG
      try {
        await swarmGate.deleteByRun(runId)
      } catch {}
      await swarmGate.createTasks(runId, plan.tasks)

      if (packet.abortSignal?.aborted) {
        await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: `Swarm cancelled after planning. Plan had ${plan.tasks.length} tasks.`,
          runtimeEvents,
          usage,
          status: 'cancelled',
        }
      }

      // 3. Leaf task dispatch (DAG respect, fan-out, lease reuse via heartbeats)
      const workerExecutor = async (task: { id: string; dependsOn: string[]; assigneeTemplate: string; goal?: string; description?: string }, _ctx: { packet: ContextPacket; broker: EventBroker; runId: string }) => {
        const subtaskPacket: ContextPacket = {
          ...packet,
          requestId: `${packet.requestId}:${task.id}`,
          userInput: task.goal ?? task.description ?? `Complete subtask ${task.id}`,
          systemPrompt: `${packet.systemPrompt}\n\nYou are a swarm worker (task ${task.id}). Complete ONLY this subtask concisely and return the result.`,
        };
        const res = await this.kernel.callLLM(subtaskPacket, broker);
        const content = (res.content ?? '').trim();
        if (content) return content;
        return `Worker ${task.id} completed with empty output (${task.goal ?? 'no goal'})`;
      };
      const dispatchResults = await swarmGate.dispatch({
        plan,
        runId,
        packet,
        broker,
        workerExecutor: workerExecutor as any,
        abortSignal: packet.abortSignal,
      })

      // 4. Aggregate (dedupe/conflict notes, honest partial completed X/Y)
      const tasks = await swarmGate.listByRun(runId)
      const aggregation = swarmGate.aggregate(tasks.length ? tasks : plan.tasks.map(t => ({
        id: t.id,
        runId,
        dependsOn: t.dependsOn,
        assigneeTemplate: t.assigneeTemplate,
        status: (dispatchResults.get(t.id)?.status === 'completed' ? 'completed' : 'failed') as any,
        outputRef: dispatchResults.get(t.id)?.output ?? dispatchResults.get(t.id)?.error ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)), dispatchResults)

      // 5. Verifier pass (independent model via cheap tier) gates COMPLETED
      const verification = await swarmGate.verify({
        goal: packet.userInput,
        aggregatedContent: aggregation.mergedContent,
        packet,
        broker,
        kernel: this.kernel as any,
        aggregationSummary: {
          completedCount: aggregation.completedCount,
          totalCount: aggregation.totalCount,
          failedTasks: aggregation.failedTasks,
        },
      })

      const finalStatus: RuntimeResult['status'] = verification.verdict === 'pass' ? 'completed' : 'failed'

      // 6. Store report artifact via Artifacts gate type report
      const reportContent = [
        `# Swarm Report — ${finalStatus.toUpperCase()}`,
        `Run: ${runId} | Channel: ${packet.channelId} | Agent: ${packet.agentName}`,
        plan.fallbackUsed ? `_Plan fallback used: ${plan.fallbackReason ?? 'LLM unavailable'}_` : '',
        `## Plan (${plan.tasks.length} tasks${plan.fallbackUsed ? ' — fallback' : ''})`,
        plan.tasks.map(t => `- ${t.id} dependsOn [${t.dependsOn.join(',') || '∅'}] → ${t.assigneeTemplate}: ${t.goal ?? t.description ?? ''}`).join('\n'),
        `## Aggregation`,
        aggregation.mergedContent,
        `## Verification — ${verification.verdict.toUpperCase()}`,
        verification.reason,
        verification.confidence !== undefined ? `Confidence: ${verification.confidence}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')

      try {
        const { artifactsGate } = await import('../../artifacts/artifacts-gate.js')
        await artifactsGate.create({
          runId: packet.runId ?? null,
          workspaceId: packet.workspaceId,
          producerAgent: packet.agentId,
          type: 'report',
          contentRef: reportContent.slice(0, 20000),
          metadata: {
            swarmRunId: runId,
            plan,
            aggregation,
            verification,
            finalStatus,
          },
        })
      } catch (err) {
        console.warn('[SwarmRuntime] artifact report write failed:', (err as Error)?.message || err)
      }

      // Persist final message honestly (partial aggregation reported truthfully)
      const finalResponse = [
        reportContent,
        finalStatus === 'completed' ? '' : `\n> Swarm verification failed: ${verification.reason}`,
      ]
        .filter(Boolean)
        .join('\n')

      try {
        await this.kernel.persistMessage(
          broker,
          packet.channelId,
          packet.agentId,
          packet.agentName,
          packet.authorityLevel,
          finalResponse,
          false,
          packet.runId ? { runId: packet.runId } : undefined,
          undefined,
          packet.workspaceId
        )
      } catch (err) {
        console.warn('[SwarmRuntime] persistMessage failed (hermetic mode preserves result):', (err as Error)?.message || err)
      }

      try {
        await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      } catch (err) {
        console.warn('[SwarmRuntime] setAgentStatus idle failed:', (err as Error)?.message || err)
      }

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse,
        runtimeEvents,
        usage,
        status: finalStatus,
      }
    } catch (err) {
      console.error(`[SwarmRuntime] Error:`, err)
      try {
        await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      } catch {}
      return await this.buildFailedResult(packet, err, broker)
    }
  }
}

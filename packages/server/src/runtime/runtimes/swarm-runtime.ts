import type { ContextPacket, RuntimeResult, RuntimeEvent } from '../types.js'
import type { EventBroker } from '../../event-broker/event-broker-gate.js'
import { BaseRuntime } from './base-runtime.js'
import { swarmGate } from '../../swarm/swarm-gate.js'
import { RuntimeKernel } from '../kernel/runtime-kernel.js'
import type { AgentProfile } from '../../agents/agent-gate.js'
import { ContextAssembler } from '../kernel/context-assembler.js'
import { AgenticRuntime } from './agentic-runtime.js'

export class SwarmRuntime extends BaseRuntime {
  readonly type = 'swarm' as const
  // Workers are ordinary agents, so their packets come from the same assembly
  // pipeline as any other run (§27) — identity, instructions, memory, tools.
  private readonly assembler = new ContextAssembler()

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    // Worker attribution: taskId -> the real agent that ran it. Populated by the
    // resolver and consumed by the report, so the plan's requested assignee and
    // the agent that actually executed are both visible.
    const workerAttribution = new Map<string, { agentId: string; agentName: string; matchKind: string; honestSubstitution?: string }>()
    // §26 artifacts[]: durable outputs produced by this run.
    const producedArtifacts: Array<{ id: string; type: string; persisted: boolean }> = []

    // Rollback: SWARM_V1=false routes swarm → agentic (spec)
    if (!swarmGate.isV1Enabled()) {
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

      // §22/§31: load the workspace roster ONCE and resolve every task against
      // it. One roster read per swarm, not one per task.
      const candidates = await swarmGate.loadWorkerCandidates(packet.workspaceId)

      // 1. Supervisor LLM → structured plan (with honest fallback)
      const planResult = await swarmGate.plan(packet, this.kernel as any, broker)
      const plan = planResult.plan
      // §23: supervisor planning is a paid call — count it with the workers.
      if (planResult.usage) {
        usage.promptTokens += planResult.usage.promptTokens ?? 0
        usage.completionTokens += planResult.usage.completionTokens ?? 0
        usage.totalTokens += planResult.usage.totalTokens ?? 0
      }

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
      // Real L3 delegation (§22/§31). Each task is assigned to an actual
      // worker agent and executed through its OWN assembled context — its
      // instructions, its model module, its capabilities — instead of
      // re-running the orchestrator under a "you are a worker" suffix.
      //
      // The worker runs the SAME agentic loop as any other agent — tools,
      // capability expansion, the lot — because a "worker" that cannot act on
      // its subtask is not a worker. Two things are switched off: its transcript
      // is not committed to the channel (quiet kernel), and it writes no memory
      // (§31 defines L3 as stateless — enforced at the tool executor, so a
      // worker cannot write a memory note even if it tries). The orchestrator's report stays the only
      // thing the channel sees.
      const workerRuntime = new AgenticRuntime({
        kernel: new RuntimeKernel({ persistMessages: false }),
        persistMemories: false,
        // §31: `stateless` travels onto every tool call so the executor refuses
        // memory-writing tools too. persistMemories alone only suppressed the
        // reflection note, leaving `remember` reachable from a worker.
        stateless: true,
      })
      const workerExecutor = async (
        task: { id: string; dependsOn: string[]; assigneeTemplate: string; goal?: string; description?: string },
        _ctx: { packet: ContextPacket; broker: EventBroker; runId: string },
      ) => {
        const resolved = swarmGate.resolveWorker(task.assigneeTemplate, candidates, {
          requestingAgent: { id: packet.agentId, name: packet.agentName, authorityLevel: packet.authorityLevel } as AgentProfile,
        })
        workerAttribution.set(task.id, {
          agentId: resolved.agent.id,
          agentName: resolved.agent.name,
          matchKind: resolved.matchKind,
          honestSubstitution: resolved.honestSubstitution,
        })

        const goal = task.goal ?? task.description ?? `Complete subtask ${task.id}`
        const workerPacket = await this.assembler.assemble({
          agent: resolved.agent,
          channelId: packet.channelId,
          workspaceId: packet.workspaceId,
          userInput: goal,
          runtimeType: 'agentic',
          abortSignal: packet.abortSignal,
          runId: packet.runId ?? null,
        })
        // A worker gets the full agentic loop: it may need to read a file or run
        // a command to finish a surgical subtask. Its usage is accumulated so
        // the swarm's budget accounting reflects what the workers actually spent
        // — this was previously hard-zeroed, so every swarm looked free.
        const workerResult = await workerRuntime.execute(workerPacket, broker)
        usage.promptTokens += workerResult.usage.promptTokens ?? 0
        usage.completionTokens += workerResult.usage.completionTokens ?? 0
        usage.totalTokens += workerResult.usage.totalTokens ?? 0
        // A worker that FAILED must fail its task. Returning its error string as
        // if it were a result would let the aggregator report "completed 2/2" for
        // work that never happened — the failure text would even be counted as
        // successful output. The dispatcher converts a throw into an honest
        // per-task failure with the reason attached.
        if (workerResult.status !== 'completed') {
          throw new Error(
            `worker ${resolved.agent.name} (${resolved.agent.id}) ${workerResult.status} on task ${task.id}: ${workerResult.finalResponse}`,
          )
        }
        const content = (workerResult.finalResponse ?? '').trim()
        if (content) return content
        return `Worker ${task.id} (${resolved.agent.name}) completed with empty output (${goal})`;
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

      // Worker attribution (§22/§31): the plan says who SHOULD run each task;
      // this says who DID. Substitutions are printed, never hidden — a report
      // that shows only the requested assignee would misrepresent the run.
      const attributionLines = plan.tasks.map((t) => {
        const who = workerAttribution.get(t.id)
        if (!who) return `- ${t.id}: NOT DISPATCHED (no worker resolved)`
        const note = who.honestSubstitution ? ` — ${who.honestSubstitution}` : ''
        return `- ${t.id} → ${who.agentName} (${who.agentId}) [match: ${who.matchKind}]${note}`
      })
      // §23: the verifier is a paid call too — a swarm that hides its
      // verification cost under-reports what it spent.
      if (verification.usage) {
        usage.promptTokens += verification.usage.promptTokens ?? 0
        usage.completionTokens += verification.usage.completionTokens ?? 0
        usage.totalTokens += verification.usage.totalTokens ?? 0
      }
      const substitutions = [...workerAttribution.values()].filter((w) => w.honestSubstitution)

      // 6. Store report artifact via Artifacts gate type report
      const reportContent = [
        `# Swarm Report — ${finalStatus.toUpperCase()}`,
        `Run: ${runId} | Channel: ${packet.channelId} | Agent: ${packet.agentName}`,
        plan.fallbackUsed ? `_Plan fallback used: ${plan.fallbackReason ?? 'LLM unavailable'}_` : '',
        `## Plan (${plan.tasks.length} tasks${plan.fallbackUsed ? ' — fallback' : ''})`,
        plan.tasks.map(t => `- ${t.id} dependsOn [${t.dependsOn.join(',') || '∅'}] → ${t.assigneeTemplate}: ${t.goal ?? t.description ?? ''}`).join('\n'),
        `## Workers`,
        attributionLines.join('\n'),
        substitutions.length > 0
          ? `_${substitutions.length} task(s) ran under a substituted worker — reasons listed above._`
          : '',
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
        const reportArtifact = await artifactsGate.create({
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
        producedArtifacts.push({
          id: (reportArtifact as unknown as { id?: string })?.id ?? 'unpersisted',
          type: 'report',
          persisted: Boolean((reportArtifact as unknown as { id?: string })?.id),
        })
      } catch (err) {
        console.warn('[SwarmRuntime] artifact report write failed:', (err as Error)?.message || err)
        producedArtifacts.push({ id: 'unpersisted', type: 'report', persisted: false })
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
        // §26 artifacts[]: the swarm report is the run's durable output.
        artifacts: producedArtifacts,
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

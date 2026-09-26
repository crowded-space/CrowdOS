import { randomUUID } from 'node:crypto'
import type { ContextPacket, RuntimeResult, RuntimeEvent, ToolCallRecord, HistoryMessage, ResumeContext } from '../types.js'
import type { EventBroker } from '../../event-broker/event-broker-gate.js'
import { BaseRuntime } from './base-runtime.js'
import { enforcePerIterationBudget } from '../kernel/context-budget.js'
import { toolsGate } from '../../tools/tools-gate.js'
import { AGENT_COMPLETE, isLifecycleTool } from '../agent-control-tools.js'
import { clearToolExpansions, expandedToolSchemas } from '../../shared/core/tool-expansion-registry.js'
import type { AgentCompleteInput } from '../agent-control-tools.js'

// ≈ maxToolOutputTokens (2000) at ~4 chars/token — prevents unbounded tool
// output from being re-sent in every subsequent model call (context O(n²) growth).
const MAX_TOOL_OUTPUT_CHARS = 8000

function clampToolOutput(output: string): string {
  if (!output || output.length <= MAX_TOOL_OUTPUT_CHARS) return output
  const omitted = output.length - MAX_TOOL_OUTPUT_CHARS
  return (
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n[... output truncated (${omitted} chars omitted) to fit context budget ...]`
  )
}

export class AgenticRuntime extends BaseRuntime {
  readonly type = 'agentic' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const resumeContext = (packet as unknown as { resumeContext?: ResumeContext | null }).resumeContext ?? null
    const completedIds = new Set(resumeContext?.completedCallIds ?? [])
    const runtimeEvents: RuntimeEvent[] = []
    const toolCallRecords: ToolCallRecord[] = []

    try {
      // PERF-3 rollback switch: PER_ITERATION_BUDGET=false restores the legacy
      // behavior (assembly-time-only cap, memory preview on every iteration).
      const perIterationBudgetEnabled = process.env.PER_ITERATION_BUDGET !== 'false'

      await this.kernel.setAgentStatus(broker, packet.agentId, 'working')
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId)

      let iteration = 0
      let finalResponse = ''
      let lastThoughts: string | undefined
      let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

      // Keep a local copy of message history to append tool execution outcomes
      const localHistory: HistoryMessage[] = [...packet.history]

      while (iteration < packet.policies.maxIterations) {
        iteration++

        // Cancellation checkpoint (HM2): stop before starting another paid model call
        if (packet.abortSignal?.aborted) {
          finalResponse = finalResponse || 'Run cancelled by user.'
          break
        }

        // Build a temporary request packet with a snapshot of the updated
        // history (the LLM request must not alias the live working array)
        let tempPacket: ContextPacket = {
          ...packet,
          history: [...localHistory],
        }

        // §21 lazy expansion: union in any capability schemas this run has
        // expanded since the packet was assembled. Without this the discovery
        // layer would be a dead end — the model would be told a capability
        // exists, expand it, and still be unable to call it because native
        // function calling only accepts schemas present in the request.
        tempPacket = this.withExpandedTools(tempPacket)

        // PERF-3: re-check the same char/token budget the assembler enforced,
        // now that monologue + tool-result turns have been appended. The memory
        // preview is injected on iteration 1 only — later calls rely on history.
        if (perIterationBudgetEnabled) {
          tempPacket = enforcePerIterationBudget(tempPacket, {
            dropMemoryPreview: iteration > 1,
            iterationIndex: iteration,
          })
        }

        const llmResponse = await this.kernel.callLLM(tempPacket, broker)

        totalUsage.promptTokens += llmResponse.usage.promptTokens
        totalUsage.completionTokens += llmResponse.usage.completionTokens
        totalUsage.totalTokens += llmResponse.usage.totalTokens

        if (llmResponse.thoughts) {
          lastThoughts = llmResponse.thoughts
          await this.kernel.persistMessage(
            broker, packet.channelId, packet.agentId,
            packet.agentName, packet.authorityLevel,
            llmResponse.thoughts, true,
            packet.runId ? { runId: packet.runId } : undefined,
            undefined,
            packet.workspaceId
          )

          // Auto-write monologue reflection note — off the hot path (HQ3)
          const { hook, brief: cleanBrief } = this.summarizeThoughts(llmResponse.thoughts)
          this.writeReflectionNoteAsync({
            agentId: packet.agentId,
            channelId: packet.channelId,
            workspaceId: packet.workspaceId,
            importanceScore: 0.6,
            hook,
            brief: cleanBrief,
            observed: `Reasoning cycle iteration ${iteration} for user input: "${packet.userInput.slice(0, 100)}"`,
            interpreted: llmResponse.thoughts.trim(),
            futureRelevance: "Retain task reasoning reflection for continuous contextual alignment.",
          })
        }

        // Native tool calls from adapter (primary path)
        const nativeToolCalls = llmResponse.toolCalls || []

        // Check if model called agent_complete (native path)
        const completeCall = nativeToolCalls.find(tc => tc.name === AGENT_COMPLETE)
        if (completeCall) {
          finalResponse = (completeCall.input as unknown as AgentCompleteInput).response || llmResponse.content
          break
        }

        // Filter to executable tools (exclude lifecycle tools)
        const executableCalls = nativeToolCalls.filter(tc => !isLifecycleTool(tc.name))

        if (executableCalls.length === 0 || !packet.policies.allowToolCalls) {
          // No executable tools = implicit completion
          finalResponse = llmResponse.content
          break
        }

        // Push assistant turn with native tool calls attached.
        // isSelf marks this monologue for the budget trim policy: the newest
        // self turn is always preserved when trimming history (PERF-3).
        localHistory.push({
          role: 'assistant',
          content: llmResponse.content || '',
          authorName: packet.agentName,
          isSelf: true,
          timestamp: new Date(),
          toolCalls: llmResponse.toolCalls,
        })

        // Execute tool calls parsed from the response.
        // PERF-8: ToolExecutor.executeBatch classifies read vs write/side-effect
        // per tool; reads run concurrently (bounded), writes stay sequential in
        // call order. Results always return in request order.
        // Emit starts in call order before dispatch
        // ponytail: one id per call — two randomUUID()s broke start/complete correlation
        const callIds = executableCalls.map((tc) => tc.id || randomUUID());
        for (let ci = 0; ci < executableCalls.length; ci++) {
          const tc = executableCalls[ci];
          broker.emit('tool:start', {
            callId: callIds[ci],
            agentId: packet.agentId,
            channelId: packet.channelId,
            toolName: tc.name,
            runId: packet.runId ?? null,
            input: tc.input as Record<string, unknown>,
          })
          runtimeEvents.push(this.kernel.buildEvent('tool:start', { toolName: tc.name, agentId: packet.agentId }))
        }

        // Auto-thread agentId/channelId into memory tools before execution
        for (const tc of executableCalls) {
          const args = tc.input as Record<string, unknown>
          if (tc.name === 'open_memory' || tc.name === 'remember') {
            if (!args.agent_id) args.agent_id = packet.agentId
            if (!args.channel_id) args.channel_id = packet.channelId
          }
        }

        const toExecuteIndexes: number[] = []
        const skippedIndexes: Set<number> = new Set()
        for (let idx = 0; idx < executableCalls.length; idx++) {
          const tc = executableCalls[idx]
          const cid = tc.id
          if (cid && completedIds.has(cid)) {
            skippedIndexes.add(idx)
          } else {
            toExecuteIndexes.push(idx)
          }
        }
        const batchCalls = toExecuteIndexes.map((idx) => ({
          toolId: executableCalls[idx].name,
          args: executableCalls[idx].input as Record<string, unknown>,
        }))
        const batchResults = batchCalls.length > 0 ? await toolsGate.executeBatch(
          packet.agentId,
          batchCalls,
          {
            channelId: packet.channelId,
            workspaceId: packet.workspaceId,
            abortSignal: packet.abortSignal,
            runId: packet.runId,
            broker,
            // §31: a stateless worker's tool calls are refused memory writes
            // at the executor — the guarantee has to travel with the call, not
            // live only on the reflection path.
            stateless: this.stateless,
          } as unknown as Record<string, unknown>
        ) : []
        const results: Array<{ success: boolean; output: string; error?: string; durationMs?: number }> = new Array(executableCalls.length)
        let batchCursor = 0
        for (let i = 0; i < executableCalls.length; i++) {
          if (skippedIndexes.has(i)) {
            results[i] = { success: true, output: `[resumed] tool call ${executableCalls[i].id} previously completed — skipped re-execution`, durationMs: 0 }
          } else {
            results[i] = batchResults[batchCursor++]
          }
        }

        // Process results strictly in call order (event + persistence ordering preserved)
        for (let i = 0; i < executableCalls.length; i++) {
          const tc = executableCalls[i]
          const result = results[i]
          const callId = callIds[i]
          const durationMs = result.durationMs ?? 0

          broker.emit('tool:complete', {
            callId,
            agentId: packet.agentId,
            channelId: packet.channelId,
            toolName: tc.name,
            runId: packet.runId ?? null,
            output: result.success ? result.output : undefined,
            error: result.success ? undefined : result.error,
            success: result.success,
            durationMs
          })
          runtimeEvents.push(this.kernel.buildEvent('tool:complete', {
            toolName: tc.name,
            success: result.success,
            durationMs,
            agentId: packet.agentId
          }))

          toolCallRecords.push({
            toolName: tc.name,
            input: tc.input as Record<string, unknown>,
            output: result.success ? result.output : result.error || 'Unknown tool error',
            success: result.success,
            durationMs,
          })

          const outcomeStr = clampToolOutput(result.success ? result.output : `Error: ${result.error}`)
          const truncated = !!result.output && result.output.length > MAX_TOOL_OUTPUT_CHARS

          // Persist the tool result as an internal log message so it's audit-logged.
          // Human-readable content stays byte-identical; structured record rides alongside (DB-5).
          const seq = await this.kernel.persistMessage(
            broker, packet.channelId, packet.agentId,
            packet.agentName, packet.authorityLevel,
            `🛠️ [Tool Result: ${tc.name}]\n${outcomeStr}`,
            true,
            packet.runId ? { runId: packet.runId } : undefined,
            [{
              name: tc.name,
              args: tc.input,
              result: outcomeStr,
              truncated,
              durationMs: result.durationMs ?? null,
              callId: tc.id ?? null,
            }],
            packet.workspaceId
          )

          if (packet.runId && tc.id) {
            void (async () => {
              try {
                const { runsGate } = await import("../../runs/runs-gate.js");
                await runsGate.touchCheckpoint(packet.runId as string, { watermarkSeq: seq, completedCallIds: [tc.id as string] });
              } catch (e) {
                console.warn(`[AgenticRuntime] checkpoint touch failed for ${tc.id}:`, (e as Error)?.message || e);
              }
            })()
          }

          // Feed the clamped tool result back into the prompt history for the next iteration
          localHistory.push({
            role: 'tool',
            content: outcomeStr,
            toolCallId: tc.id,
            toolName: tc.name,
            timestamp: new Date(),
          })
        }

        // Set the latest content as fallback in case we max out iterations
        finalResponse = llmResponse.content
      }

      // Guarantee non-empty final response
      const responseToPersist = finalResponse && finalResponse.trim().length > 0
        ? finalResponse
        : (lastThoughts ? `*Internal reasoning concluded without direct output:*\n\n${lastThoughts}` : "Task completed with no direct output.");

      await this.kernel.persistMessage(
        broker, packet.channelId, packet.agentId,
        packet.agentName, packet.authorityLevel,
        responseToPersist, false,
        packet.runId ? { runId: packet.runId } : undefined,
        undefined,
        packet.workspaceId
      )

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')

      const wasCancelled = packet.abortSignal?.aborted === true

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: responseToPersist,
        runtimeEvents,
        toolCalls: toolCallRecords,
        usage: totalUsage,
        status: wasCancelled ? 'cancelled' : 'completed',
      }
    } catch (err) {
      console.error(`[AgenticRuntime] Error:`, err)
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      return await this.buildFailedResult(packet, err, broker)
    } finally {
      // §21: a finished run’s expansions are no longer reachable, so drop them
      // rather than letting the registry grow one entry per run forever.
      clearToolExpansions(packet.runId ?? null)
    }
  }

  /**
   * Union the run’s lazily-expanded capability schemas into the packet’s tool
   * list. Returns the SAME packet reference when there is nothing to add, so the
   * under-expansion path stays byte-identical to the pre-§21 behavior.
   */
  private withExpandedTools(packet: ContextPacket): ContextPacket {
    let expanded: ReturnType<typeof expandedToolSchemas>
    try {
      expanded = expandedToolSchemas(packet.runId ?? null)
    } catch {
      return packet
    }
    if (expanded.length === 0) return packet

    const existing = packet.tools ?? []
    const known = new Set(existing.map((t) => t.name))
    const additions = expanded.filter((t) => !known.has(t.name))
    if (additions.length === 0) return packet
    return { ...packet, tools: [...existing, ...additions] }
  }
}

import type { ContextPacket, RuntimeResult, IRuntime, LLMResponse, RuntimeType } from '../types.js'
import type { EventBroker } from '../../event-broker/event-broker-gate.js'
import { RuntimeKernel } from '../kernel/runtime-kernel.js'
import { ProviderAbortError, ProviderTimeoutError, isProviderError } from '../providers/provider-errors.js'
import type { AgentAbortError } from '@crowdspace/pi-core'

export abstract class BaseRuntime implements IRuntime {
  abstract readonly type: RuntimeType
  protected readonly kernel: RuntimeKernel

  constructor() {
    this.kernel = new RuntimeKernel()
  }

  abstract execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult>

  /**
   * Fire-and-forget reflection memory note (HQ3).
   * Memory persistence is not required for correctness of the current response,
   * so it must never block the interactive hot path. Failures are logged only.
   */
  protected writeReflectionNoteAsync(note: {
    agentId: string
    channelId: string
    importanceScore?: number
    hook: string
    brief: string
    observed: string
    interpreted: string
    futureRelevance: string
  }): void {
    void (async () => {
      try {
        const { createMemoryNote } = await import("../../memories/memories-gate.js")
        await createMemoryNote({
          agentId: note.agentId,
          channelId: note.channelId,
          noteType: "reflection",
          importanceScore: note.importanceScore ?? 0.6,
          sourceType: "self_reflection",
          hook: note.hook,
          brief: note.brief,
          observed: note.observed,
          interpreted: note.interpreted,
          futureRelevance: note.futureRelevance,
        })
      } catch (err) {
        console.error(`[${this.constructor.name}] Failed to auto-write monologue reflection note:`, err)
      }
    })()
  }

  /** Extract hook/brief summary fields from a monologue for the reflection note. */
  protected summarizeThoughts(thoughts: string): { hook: string; brief: string; cleanBrief: string } {
    const cleanThoughts = thoughts.trim()
    const sentences = cleanThoughts.split(/[.!?]\s+/)
    const firstSentence = sentences[0] || ""
    const hook = firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence || "Reflected on task execution."
    const brief = sentences.slice(0, 3).join(". ")
    const cleanBrief = brief.length > 150 ? brief.slice(0, 147) + "..." : brief || "Analyzed task details and formulated execution path."
    return { hook, brief: cleanBrief, cleanBrief }
  }

  protected async buildFailedResult(
    packet: ContextPacket,
    error: unknown,
    broker?: EventBroker
  ): Promise<RuntimeResult> {
    // User-initiated cancellation is not a failure — report cleanly, persist nothing.
    // Typed errors first (CAN-1); string fallback retained for unknown shapes
    // (e.g. pi-core loop errors that only carry a message).
    const isAbort =
      packet.abortSignal?.aborted === true ||
      error instanceof ProviderAbortError ||
      (error as Partial<AgentAbortError>)?.name === 'AgentAbortError' ||
      (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)))
    if (isAbort) {
      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: 'Run cancelled by user.',
        runtimeEvents: [
          this.kernel.buildEvent('agent:status', { agentId: packet.agentId, status: 'idle' }),
        ],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'cancelled',
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const failureMsg = `⚠️ [Agent Runtime Warning] Request could not be completed: ${errorMessage}`
    if (broker) {
      try {
        await this.kernel.persistMessage(
          broker, packet.channelId, packet.agentId,
          packet.agentName, packet.authorityLevel,
          failureMsg, false,
          packet.runId ? { runId: packet.runId } : undefined,
          undefined,
          packet.workspaceId
        )
      } catch (persistErr) {
        console.error('[BaseRuntime] Failed to persist runtime error message:', persistErr)
      }
    }
    return {
      requestId: packet.requestId,
      agentId: packet.agentId,
      channelId: packet.channelId,
      finalResponse: `[${this.type}Runtime] Execution failed: ${errorMessage}`,
      runtimeEvents: [
        this.kernel.buildEvent('agent:status', { agentId: packet.agentId, status: 'idle' }),
      ],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'failed',
    }
  }

  /**
   * Pre-stream failure retry (CAN-1): up to 2 retries with exponential backoff
   * (1s, then 2s). Only connect-phase timeouts and network failures that occur
   * BEFORE the first stream chunk are eligible. Never retries once the stream
   * started, and never retries a caller-initiated abort.
   */
  protected async invokeProviderWithPreStreamRetry(
    attempt: (markStreamStarted: () => void) => Promise<LLMResponse>
  ): Promise<LLMResponse> {
    const maxRetries = 2
    let streamStarted = false

    for (let retry = 0; ; retry++) {
      try {
        return await attempt(() => {
          streamStarted = true
        })
      } catch (err) {
        if (streamStarted || !this.isPreStreamRetryableFailure(err) || retry >= maxRetries) throw err
        console.warn(`[${this.constructor.name}] Pre-stream provider failure (${retry + 1}/${maxRetries}), retrying in ${1000 * 2 ** retry}ms:`, err instanceof Error ? err.message : err)
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** retry))
      }
    }
  }

  private isPreStreamRetryableFailure(err: unknown): boolean {
    if (err instanceof ProviderAbortError) return false
    if (err instanceof ProviderTimeoutError) return true
    if (isProviderError(err)) return false
    const shape = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return /network error|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(shape)
  }
}

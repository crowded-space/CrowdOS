import { eq } from 'drizzle-orm'
import { performance } from 'node:perf_hooks'
import { withTransaction } from '../../shared/config/database.js'
import { allocateSequence } from '../../shared/core/sequence-number.js'
import { monotonicUlid } from '../../shared/core/ulid.js'
import { agents, messages, runtimeStates } from '../../db/schema.js'
import type { EventBroker } from '../../event-broker/event-broker-gate.js'
import type { StructuredToolCall } from '../../messages/message-gate.js'
import type { RuntimeStatus } from '../../types/runtime.types.js'
import type {
  ContextPacket,
  RuntimeResult,
  RuntimeEvent,
  LLMResponse,
} from '../types.js'
import { ProviderRegistry } from '../providers/provider-registry.js'
import { ReActStreamParser } from './re-act-stream-parser.js'
import { markAgentWorking, markAgentIdle } from '../../shared/core/agent-heartbeat.js'
import { logMetric } from '../../shared/core/structured-log.js'
import { recordTiming } from '../../shared/core/perf-metrics.js'
import { createChunkCoalescer, resolveStreamBatchMs, type ChunkCoalescer } from '../../shared/core/stream-coalescer.js'

/**
 * Stream chunk batching (P1 — stream batching): coalesce per-token socket
 * emissions into ~50ms flushes instead of one event per token. Configurable
 * via STREAM_BATCH_MS (0 disables batching and restores per-token emission).
 */
const STREAM_BATCH_MS = resolveStreamBatchMs(process.env.STREAM_BATCH_MS)

interface StreamBufferEntry {
  broker: EventBroker
  channelId: string
  agentId: string
  isThoughts: boolean
  coalescer: ChunkCoalescer
}

export class RuntimeKernel {
  private readonly streamBuffers = new Map<string, StreamBufferEntry>()

  private static streamKey(channelId: string, agentId: string, isThoughts?: boolean): string {
    return `${channelId}:${agentId}:${isThoughts ? 't' : 'c'}`
  }

  async callLLM(
    packet: ContextPacket,
    broker?: EventBroker,
    userPromptOverride?: string
  ): Promise<LLMResponse> {
    const start = performance.now()
    // SCL-3: OTel span for llm stage keyed by runId
    const tracing: typeof import("../../observability/tracing.js") | null = await import("../../observability/tracing.js").catch(() => null);
    const runId = (packet as unknown as { runId?: string | null }).runId ?? null;
    const span = tracing ? tracing.startSpan("llm", { runId, channelId: packet.channelId, agentId: packet.agentId, attributes: { provider: packet.metadata.provider, model: packet.metadata.modelName } }) : null;
    try {
      const res = await this._callLLM(packet, broker, userPromptOverride)
      if (span && tracing) tracing.endSpan(span, { attributes: { promptTokens: res.usage?.promptTokens ?? 0, completionTokens: res.usage?.completionTokens ?? 0 } });
      return res;
    } catch (err) {
      if (span && tracing) tracing.endSpan(span, { error: err });
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start)
      recordTiming('llm.call', durationMs)
      logMetric({ stage: 'llm.call', durationMs, provider: packet.metadata.provider, model: packet.metadata.modelName, agent: packet.agentName, runId: runId ?? undefined })
      this.flushStreams(packet.channelId, packet.agentId)
    }
  }

  private async _callLLM(
    packet: ContextPacket,
    broker?: EventBroker,
    userPromptOverride?: string
  ): Promise<LLMResponse> {
    const adapter = ProviderRegistry.get(packet.metadata.provider)
    const modelConfig = (packet as any)._modelConfig

    const shouldStream = broker && packet.policies.streamOutput && adapter.supportsStreaming

    if (shouldStream && broker) {
      let thoughtsBuffer = ''
      let contentBuffer = ''

      const onChunk = (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => {
        if (!chunk.content) return

        if (chunk.isThoughts) {
          thoughtsBuffer += chunk.content
          this.streamChunk(broker, packet.channelId, packet.agentId, chunk.content, true, true)
        } else {
          contentBuffer += chunk.content
          this.streamChunk(broker, packet.channelId, packet.agentId, chunk.content, false, true)
        }
      }

      const rawResponse = await adapter.call(
        modelConfig,
        {
          systemPrompt: packet.systemPrompt,
          userPrompt: buildUserPrompt(packet, userPromptOverride),
          history: packet.history,
          tools: packet.tools,
        },
        onChunk,
        { signal: packet.abortSignal }
      )

      let resolvedContent = rawResponse.content || contentBuffer
      let resolvedThoughts = rawResponse.thoughts || (thoughtsBuffer.trim() || undefined)

      const hasNativeToolCalls = rawResponse.toolCalls && rawResponse.toolCalls.length > 0
      if (!resolvedThoughts && resolvedContent && !hasNativeToolCalls) {
        const parsed = ReActStreamParser.parse(resolvedContent)
        if (parsed.thoughts) {
          resolvedThoughts = parsed.thoughts
          resolvedContent = parsed.content
        }
      }

      return {
        ...rawResponse,
        content: resolvedContent,
        thoughts: resolvedThoughts,
      }
    }

    const rawResponse = await adapter.call(modelConfig, {
      systemPrompt: packet.systemPrompt,
      userPrompt: buildUserPrompt(packet, userPromptOverride),
      history: packet.history,
      tools: packet.tools,
    }, undefined, { signal: packet.abortSignal })

    const hasNativeToolCalls = rawResponse.toolCalls && rawResponse.toolCalls.length > 0
    const parsed = hasNativeToolCalls
      ? { thoughts: '', content: rawResponse.content }
      : ReActStreamParser.parse(rawResponse.content)

    // For synchronous calls, if streaming is requested, we emit the completed block as a single chunk instantly (no delay)
    if (broker && packet.policies.streamOutput) {
      if (parsed.thoughts || rawResponse.thoughts) {
        this.streamChunk(broker, packet.channelId, packet.agentId, parsed.thoughts || rawResponse.thoughts || '', true, false)
      }
      this.streamChunk(broker, packet.channelId, packet.agentId, parsed.content, false, false)
    }

    return {
      ...rawResponse,
      content: parsed.content,
      thoughts: parsed.thoughts || rawResponse.thoughts,
    }
  }

  async persistMessage(
    broker: EventBroker,
    channelId: string,
    agentId: string,
    agentName: string,
    authorityLevel: number,
    content: string,
    isInternalMonologue: boolean,
    metadata?: Record<string, unknown> | undefined,
    toolCalls?: StructuredToolCall[] | undefined,
    workspaceId?: string | null | undefined
  ): Promise<number> {
    const start = performance.now()
    const runId = (metadata as Record<string, unknown> | undefined)?.runId as string | undefined ?? null
    const tracing: typeof import("../../observability/tracing.js") | null = await import("../../observability/tracing.js").catch(() => null);
    const span = tracing ? tracing.startSpan("persist", { runId, channelId, agentId, attributes: { op: "persist.message" } }) : null;

    const msgId = monotonicUlid()
    const timestamp = new Date()

    // DB-2: sequence reservation and the dependent message insert commit
    // atomically — a failed insert rolls the reservation back, so no 23505
    // and no gaps under concurrent writers.
    let sequenceNumber: number
    let persistError: unknown = null
    try {
      sequenceNumber = await withTransaction(async (tx) => {
        const seq = await allocateSequence(channelId, 1, tx)
        await tx.insert(messages).values({
          id: msgId,
          channelId,
          workspaceId: workspaceId ?? null,
          authorId: agentId,
          authorName: agentName,
          authorLevel: String(authorityLevel),
          authorType: 'agent',
          content,
          mentions: [],
          isInternalMonologue,
          metadata,
          toolCalls,
          sequenceNumber: seq,
          timestamp,
        })
        return seq
      })
    } catch (err) {
      persistError = err
      if (span && tracing) tracing.endSpan(span, { error: err })
      throw err
    }

    const persistDurationMs = Math.round(performance.now() - start)
    recordTiming('persist.message', persistDurationMs)
    logMetric({ stage: 'persist.message', durationMs: persistDurationMs, channelId, runId: runId ?? undefined })
    if (span && tracing && !persistError) tracing.endSpan(span, { attributes: { durationMs: persistDurationMs } })

    broker.emit(
      'message:new',
      {
        id: msgId,
        channelId,
        authorId: agentId,
        authorName: agentName,
        authorLevel: authorityLevel as any,
        authorType: 'agent',
        content,
        mentions: [],
        isInternalMonologue,
        metadata,
        toolCalls,
        sequenceNumber,
        timestamp,
      },
      { channelId }
    )

    return sequenceNumber
  }

  async setAgentStatus(
    broker: EventBroker,
    agentId: string,
    status: RuntimeStatus
  ): Promise<void> {
    // DB-2: agents.status and runtimeStates.status/heartbeat flip atomically.
    await withTransaction(async (tx) => {
      await tx.update(agents).set({ status }).where(eq(agents.id, agentId))

      // Keep runtimeStates in sync + write an immediate heartbeat (P0-4) so
      // zombie detection works even if the process dies mid-run.
      await tx
        .update(runtimeStates)
        .set({ status, lastHeartbeat: new Date() })
        .where(eq(runtimeStates.agentId, agentId))
    })

    // Heartbeat registration (P0-4): track working agents so the orphan sweeper
    // can distinguish live runs from crashed zombies.
    if (status === 'working') markAgentWorking(agentId)
    else markAgentIdle(agentId)

    broker.emit('agent:status', { agentId, status })
  }

  streamChunk(
    broker: EventBroker,
    channelId: string,
    agentId: string,
    chunk: string,
    isThoughts?: boolean,
    streamed?: boolean
  ): void {
    // Non-streamed single-block emissions go out immediately — batching only
    // applies to live token streams where per-token events dominate.
    if (!streamed || STREAM_BATCH_MS <= 0) {
      broker.emit('message:stream', { channelId, agentId, chunk, isThoughts, streamed }, { channelId })
      return
    }

    const key = RuntimeKernel.streamKey(channelId, agentId, isThoughts)
    let entry = this.streamBuffers.get(key)
    if (!entry) {
      const thoughtFlag = !!isThoughts
      const created: StreamBufferEntry = {
        broker,
        channelId,
        agentId,
        isThoughts: thoughtFlag,
        coalescer: createChunkCoalescer(
          (content) => {
            broker.emit('message:stream', { channelId, agentId, chunk: content, isThoughts: thoughtFlag, streamed: true }, { channelId })
          },
          STREAM_BATCH_MS,
          () => this.streamBuffers.delete(key)
        ),
      }
      this.streamBuffers.set(key, created)
      entry = created
    }
    entry.coalescer.push(chunk)
  }

  private flushStreamEntry(key: string, entry: StreamBufferEntry): void {
    entry.coalescer.flush()
    if (!entry.coalescer.pending && this.streamBuffers.get(key) === entry) {
      this.streamBuffers.delete(key)
    }
  }

  /**
   * Force-flush any pending buffered stream chunks for a channel/agent.
   * Called when the model stream completes so trailing tokens are not delayed
   * by up to one batch window.
   */
  flushStreams(channelId?: string, agentId?: string): void {
    for (const [key, entry] of [...this.streamBuffers]) {
      if (channelId !== undefined && entry.channelId !== channelId) continue
      if (agentId !== undefined && entry.agentId !== agentId) continue
      this.flushStreamEntry(key, entry)
    }
  }

  emitThinking(
    broker: EventBroker,
    agentId: string,
    channelId: string
  ): void {
    broker.emit('agent:thinking', { agentId, channelId }, { channelId })
  }

  buildEvent(
    type: RuntimeEvent['type'],
    payload: Record<string, unknown>
  ): RuntimeEvent {
    return { type, payload, timestamp: new Date() }
  }

  buildFailedResult(
    packet: ContextPacket,
    error: unknown
  ): RuntimeResult {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      requestId: packet.requestId,
      agentId: packet.agentId,
      channelId: packet.channelId,
      finalResponse: `Runtime execution failed: ${errorMessage}`,
      runtimeEvents: [
        this.buildEvent('agent:status', { agentId: packet.agentId, status: 'idle' }),
      ],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'failed',
    }
  }
}

/**
 * Build the effective userPrompt for an LLM call.
 * If the ContextPacket has a memoryPreviewBlock, it is prepended so the agent
 * sees its memory hooks before the current message.
 */
function buildUserPrompt(packet: ContextPacket, override?: string): string {
  const base = override ?? packet.userInput
  if (!packet.memoryPreviewBlock) return base
  return `${packet.memoryPreviewBlock}\n\n${base}`
}

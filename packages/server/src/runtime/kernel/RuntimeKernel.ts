import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../../Shared/config/database.js'
import { agents, messages } from '../../db/schema.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import type { RuntimeStatus } from '../../types/runtime.types.js'
import type {
  ContextPacket,
  RuntimeResult,
  RuntimeEvent,
  LLMResponse,
} from '../types.js'
import { ProviderRegistry } from '../providers/ProviderRegistry.js'
import { ReActStreamParser } from './ReActStreamParser.js'

export class RuntimeKernel {
  async callLLM(
    packet: ContextPacket,
    broker?: EventBroker,
    userPromptOverride?: string
  ): Promise<LLMResponse> {
    const adapter = ProviderRegistry.get(packet.metadata.provider)
    const modelConfig = (packet as any)._modelConfig

    const shouldStream = broker && packet.policies.streamOutput && adapter.supportsStreaming

    if (shouldStream) {
      let hasFinal = false
      let buffer = ''
      let thoughtsBuffer = ''
      let contentBuffer = ''

      const onChunk = (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => {
        // Case A: Adapter explicitly tags thoughts vs content (native thoughts e.g. Gemini 2.0+ or o1)
        if (chunk.isThoughts !== undefined) {
          if (chunk.isThoughts) {
            thoughtsBuffer += chunk.content
            this.streamChunk(broker, packet.channelId, packet.agentId, chunk.content, true, true)
          } else {
            contentBuffer += chunk.content
            this.streamChunk(broker, packet.channelId, packet.agentId, chunk.content, false, true)
          }
          return
        }

        // Case B: Sentinel-based streaming demultiplexer (for non-native thoughts models)
        buffer += chunk.content

        if (hasFinal) {
          contentBuffer += chunk.content
          this.streamChunk(broker, packet.channelId, packet.agentId, chunk.content, false, true)
          return
        }

        const triggerIndex = buffer.indexOf('&&FINAL_RESPONSE&&')
        if (triggerIndex !== -1) {
          const thoughtsPart = buffer.slice(0, triggerIndex)
          const contentPart = buffer.slice(triggerIndex + '&&FINAL_RESPONSE&&'.length)

          if (thoughtsPart) {
            thoughtsBuffer += thoughtsPart
            this.streamChunk(broker, packet.channelId, packet.agentId, thoughtsPart, true, true)
          }
          if (contentPart) {
            contentBuffer += contentPart
            this.streamChunk(broker, packet.channelId, packet.agentId, contentPart, false, true)
          }
          hasFinal = true
          buffer = ''
        } else {
          const tokenLength = '&&FINAL_RESPONSE&&'.length
          if (buffer.length > tokenLength) {
            const safeLength = buffer.length - tokenLength
            const safePart = buffer.slice(0, safeLength)
            thoughtsBuffer += safePart
            this.streamChunk(broker, packet.channelId, packet.agentId, safePart, true, true)
            buffer = buffer.slice(safeLength)
          }
        }
      }

      const rawResponse = await adapter.call(
        modelConfig,
        {
          systemPrompt: packet.systemPrompt,
          userPrompt: buildUserPrompt(packet, userPromptOverride),
          history: packet.history,
        },
        onChunk
      )

      // Final stream cleanup after SSE ends
      if (!hasFinal && buffer) {
        // Fallback delimiters parsing for remaining buffer
        const parsed = ReActStreamParser.parse(buffer)
        if (parsed.thoughts) {
          thoughtsBuffer += parsed.thoughts
          this.streamChunk(broker, packet.channelId, packet.agentId, parsed.thoughts, true, true)
        }
        if (parsed.content) {
          contentBuffer += parsed.content
          this.streamChunk(broker, packet.channelId, packet.agentId, parsed.content, false, true)
        }
      }

      // Check if there were any native thoughts or sentinel-derived thoughts
      const finalThoughts = thoughtsBuffer.trim() || rawResponse.thoughts || undefined
      const finalContent = contentBuffer.trim() || rawResponse.content

      return {
        ...rawResponse,
        content: finalContent,
        thoughts: finalThoughts,
      }
    }

    const rawResponse = await adapter.call(modelConfig, {
      systemPrompt: packet.systemPrompt,
      userPrompt: buildUserPrompt(packet, userPromptOverride),
      history: packet.history,
    })

    const parsed = ReActStreamParser.parse(rawResponse.content)

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
    isInternalMonologue: boolean
  ): Promise<number> {
    const db = getDb()

    const lastMessage = await db.query.messages.findFirst({
      where: eq(messages.channelId, channelId),
      orderBy: (table, { desc }) => [desc(table.sequenceNumber)],
    })
    const sequenceNumber = lastMessage ? lastMessage.sequenceNumber + 1 : 1

    const msgId = randomUUID()
    const timestamp = new Date()

    await db.insert(messages).values({
      id: msgId,
      channelId,
      authorId: agentId,
      authorName: agentName,
      authorLevel: String(authorityLevel),
      authorType: 'agent',
      content,
      mentions: [],
      isInternalMonologue,
      sequenceNumber,
      timestamp,
    })

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
    const db = getDb()
    await db.update(agents).set({ status }).where(eq(agents.id, agentId))
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
    broker.emit('message:stream', { channelId, agentId, chunk, isThoughts, streamed }, { channelId })
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

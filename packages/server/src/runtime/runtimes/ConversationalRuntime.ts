import type { ContextPacket, RuntimeResult, RuntimeEvent } from '../types.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import { BaseRuntime } from './BaseRuntime.js'

export class ConversationalRuntime extends BaseRuntime {
  readonly type = 'conversational' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []

    try {
      // Cancellation checkpoint (HM2)
      if (packet.abortSignal?.aborted) {
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: 'Run cancelled by user.',
          runtimeEvents,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: 'cancelled',
        }
      }

      await this.kernel.setAgentStatus(broker, packet.agentId, 'working')
      runtimeEvents.push(this.kernel.buildEvent('agent:status', { agentId: packet.agentId, status: 'working' }))

      this.kernel.emitThinking(broker, packet.agentId, packet.channelId)
      runtimeEvents.push(this.kernel.buildEvent('agent:thinking', { agentId: packet.agentId }))

      const llmResponse = await this.kernel.callLLM(packet, broker)

      if (llmResponse.thoughts) {
        await this.kernel.persistMessage(
          broker,
          packet.channelId,
          packet.agentId,
          packet.agentName,
          packet.authorityLevel,
          llmResponse.thoughts,
          true,
          packet.runId ? { runId: packet.runId } : undefined
        )

        // Auto-write monologue reflection note — off the hot path (HQ3)
        const { hook, brief: cleanBrief } = this.summarizeThoughts(llmResponse.thoughts)
        this.writeReflectionNoteAsync({
          agentId: packet.agentId,
          channelId: packet.channelId,
          importanceScore: 0.6,
          hook,
          brief: cleanBrief,
          observed: `Reasoning cycle for user input: "${packet.userInput.slice(0, 100)}"`,
          interpreted: llmResponse.thoughts.trim(),
          futureRelevance: "Retain self-reflection insights for continuous conversational alignment.",
        })
      }

      await this.kernel.persistMessage(
        broker,
        packet.channelId,
        packet.agentId,
        packet.agentName,
        packet.authorityLevel,
        llmResponse.content,
        false,
        packet.runId ? { runId: packet.runId } : undefined
      )

      runtimeEvents.push(this.kernel.buildEvent('message:new', { channelId: packet.channelId }))

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      runtimeEvents.push(this.kernel.buildEvent('agent:status', { agentId: packet.agentId, status: 'idle' }))

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: llmResponse.content,
        internalMonologue: llmResponse.thoughts,
        runtimeEvents,
        usage: llmResponse.usage,
        status: 'completed',
      }
    } catch (err) {
      console.error(`[ConversationalRuntime] Error:`, err)
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      return await this.buildFailedResult(packet, err, broker)
    }
  }
}

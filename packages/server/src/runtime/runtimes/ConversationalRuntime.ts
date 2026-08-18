import type { ContextPacket, RuntimeResult } from '../types.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import { BaseRuntime } from './BaseRuntime.js'

export class ConversationalRuntime extends BaseRuntime {
  readonly type = 'conversational' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents = []

    try {
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
          true
        )

        // Auto-write monologue reflection note
        try {
          const cleanThoughts = llmResponse.thoughts.trim()
          const sentences = cleanThoughts.split(/[.!?]\s+/)
          const firstSentence = sentences[0] || ""
          const hook = firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence || "Reflected on task execution."
          const brief = sentences.slice(0, 3).join(". ")
          const cleanBrief = brief.length > 150 ? brief.slice(0, 147) + "..." : brief || "Analyzed task details and formulated execution path."

          const { createMemoryNote } = await import("../../Memories/memoriesGate.js")
          await createMemoryNote({
            agentId: packet.agentId,
            channelId: packet.channelId,
            noteType: "reflection",
            importanceScore: 0.6,
            sourceType: "self_reflection",
            hook,
            brief: cleanBrief,
            observed: `Reasoning cycle for user input: "${packet.userInput.slice(0, 100)}"`,
            interpreted: cleanThoughts,
            futureRelevance: "Retain self-reflection insights for continuous conversational alignment.",
          })
        } catch (err) {
          console.error("[ConversationalRuntime] Failed to auto-write monologue reflection note:", err)
        }
      }

      await this.kernel.persistMessage(
        broker,
        packet.channelId,
        packet.agentId,
        packet.agentName,
        packet.authorityLevel,
        llmResponse.content,
        false
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
      return this.buildFailedResult(packet, err)
    }
  }
}

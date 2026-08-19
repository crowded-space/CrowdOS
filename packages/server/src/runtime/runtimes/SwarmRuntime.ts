import type { ContextPacket, RuntimeResult, RuntimeEvent } from '../types.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import { BaseRuntime } from './BaseRuntime.js'

export class SwarmRuntime extends BaseRuntime {
  readonly type = 'swarm' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []

    try {
      await this.kernel.setAgentStatus(broker, packet.agentId, 'working')
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId)

      const orchestrationPrompt = `${packet.systemPrompt}

You are an orchestration coordinator. Analyze the following request and determine:
1. Can you handle this directly? If yes, respond normally.
2. Does this require delegating to specialist agents or spawning workers? If yes, describe the delegation plan.

Respond with your reasoning and answer.`

      packet.systemPrompt = orchestrationPrompt

      const llmResponse = await this.kernel.callLLM(packet, broker)

      if (llmResponse.thoughts) {
        await this.kernel.persistMessage(
          broker, packet.channelId, packet.agentId,
          packet.agentName, packet.authorityLevel,
          llmResponse.thoughts, true
        )
      }

      await this.kernel.persistMessage(
        broker, packet.channelId, packet.agentId,
        packet.agentName, packet.authorityLevel,
        llmResponse.content, false
      )

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: llmResponse.content,
        runtimeEvents,
        usage: llmResponse.usage,
        status: 'completed',
      }
    } catch (err) {
      console.error(`[SwarmRuntime] Error:`, err)
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      return await this.buildFailedResult(packet, err, broker)
    }
  }
}

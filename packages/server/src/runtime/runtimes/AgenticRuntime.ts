import { randomUUID } from 'node:crypto'
import type { ContextPacket, RuntimeResult, RuntimeEvent, ToolCallRecord, HistoryMessage } from '../types.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import { BaseRuntime } from './BaseRuntime.js'
import { toolsGate } from '../../tools/toolsGate.js'

export class AgenticRuntime extends BaseRuntime {
  readonly type = 'agentic' as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []
    const toolCallRecords: ToolCallRecord[] = []

    try {
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

        // Build a temporary request packet with the updated history
        const tempPacket: ContextPacket = {
          ...packet,
          history: localHistory,
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
            llmResponse.thoughts, true
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
              observed: `Reasoning cycle iteration ${iteration} for user input: "${packet.userInput.slice(0, 100)}"`,
              interpreted: cleanThoughts,
              futureRelevance: "Retain task reasoning reflection for continuous contextual alignment.",
            })
          } catch (err) {
            console.error("[AgenticRuntime] Failed to auto-write monologue reflection note:", err)
          }
        }

        // Parse prompt-based tool calls from the raw model response (thoughts or content)
        const parsedToolCalls = this.parseToolCalls(llmResponse.thoughts || '' + '\n' + llmResponse.content)

        if (parsedToolCalls.length === 0 || !packet.policies.allowToolCalls) {
          // No tools to execute or tool execution disabled — this is the final answer!
          finalResponse = llmResponse.content
          break
        }

        // Append assistant's thoughts/reasoning to history to maintain context
        localHistory.push({
          role: 'assistant',
          content: llmResponse.thoughts ? `Thinking: ${llmResponse.thoughts}` : llmResponse.content,
          authorName: packet.agentName,
          timestamp: new Date(),
        })

        // Execute each tool call parsed from the response
        for (const tc of parsedToolCalls) {
          const callId = randomUUID()
          broker.emit('tool:start', { callId, agentId: packet.agentId, channelId: packet.channelId, toolName: tc.name, input: tc.arguments })
          runtimeEvents.push(this.kernel.buildEvent('tool:start', { toolName: tc.name, agentId: packet.agentId }))

          // Auto-thread agentId and channelId into memory tools
          if (tc.name === 'open_memory' || tc.name === 'remember') {
            tc.arguments = tc.arguments || {}
            if (!tc.arguments.agent_id) tc.arguments.agent_id = packet.agentId
            if (!tc.arguments.channel_id) tc.arguments.channel_id = packet.channelId
          }

          console.log(`[AgenticRuntime] Executing tool ${tc.name} for agent ${packet.agentName}...`)
          const startTime = Date.now()
          const result = await toolsGate.execute(packet.agentId, tc.name, tc.arguments, {
            channelId: packet.channelId,
            workspaceId: packet.workspaceId,
          })
          const durationMs = Date.now() - startTime

          broker.emit('tool:complete', {
            callId,
            agentId: packet.agentId,
            channelId: packet.channelId,
            toolName: tc.name,
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
            input: tc.arguments,
            output: result.success ? result.output : result.error || 'Unknown tool error',
            success: result.success,
            durationMs,
          })

          const outcomeStr = result.success ? result.output : `Error: ${result.error}`

          // Persist the tool result as an internal log message in the database so it's audit-logged
          await this.kernel.persistMessage(
            broker, packet.channelId, packet.agentId,
            packet.agentName, packet.authorityLevel,
            `🛠️ [Tool Result: ${tc.name}]\n${outcomeStr}`,
            true
          )

          // Feed the tool result back into the prompt history for the next iteration
          localHistory.push({
            role: 'user',
            content: `[Tool Result for ${tc.name}]:\n${outcomeStr}`,
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
        responseToPersist, false
      )

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: responseToPersist,
        runtimeEvents,
        toolCalls: toolCallRecords,
        usage: totalUsage,
        status: 'completed',
      }
    } catch (err) {
      console.error(`[AgenticRuntime] Error:`, err)
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle')
      return await this.buildFailedResult(packet, err, broker)
    }
  }

  protected parseToolCalls(raw: string): Array<{ name: string; arguments: Record<string, unknown> }> {
    const results: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const tagRegex = /<call_tool\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/call_tool>/gi
    let match: RegExpExecArray | null

    while ((match = tagRegex.exec(raw)) !== null) {
      const name = match[1]!
      const body = match[2]?.trim() ?? '{}'
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        results.push({ name, arguments: parsed })
      } catch {
        results.push({ name, arguments: { raw: body } })
      }
    }

    return results
  }
}

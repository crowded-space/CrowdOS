import type { ContextPacket, RuntimeResult, LLMRequest, ModelModuleConfig } from '../types.js';
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js';
import { BaseRuntime } from './BaseRuntime.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { AgentSession, type PiModelAdapter, type PiMessage, type PiToolSchema } from '@crowdos/pi-core';
import { PiToolBridge } from '../bridges/PiToolBridge.js';
import { PiEventBridge } from '../bridges/PiEventBridge.js';

export class CodingRuntime extends BaseRuntime {
  readonly type = 'coding' as const;

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    try {
      await this.kernel.setAgentStatus(broker, packet.agentId, 'working');
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId);

      const modelConfig: ModelModuleConfig = (packet as any)._modelConfig || {
        provider: 'google',
        modelName: 'gemini-2.0-flash',
        temperature: 0.2,
        maxOutputTokens: 4096,
      };

      const adapter = ProviderRegistry.get(modelConfig.provider);

      // Construct dynamic PiModelAdapter that invokes the registered ProviderAdapter
      const piAdapter: PiModelAdapter = async (config, messages, tools, onChunk) => {
        const history: Array<{ role: 'user' | 'assistant'; content: string; authorName?: string; timestamp: Date }> = [];
        let systemPrompt = '';
        let userPrompt = '';

        for (const msg of messages) {
          if (msg.role === 'system') {
            systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
          } else if (msg.role === 'user') {
            if (userPrompt) {
              history.push({ role: 'user', content: userPrompt, timestamp: new Date() });
            }
            userPrompt = msg.content;
          } else if (msg.role === 'assistant') {
            history.push({ role: 'assistant', content: msg.content, timestamp: new Date() });
          } else if (msg.role === 'tool') {
            history.push({
              role: 'user',
              content: `[Tool Result: ${msg.name || 'tool'}]:\n${msg.content}`,
              timestamp: new Date(),
            });
          }
        }

        const llmRequest: LLMRequest = {
          systemPrompt: systemPrompt || packet.systemPrompt,
          userPrompt: userPrompt || packet.userInput,
          history,
          temperature: config.temperature ?? modelConfig.temperature ?? 0.2,
          maxTokens: config.maxOutputTokens ?? modelConfig.maxOutputTokens ?? 4096,
          tools: tools.map((t: PiToolSchema) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters as any,
          })),
        };

        const response = await adapter.call(
          {
            ...modelConfig,
            ...config,
          },
          llmRequest,
          (chunk) => {
            if (onChunk) {
              onChunk({
                content: chunk.content,
                thoughts: chunk.thoughts,
                isThoughts: chunk.isThoughts,
              });
            }
          }
        );

        // Parse XML / sentinel tool calls from response text if present
        const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
        const regex = /<call_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/call_tool>/g;
        let match;

        const textToParse = (response.thoughts || '') + '\n' + (response.content || '');
        while ((match = regex.exec(textToParse)) !== null) {
          const name = match[1].trim();
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(match[2].trim());
          } catch {
            try {
              args = JSON.parse(match[2].replace(/```json|```/g, '').trim());
            } catch {
              // ignore JSON parse error
            }
          }
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            arguments: args,
          });
        }

        return {
          content: response.content,
          thoughts: response.thoughts,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: response.usage,
          finishReason: response.finishReason,
        };
      };

      // Create coding tools and custom agent tools
      const codingTools = PiToolBridge.createCodingTools({
        agentId: packet.agentId,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        authorityLevel: packet.authorityLevel,
        broker,
      });

      const customTools = await PiToolBridge.createAgentCustomTools({
        agentId: packet.agentId,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        authorityLevel: packet.authorityLevel,
        broker,
      });

      const allTools = [...codingTools, ...customTools];

      // Convert packet history to PiMessage[]
      const initialHistory: PiMessage[] = (packet.history || []).map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
        name: h.authorName,
      }));

      // Initialize Pi AgentSession
      const session = new AgentSession({
        sessionId: `session_${packet.agentId}_${packet.channelId}`,
        modelConfig: {
          provider: modelConfig.provider as any,
          modelName: modelConfig.modelName || 'gemini-2.0-flash',
          temperature: modelConfig.temperature ?? 0.2,
          maxOutputTokens: modelConfig.maxOutputTokens ?? 4096,
        },
        modelAdapter: piAdapter,
        systemPrompt: packet.systemPrompt,
        tools: allTools,
        initialHistory,
      });

      // Prompt session and stream events to broker
      const stream = session.prompt(packet.userInput);

      const bridge = PiEventBridge.pipeToBroker(stream, {
        agentId: packet.agentId,
        agentName: packet.agentName,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        broker,
      });

      const { finalContent, finalThoughts } = await bridge.waitForCompletion();

      // Persist thoughts if present
      if (finalThoughts) {
        await this.kernel.persistMessage(
          broker,
          packet.channelId,
          packet.agentId,
          packet.agentName,
          packet.authorityLevel,
          finalThoughts,
          true
        );

        // Auto-write monologue reflection memory note
        try {
          const cleanThoughts = finalThoughts.trim();
          const sentences = cleanThoughts.split(/[.!?]\s+/);
          const firstSentence = sentences[0] || '';
          const hook = firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence || 'Reflected on coding task.';
          const brief = sentences.slice(0, 3).join('. ');
          const cleanBrief = brief.length > 150 ? brief.slice(0, 147) + '...' : brief || 'Executed precision code edits and verified tests.';

          const { createMemoryNote } = await import('../../Memories/memoriesGate.js');
          await createMemoryNote({
            agentId: packet.agentId,
            channelId: packet.channelId,
            noteType: 'reflection',
            importanceScore: 0.7,
            sourceType: 'self_reflection',
            hook,
            brief: cleanBrief,
            observed: `Coding execution completed for task: "${packet.userInput.slice(0, 100)}"`,
            interpreted: cleanThoughts,
            futureRelevance: 'Retain code modifications and architecture context for future implementation sessions.',
          });
        } catch (err) {
          console.error('[CodingRuntime] Failed to auto-write memory note:', err);
        }
      }

      // Persist final user-facing response message in DB
      await this.kernel.persistMessage(
        broker,
        packet.channelId,
        packet.agentId,
        packet.agentName,
        packet.authorityLevel,
        finalContent,
        false
      );

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle');

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: finalContent,
        toolCalls: bridge.toolCallRecords,
        runtimeEvents: bridge.runtimeEvents,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'completed',
      };
    } catch (err) {
      console.error('[CodingRuntime] Execution Error:', err);
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle');
      return this.buildFailedResult(packet, err);
    }
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationalRuntime } from './conversational-runtime.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { EventBroker } from '../../event-broker/event-broker-gate.js';
import { getDb } from '../../shared/config/database.js';
import { getChannelMessages } from '../../messages/message-gate.js';
import type { ContextPacket, IProviderAdapter, LLMRequest, LLMResponse } from '../types.js';

describe('E2E Agent Output & Internal Monologue Integration', () => {
  let broker: EventBroker;
  let runtime: ConversationalRuntime;

  beforeEach(() => {
    broker = new EventBroker();
    runtime = new ConversationalRuntime();
  });

  it('correctly isolates internal monologue reasoning from final output in streaming, persistence, and message fetching', async () => {
    const db = getDb();
    const existingChannel = await db.query.channels.findFirst();
    const existingAgent = await db.query.agents.findFirst();

    if (!existingChannel || !existingAgent) {
      console.warn('Skipping MonologueE2E test: no seeded channel or agent.');
      return;
    }

    const mockProvider: IProviderAdapter = {
      provider: 'mock-e2e-monologue-provider',
      supportsStreaming: true,
      supportsTools: true,
      async call(_config, _req: LLMRequest, onChunk): Promise<LLMResponse> {
        // 1. Emit thoughts
        onChunk?.({ isThoughts: true, content: 'Analyzing user request step by step.' });
        onChunk?.({ isThoughts: true, content: ' Strategy formulated.' });
        
        // 2. Emit final answer
        onChunk?.({ isThoughts: false, content: 'Hello! Here is the final output answer.' });

        return {
          content: 'Hello! Here is the final output answer.',
          thoughts: 'Analyzing user request step by step. Strategy formulated.',
          usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40 },
          finishReason: 'stop',
        };
      },
    };

    ProviderRegistry.register(mockProvider);

    const streamedChunks: Array<{ isThoughts?: boolean; chunk: string }> = [];
    broker.on('message:stream', undefined, (event: any) => {
      streamedChunks.push({ isThoughts: event.payload.isThoughts, chunk: event.payload.chunk });
    });

    const packet: ContextPacket = {
      requestId: `e2e_req_${Date.now()}`,
      agentId: existingAgent.id,
      agentName: existingAgent.name,
      channelId: existingChannel.id,
      workspaceId: (existingChannel as any).workspaceId || 'default',
      authorityLevel: existingAgent.authorityLevel ?? 3,
      userInput: 'Please analyze this requirement',
      systemPrompt: 'You are a test agent.',
      history: [],
      policies: {
        streamOutput: true,
        allowToolExecution: true,
      },
      metadata: {
        provider: 'mock-e2e-monologue-provider',
        model: 'test-model',
      },
      _modelConfig: {
        provider: 'mock-e2e-monologue-provider',
        modelName: 'test-model',
      },
    } as any;

    const result = await runtime.execute(packet, broker);

    expect(result.status).toBe('completed');
    expect(result.finalResponse).toBe('Hello! Here is the final output answer.');
    expect(result.internalMonologue).toBe('Analyzing user request step by step. Strategy formulated.');

    // Verify stream events emitted thoughts and content separately
    const thoughtChunks = streamedChunks.filter(s => s.isThoughts === true);
    const contentChunks = streamedChunks.filter(s => !s.isThoughts);
    expect(thoughtChunks.length).toBeGreaterThan(0);
    expect(contentChunks.length).toBeGreaterThan(0);

    // Verify channel message retrieval merges monologue into the final card metadata
    const channelMessages = await getChannelMessages(existingChannel.id, true);
    const lastAgentMsg = channelMessages.filter(m => m.authorId === existingAgent.id).pop();
    
    expect(lastAgentMsg).toBeDefined();
    expect(lastAgentMsg?.content).toBe('Hello! Here is the final output answer.');
    expect(lastAgentMsg?.metadata?.monologue).toBe('Analyzing user request step by step. Strategy formulated.');
  });
});

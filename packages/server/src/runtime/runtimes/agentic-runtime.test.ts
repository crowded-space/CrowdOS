import { describe, it, expect, beforeEach } from 'vitest';
import { AgenticRuntime } from './agentic-runtime.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { EventBroker } from '../../event-broker/event-broker-gate.js';
import { toolRegistry, type ToolDefinition } from '../../tools/tools-gate.js';
import { AGENT_COMPLETE } from '../agent-control-tools.js';
import type { ContextPacket, IProviderAdapter, LLMRequest, LLMResponse } from '../types.js';

describe('AgenticRuntime Native Tool Calling & Lifecycle', () => {
  let broker: EventBroker;
  let runtime: AgenticRuntime;

  beforeEach(() => {
    broker = new EventBroker();
    runtime = new AgenticRuntime();
  });

  it('should execute native tool calls and complete cleanly on agent_complete', async () => {
    const { getDb } = await import('../../shared/config/database.js');
    const db = getDb();
    const existingChannel = await db.query.channels.findFirst();
    const existingAgent = await db.query.agents.findFirst();

    if (!existingChannel || !existingAgent) {
      console.warn('Skipping AgenticRuntime test: no seeded channel or agent in local DB.');
      return;
    }

    const { skillsGate } = await import('../../skills/skills-gate.js');
    const allowedTools = await skillsGate.getResolvedToolsForAgent(existingAgent.id);
    const targetToolName = allowedTools.length > 0 ? allowedTools[0] : 'mock_weather_tool';

    let originalTool: ToolDefinition | undefined;
    if (allowedTools.length > 0) {
      originalTool = toolRegistry.get(targetToolName);
    }

    // Register/mock the target tool handler
    const mockTool: ToolDefinition = {
      id: targetToolName,
      name: targetToolName,
      displayName: 'Mock Tool',
      description: 'Test Tool',
      category: 'testing',
      sourceType: 'dynamic',
      dangerLevel: 'safe',
      authLevelRequired: 3,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: [],
      },
      handler: async (args) => {
        executedToolArgs.push(args);
        return { success: true, output: `Result of tool execution` };
      },
    };
    toolRegistry.register(mockTool);

    let callCount = 0;
    const executedToolArgs: any[] = [];

    const mockProvider: IProviderAdapter = {
      provider: 'agentic-native-test-provider',
      supportsStreaming: false,
      supportsTools: true,
      async call(_config, req: LLMRequest): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Executing tool...',
            toolCalls: [
              {
                id: 'call_test_1',
                name: targetToolName,
                input: { query: 'test-query' },
              },
            ],
            finishReason: 'tool_use',
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          };
        }

        // Second turn: model inspects result and issues agent_complete
        expect(req.history?.some((m) => m.role === 'tool' && m.toolCallId === 'call_test_1')).toBe(true);

        return {
          content: '',
          toolCalls: [
            {
              id: 'call_complete_1',
              name: AGENT_COMPLETE,
              input: { response: 'The task is successfully completed.' },
            },
          ],
          finishReason: 'tool_use',
          usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      },
    };

    ProviderRegistry.register(mockProvider);

    const mockPacket: ContextPacket & { _modelConfig: any } = {
      requestId: 'req-agentic-01',
      agentId: existingAgent.id,
      agentName: existingAgent.name,
      authorityLevel: existingAgent.authorityLevel ?? 3,
      channelId: existingChannel.id,
      workspaceId: (existingAgent as any).workspaceId || 'ws-01',
      systemPrompt: 'You are an agentic assistant.',
      userInput: 'Run test task',
      history: [],
      policies: {
        maxTokenBudget: 4000,
        maxIterations: 5,
        allowToolCalls: true,
        allowSpawn: false,
        allowDelegation: false,
        loopDetection: true,
        streamOutput: false,
      },
      metadata: {
        runtimeType: 'agentic',
        provider: 'agentic-native-test-provider',
        modelName: 'test-model',
        modelModuleId: 'mod-01',
        startedAt: new Date(),
      },
      _modelConfig: {
        provider: 'agentic-native-test-provider',
        modelName: 'test-model',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    };

    const result = await runtime.execute(mockPacket, broker);

    expect(result.status).toBe('completed');
    expect(callCount).toBe(2);
    expect(executedToolArgs.length).toBe(1);
    expect(executedToolArgs[0]).toMatchObject({ query: 'test-query' });
    expect(result.finalResponse).toBe('The task is successfully completed.');
    expect(result.toolCalls?.length).toBe(1);
    expect(result.toolCalls?.[0].toolName).toBe(targetToolName);

    if (originalTool) {
      toolRegistry.register(originalTool);
    } else {
      toolRegistry.unregister(targetToolName);
    }
  });
});

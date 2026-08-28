import { describe, it, expect } from 'vitest';
import { runAgentLoop } from './agent-loop.js';
import type { AgentTool } from './types.js';
import type { PiModelConfig, PiModelAdapter, PiLLMResponse } from '../ai/types.js';

describe('Pi-Core Agent Loop', () => {
  it('should execute single turn with thoughts and final content', async () => {
    const mockAdapter: PiModelAdapter = async (_config, _messages, _tools, onChunk) => {
      onChunk?.({ isThoughts: true, content: 'Planning response...' });
      onChunk?.({ isThoughts: false, content: 'Hello World!' });
      return {
        content: 'Hello World!',
        thoughts: 'Planning response...',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    };

    const stream = runAgentLoop({
      modelConfig: { provider: 'google', modelName: 'test-model' },
      modelAdapter: mockAdapter,
      systemPrompt: 'You are a test assistant.',
      history: [],
      userInput: 'Hi',
      tools: [],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'agent_start')).toBe(true);
    expect(events.some((e) => e.type === 'thought_delta')).toBe(true);
    expect(events.some((e) => e.type === 'message_delta')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);

    const endEvent = events.find((e) => e.type === 'agent_end');
    expect(endEvent?.content).toBe('Hello World!');
    expect(endEvent?.thoughts).toBe('Planning response...');
  });

  it('should iteratively invoke tools and continue turn', async () => {
    let callCount = 0;

    const mockAdapter: PiModelAdapter = async (_config, messages) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: 'I need to check the weather.',
          thoughts: 'Calling weather tool',
          toolCalls: [
            {
              id: 'call_01',
              name: 'get_weather',
              arguments: { city: 'Tokyo' },
            },
          ],
        };
      }
      // Second call after tool execution
      const toolTurn = messages.find((m) => m.role === 'tool');
      return {
        content: `Weather report: ${toolTurn?.content}`,
        thoughts: 'Done',
      };
    };

    const weatherTool: AgentTool = {
      name: 'get_weather',
      description: 'Gets current weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: async (args) => {
        return { success: true, output: `Sunny in ${args.city}, 22°C` };
      },
    };

    const stream = runAgentLoop({
      modelConfig: { provider: 'google', modelName: 'test-model' },
      modelAdapter: mockAdapter,
      systemPrompt: 'Weather bot',
      history: [],
      userInput: 'How is Tokyo?',
      tools: [weatherTool],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_end')).toBe(true);

    const endEvent = events.find((e) => e.type === 'agent_end');
    expect(endEvent?.content).toContain('Sunny in Tokyo, 22°C');
  });
});

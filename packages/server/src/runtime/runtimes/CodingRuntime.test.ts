import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CodingRuntime } from './CodingRuntime.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { EventBroker } from '../../EventBroker/eventBrokerGate.js';
import { getDb } from '../../Shared/config/database.js';
import type { ContextPacket, IProviderAdapter, LLMRequest, LLMResponse } from '../types.js';

describe('CodingRuntime with Pi-Core Integration', () => {
  let tempDir: string;
  let broker: EventBroker;
  let runtime: CodingRuntime;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-runtime-test-'));
    broker = new EventBroker();
    runtime = new CodingRuntime();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it('should execute coding tasks, parse tool calls, and invoke guarded file tools', async () => {
    const db = getDb();
    const existingChannel = await db.query.channels.findFirst();
    const existingAgent = await db.query.agents.findFirst();

    if (!existingChannel || !existingAgent) {
      console.warn('Skipping CodingRuntime DB integration test: no seeded channel or agent.');
      return;
    }

    const testFile = path.join(tempDir, 'index.ts');
    await fs.writeFile(testFile, 'export const greeting = "hi";', 'utf8');

    let callCount = 0;

    // Register a mock provider adapter
    const mockProvider: IProviderAdapter = {
      provider: 'custom-coding-test',
      supportsStreaming: true,
      supportsTools: true,
      async call(_config, _req: LLMRequest, onChunk): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          const thoughtsWithTool = `Planning to inspect file.\n<call_tool name="read_file">{"path": "${testFile.replace(/\\/g, '/')}"}</call_tool>`;
          onChunk?.({ isThoughts: true, content: thoughtsWithTool });
          return {
            content: 'Let me read the code.',
            thoughts: thoughtsWithTool,
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: 'tool_use',
          };
        }

        onChunk?.({ isThoughts: false, content: 'File has been inspected and verified.' });
        return {
          content: 'File has been inspected and verified.',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        };
      },
    };

    ProviderRegistry.register(mockProvider);

    const mockPacket: ContextPacket & { _modelConfig: any } = {
      requestId: 'req-001',
      agentId: existingAgent.id,
      agentName: existingAgent.name,
      authorityLevel: existingAgent.authorityLevel ?? 3,
      channelId: existingChannel.id,
      workspaceId: (existingAgent as any).workspaceId || 'ws-default',
      systemPrompt: 'You are an autonomous senior coding agent.',
      userInput: `Please inspect the code in ${testFile}`,
      history: [],
      policies: {
        maxTokenBudget: 4000,
        maxIterations: 5,
        allowToolCalls: true,
        allowSpawn: false,
        allowDelegation: false,
        loopDetection: true,
        streamOutput: true,
      },
      metadata: {
        runtimeType: 'coding',
        provider: 'custom-coding-test',
        modelName: 'test-code-model',
        modelModuleId: 'mod-01',
        startedAt: new Date(),
      },
      _modelConfig: {
        provider: 'custom-coding-test',
        modelName: 'test-code-model',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    };

    const result = await runtime.execute(mockPacket, broker);

    expect(result).toBeDefined();
    expect(result.status).toBe('completed');
    expect(callCount).toBe(2);
    expect(result.toolCalls?.length).toBeGreaterThanOrEqual(1);
    expect(result.finalResponse).toBe('File has been inspected and verified.');
  });
});

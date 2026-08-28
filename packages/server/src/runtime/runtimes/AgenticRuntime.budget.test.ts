import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AgenticRuntime } from './AgenticRuntime.js';

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { EventBroker } from '../../EventBroker/eventBrokerGate.js';
import { toolRegistry, type ToolDefinition } from '../../tools/toolsGate.js';
import { AGENT_COMPLETE } from '../agentControlTools.js';
import type { ContextPacket, IProviderAdapter, LLMRequest, LLMResponse, RuntimeResult } from '../types.js';

/**
 * PERF-3 acceptance: a 10-iteration agentic run with a verbose mock provider
 * (long content + one tool call every iteration) must keep EVERY assembled
 * LLM prompt within the assembler's cap +15%, inject the memory preview on
 * iteration 1 only, and stay strictly cheaper than the legacy (rollback-flag)
 * behavior where appends grow past the cap.
 */

const PROVIDER = 'budget-acceptance-provider'
const CAP_TOKENS = 2000
const VERBOSE_CHARS = 4000
const ITERATIONS = 10
const PREVIEW_MARKER = '[MEMORY PREVIEW]'

function estimatePromptTokens(req: LLMRequest): number {
  const toolsChars = req.tools ? JSON.stringify(req.tools).length : 0
  const historyChars = (req.history ?? []).reduce((s, h) => s + h.content.length, 0)
  return Math.ceil((req.systemPrompt.length + req.userPrompt.length + historyChars + toolsChars) / 4)
}

interface Harness {
  reqs: LLMRequest[]
  run(): Promise<RuntimeResult>
}

async function buildHarness(): Promise<Harness> {
  const dbModule = await import('../../Shared/config/database.js')
  const testDb = (dbModule as unknown as {
    __socketTestDb: {
      store: Record<'channels' | 'agents' | 'messages', Array<Record<string, unknown>>>;
      reset(): void;
    };
  }).__socketTestDb
  const store = testDb.store

  testDb.reset()
  store.channels.push({ id: 'chan-budget', name: 'budget', workspaceId: 'ws-budget' })
  store.agents.push({
    id: 'agent-budget',
    name: 'Budgeteer',
    authorityLevel: 3,
    status: 'idle',
    memorySharingPolicy: 'full',
  })

  const probeTool: ToolDefinition = {
    id: 'remember',
    name: 'remember',
    displayName: 'Remember (probe)',
    description: 'Test stand-in for the universal memory tool',
    category: 'testing',
    sourceType: 'dynamic',
    dangerLevel: 'safe',
    authLevelRequired: 3,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'note text' } },
      required: ['text'],
    },
    handler: async () => ({ success: true, output: 'stored' }),
  }
  toolRegistry.register(probeTool)

  const reqs: LLMRequest[] = []
  let callCount = 0
  const provider: IProviderAdapter = {
    provider: PROVIDER,
    supportsStreaming: false,
    supportsTools: true,
    async call(_config, req: LLMRequest): Promise<LLMResponse> {
      reqs.push(req)
      callCount++
      if (callCount >= ITERATIONS) {
        return {
          content: '',
          toolCalls: [{ id: `call-final`, name: AGENT_COMPLETE, input: { response: 'All iterations done.' } }],
          finishReason: 'tool_use',
          usage: { promptTokens: estimatePromptTokens(req), completionTokens: 5, totalTokens: estimatePromptTokens(req) + 5 },
        }
      }
      return {
        content: `Iteration ${callCount} analysis. ${'v'.repeat(VERBOSE_CHARS)}`,
        toolCalls: [{ id: `call-${callCount}`, name: 'remember', input: { text: `note ${callCount}` } }],
        finishReason: 'tool_use',
        usage: { promptTokens: estimatePromptTokens(req), completionTokens: 1000, totalTokens: estimatePromptTokens(req) + 1000 },
      }
    },
  }
  ProviderRegistry.register(provider)

  const packet: ContextPacket & { _modelConfig: Record<string, unknown> } = {
    requestId: 'req-perf3',
    agentId: 'agent-budget',
    agentName: 'Budgeteer',
    authorityLevel: 3,
    channelId: 'chan-budget',
    workspaceId: 'ws-budget',
    systemPrompt: 'You are Budgeteer, an agentic worker. ',
    userInput: 'Work through the long task step by step.',
    memoryPreviewBlock: `${PREVIEW_MARKER}\n- hook-alpha\n- hook-beta`,
    history: [],
    tools: [
      {
        name: 'remember',
        description: 'Store a memory note for later retrieval',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'note text' } },
          required: ['text'],
        },
      },
    ],
    policies: {
      maxTokenBudget: CAP_TOKENS,
      maxIterations: ITERATIONS,
      allowToolCalls: true,
      allowSpawn: false,
      allowDelegation: false,
      loopDetection: true,
      streamOutput: false,
    },
    metadata: {
      runtimeType: 'agentic',
      provider: PROVIDER,
      modelName: 'test-model',
      modelModuleId: 'mod-budget',
      startedAt: new Date(),
    },
    _modelConfig: {
      provider: PROVIDER,
      modelName: 'test-model',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  }

  const runtime = new AgenticRuntime()
  return {
    reqs,
    run: () => runtime.execute(packet, new EventBroker()),
  }
}

describe('PERF-3 per-iteration context budget (AgenticRuntime)', () => {
  let harness: Harness
  let originalRemember: ToolDefinition | undefined

  beforeAll(async () => {
    delete process.env.PER_ITERATION_BUDGET
    originalRemember = toolRegistry.get('remember')
    harness = await buildHarness()
  })

  afterAll(() => {
    delete process.env.PER_ITERATION_BUDGET
    if (originalRemember) toolRegistry.register(originalRemember)
    else toolRegistry.unregister('remember')
  })

  it('keeps every one of 10 iteration prompts within cap+15% and injects the preview once', async () => {
    const result = await harness.run()

    expect(result.status).toBe('completed')
    expect(result.finalResponse).toBe('All iterations done.')
    expect(harness.reqs.length).toBe(ITERATIONS)

    const perCall = harness.reqs.map(estimatePromptTokens)
    const total = perCall.reduce((s, t) => s + t, 0)
    console.log(`[PERF-3] cap=${CAP_TOKENS}tok per-call=${perCall.join(',')} total=${total} (bound ${CAP_TOKENS}x1.15 per call)`)

    for (const tokens of perCall) {
      expect(tokens).toBeLessThanOrEqual(CAP_TOKENS * 1.15)
    }
    expect(total).toBeLessThan(CAP_TOKENS * ITERATIONS * 1.15)

    expect(harness.reqs[0].userPrompt.startsWith(PREVIEW_MARKER)).toBe(true)
    for (let i = 1; i < harness.reqs.length; i++) {
      expect(harness.reqs[i].userPrompt.includes(PREVIEW_MARKER)).toBe(false)
    }

    expect(harness.reqs[9].history?.length ?? 0).toBeLessThan((ITERATIONS - 1) * 2)
    expect(harness.reqs.at(-1)?.history?.some((m) => m.isSelf)).toBe(true)
    expect(harness.reqs.every((r) => (r.history ?? []).every((m) => m.role !== 'assistant' || m.isSelf === true))).toBe(true)
  });

  it('legacy mode (PER_ITERATION_BUDGET=false) re-sends the preview and overflows the cap', async () => {
    process.env.PER_ITERATION_BUDGET = 'false'
    try {
      const legacy = await buildHarness()
      const result = await legacy.run()
      expect(result.status).toBe('completed')

      const perCall = legacy.reqs.map(estimatePromptTokens)
      const total = perCall.reduce((s, t) => s + t, 0)
      console.log(`[PERF-3][legacy] cap=${CAP_TOKENS}tok per-call=${perCall.join(',')} total=${total}`)

      expect(legacy.reqs.every((r) => r.userPrompt.includes(PREVIEW_MARKER))).toBe(true)
      expect(Math.max(...perCall)).toBeGreaterThan(CAP_TOKENS)
      const enforcedTotal = harness.reqs.map(estimatePromptTokens).reduce((s, t) => s + t, 0)
      expect(total).toBeGreaterThan(enforcedTotal)
    } finally {
      delete process.env.PER_ITERATION_BUDGET
    }
  });
});

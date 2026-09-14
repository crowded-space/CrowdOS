import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { swarmGate } from './swarm-gate.js';
import { ProviderRegistry } from '../runtime/providers/provider-registry.js';
import { EventBroker } from '../event-broker/event-broker-gate.js';
import type { ContextPacket, IProviderAdapter } from '../runtime/types.js';

describe('Swarm SW-1 e2e', () => {
  let broker: EventBroker;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    broker = new EventBroker();
    swarmGate.resetForTests();
    process.env.SWARM_V1 = 'true';
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/community_agent';
  });

  afterEach(() => {
    process.env.SWARM_V1 = originalEnv.SWARM_V1;
    vi.restoreAllMocks();
  });

  it('linear chain plan→2 workers→aggregate→verify→result green (hermetic)', async () => {
    // Mock provider that returns structured plan, worker outputs, verifier pass
    let callCount = 0;
    const mockProvider: IProviderAdapter = {
      provider: 'swarm-e2e-test',
      supportsStreaming: false,
      supportsTools: false,
      async call(_config, req) {
        callCount++;
        const combined = `${req.systemPrompt} ${req.userPrompt}`;
        if (combined.includes('swarm worker (task task-1)')) {
          return {
            content: 'Worker 1 output: key findings A',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            finishReason: 'stop',
          };
        }
        if (combined.includes('task-2') && combined.includes('swarm worker')) {
          return {
            content: 'Worker 2 output: synthesis B combining A',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            finishReason: 'stop',
          };
        }
        if (combined.includes('independent swarm verifier')) {
          return {
            content: JSON.stringify({ verdict: 'pass', reason: 'Artifact honestly covers goal with 2/2 tasks', confidence: 0.9 }),
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            finishReason: 'stop',
          };
        }
        if (combined.includes('swarm supervisor')) {
          return {
            content: JSON.stringify({
              tasks: [
                { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-e2e', goal: 'Research subtask 1' },
                { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-e2e', goal: 'Synthesize subtask 2' },
              ],
            }),
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: 'stop',
          };
        }
        return {
          content: JSON.stringify({ verdict: 'pass', reason: 'default pass' }),
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          finishReason: 'stop',
        };
      },
    };
    ProviderRegistry.register(mockProvider);

    const packet = {
      requestId: 'req-swarm-e2e-1',
      agentId: 'agent-e2e',
      agentName: 'E2EAgent',
      authorityLevel: 2,
      channelId: 'ch-e2e',
      workspaceId: 'ws-e2e',
      userInput: 'Research and synthesize X',
      systemPrompt: 'You are swarm supervisor',
      history: [],
      policies: {
        maxTokenBudget: 4000,
        maxIterations: 5,
        allowToolCalls: true,
        allowSpawn: true,
        allowDelegation: true,
        loopDetection: true,
        streamOutput: false,
      },
      metadata: {
        runtimeType: 'swarm' as const,
        provider: 'swarm-e2e-test',
        modelName: 'test-model',
        modelModuleId: 'mod-e2e',
        startedAt: new Date(),
      },
      _modelConfig: {
        provider: 'swarm-e2e-test',
        modelName: 'test-model',
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
      runId: 'run-e2e-linear-1',
    } as unknown as ContextPacket & { _modelConfig: unknown };

    // 1. Plan
    const { RuntimeKernel } = await import('../runtime/kernel/runtime-kernel.js');
    const kernel = new RuntimeKernel();
    const planResult = await swarmGate.plan(packet, kernel as any, broker);
    expect(planResult.plan.tasks).toHaveLength(2);
    expect(planResult.fallbackUsed).toBe(false);
    expect(planResult.plan.tasks[1].dependsOn).toContain('task-1');

    // Persist
    await swarmGate.createTasks(packet.runId!, planResult.plan.tasks);

    // 2. Dispatch with worker executor backed by kernel (mirrors SwarmRuntime)
    const workerExecutor = async (task: { id: string; goal?: string; description?: string }) => {
      const subtaskPacket = {
        ...packet,
        requestId: `${packet.requestId}:${task.id}`,
        userInput: task.goal ?? task.description ?? `Complete ${task.id}`,
        systemPrompt: `${packet.systemPrompt}\n\nYou are a swarm worker (task ${task.id}). Complete ONLY this subtask concisely and return the result.`,
      } as unknown as ContextPacket;
      const res = await kernel.callLLM(subtaskPacket as any, broker as any);
      return (res.content ?? '').trim();
    };
    const dispatchResults = await swarmGate.dispatch({
      plan: planResult.plan,
      runId: packet.runId!,
      packet,
      broker,
      workerExecutor: workerExecutor as any,
    });
    expect(dispatchResults.size).toBe(2);
    expect(dispatchResults.get('task-1')?.status).toBe('completed');
    expect(dispatchResults.get('task-2')?.status).toBe('completed');
    expect(dispatchResults.get('task-1')?.output).toContain('key findings A');
    expect(dispatchResults.get('task-2')?.output).toContain('synthesis B');

    // 3. Aggregate
    const tasks = await swarmGate.listByRun(packet.runId!);
    const aggregation = swarmGate.aggregate(tasks, dispatchResults);
    expect(aggregation.completedCount).toBe(2);
    expect(aggregation.totalCount).toBe(2);
    expect(aggregation.honestSummary).toMatch(/Completed 2\/2/);
    expect(aggregation.mergedContent).toContain('key findings A');
    expect(aggregation.mergedContent).toContain('synthesis B');
    expect(aggregation.failedTasks).toHaveLength(0);

    // 4. Verify
    const verification = await swarmGate.verify({
      goal: packet.userInput,
      aggregatedContent: aggregation.mergedContent,
      packet,
      broker,
      kernel: kernel as any,
      aggregationSummary: { completedCount: aggregation.completedCount, totalCount: aggregation.totalCount, failedTasks: aggregation.failedTasks },
    });
    expect(verification.verdict).toBe('pass');

    // 5. Full SwarmRuntime e2e via runtime execute (uses same provider)
    const { SwarmRuntime } = await import('../runtime/runtimes/swarm-runtime.js');
    const runtime = new SwarmRuntime();
    const result = await runtime.execute(packet, broker);
    expect(result.status).toBe('completed');
    expect(result.finalResponse).toContain('Completed 2/2');
    expect(result.finalResponse.toLowerCase()).toContain('swarm');
    // Artifact path not required to assert DB, but ensure no mocked strings
    expect(result.finalResponse).not.toContain('Task Output for');
    expect(result.finalResponse).not.toContain('runTask');
  });

  it('worker-kill mid-swarm → partial aggregation reported truthfully (no fabricated success)', async () => {
    const packet = {
      requestId: 'req-swarm-kill-1',
      agentId: 'agent-kill',
      agentName: 'KillAgent',
      authorityLevel: 2,
      channelId: 'ch-kill',
      workspaceId: 'ws-kill',
      userInput: 'Do two part task, second worker will be killed',
      systemPrompt: 'You are swarm supervisor',
      history: [],
      policies: {
        maxTokenBudget: 4000,
        maxIterations: 5,
        allowToolCalls: true,
        allowSpawn: true,
        allowDelegation: true,
        loopDetection: true,
        streamOutput: false,
      },
      metadata: {
        runtimeType: 'swarm' as const,
        provider: 'swarm-kill-test',
        modelName: 'test-model',
        modelModuleId: 'mod-kill',
        startedAt: new Date(),
      },
      _modelConfig: { provider: 'swarm-kill-test', modelName: 'test-model' },
      runId: 'run-kill-1',
    } as unknown as ContextPacket & { _modelConfig: unknown };

    const plan = {
      tasks: [
        { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-kill', goal: 'Step 1' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-kill', goal: 'Step 2 (will kill)' },
      ],
      fallbackUsed: false,
    };

    await swarmGate.createTasks(packet.runId!, plan.tasks);

    // Custom executor: task-1 succeeds, task-2 throws (worker-kill)
    const executor = async (task: { id: string }) => {
      if (task.id === 'task-1') return 'Output of task-1: success';
      throw new Error('worker killed: SIGKILL mid-execution');
    };

    const results = await swarmGate.dispatch({
      plan,
      runId: packet.runId!,
      packet: packet as ContextPacket,
      broker,
      workerExecutor: executor as any,
    });

    expect(results.get('task-1')?.status).toBe('completed');
    expect(results.get('task-2')?.status).toBe('failed');
    expect(results.get('task-2')?.error).toMatch(/worker killed/i);

    const tasks = await swarmGate.listByRun(packet.runId!);
    const agg = swarmGate.aggregate(tasks, results);
    expect(agg.completedCount).toBe(1);
    expect(agg.totalCount).toBe(2);
    expect(agg.honestSummary).toMatch(/Completed 1\/2/);
    expect(agg.failedTasks).toHaveLength(1);
    expect(agg.failedTasks[0].id).toBe('task-2');
    expect(agg.mergedContent).toContain('Completed 1/2');
    expect(agg.mergedContent).toContain('task-1 — completed');
    expect(agg.mergedContent).toContain('task-2 — failed');
    expect(agg.mergedContent).not.toContain('fabricated');
    // Ensure no success fabricated for failed task
    expect(agg.mergedContent).not.toMatch(/task-2 — completed/);

    // Verifier should still allow honest partial as pass (since we have 1 success honestly reported)
    // Mock verifier provider for this test: we directly call fallback verifier without LLM (honest fallback)
    const { RuntimeKernel } = await import('../runtime/kernel/runtime-kernel.js');
    const kernel = new RuntimeKernel();
    // Register a provider that will fail to trigger fallback path
    const failProvider: IProviderAdapter = {
      provider: 'swarm-kill-verify',
      supportsStreaming: false,
      supportsTools: false,
      async call() {
        throw new Error('verifier unavailable');
      },
    };
    ProviderRegistry.register(failProvider);
    const packetForVerify = { ...packet, metadata: { ...packet.metadata, provider: 'swarm-kill-verify' } } as ContextPacket;
    const verification = await swarmGate.verify({
      goal: packet.userInput,
      aggregatedContent: agg.mergedContent,
      packet: packetForVerify,
      broker,
      kernel: kernel as any,
      aggregationSummary: { completedCount: agg.completedCount, totalCount: agg.totalCount, failedTasks: agg.failedTasks },
    });
    // Fallback verifier with 1/2 honestly reported should still pass (not fabricating)
    expect(verification.verdict).toBe('pass');
    expect(verification.reason).toMatch(/1\/2/);
  });
});

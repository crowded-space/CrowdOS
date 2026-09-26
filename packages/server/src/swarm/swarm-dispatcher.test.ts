import { describe, it, expect, beforeEach } from 'vitest';
import { swarmGate } from './swarm-gate.js';
import { resetSwarmForTests } from './swarm-repository.js';
import { EventBroker } from '../event-broker/event-broker-gate.js';
import type { ContextPacket } from '../runtime/types.js';

describe('swarmDispatcher DAG respects dependsOn', () => {
  let broker: EventBroker;
  let packet: ContextPacket;

  beforeEach(() => {
    broker = new EventBroker();
    resetSwarmForTests();
    packet = {
      requestId: 'req-1',
      agentId: 'agent-1',
      agentName: 'A',
      authorityLevel: 2,
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      userInput: 'goal',
      systemPrompt: 'sys',
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
      metadata: { runtimeType: 'swarm', provider: 'test', modelName: 'm', modelModuleId: 'mod', startedAt: new Date() },
      _modelConfig: { provider: 'test', modelName: 'm' },
      runId: 'run-dispatch-1',
    } as unknown as ContextPacket & { _modelConfig: unknown };
  });

  it('executes linear chain sequentially (task-2 waits for task-1)', async () => {
    const plan = {
      tasks: [
        { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'first' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-1', goal: 'second' },
      ],
      fallbackUsed: false,
    };
    await swarmGate.createTasks(packet.runId!, plan.tasks);
    const order: string[] = [];
    const executor = async (task: { id: string }) => {
      order.push(task.id);
      // Simulate that task-1 must complete before task-2 starts: verify order
      if (task.id === 'task-2') {
        expect(order).toEqual(['task-1', 'task-2']);
      }
      return `out-${task.id}`;
    };
    const results = await swarmGate.dispatch({ plan, runId: packet.runId!, packet, broker, workerExecutor: executor as any });
    expect(results.get('task-1')?.status).toBe('completed');
    expect(results.get('task-2')?.status).toBe('completed');
    expect(order).toEqual(['task-1', 'task-2']);
  });

  it('fan-out parallel where no deps (both tasks start without waiting)', async () => {
    const plan = {
      tasks: [
        { id: 'task-A', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'A' },
        { id: 'task-B', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'B' },
        { id: 'task-C', dependsOn: ['task-A', 'task-B'], assigneeTemplate: 'agent-1', goal: 'C' },
      ],
      fallbackUsed: false,
    };
    await swarmGate.createTasks(packet.runId!, plan.tasks);
    const started = new Set<string>();
    const executor = async (task: { id: string }) => {
      started.add(task.id);
      // Small delay to allow concurrency
      await new Promise((r) => setTimeout(r, 20));
      return `out-${task.id}`;
    };
    const results = await swarmGate.dispatch({ plan, runId: packet.runId!, packet, broker, workerExecutor: executor as any });
    expect(results.get('task-A')?.status).toBe('completed');
    expect(results.get('task-B')?.status).toBe('completed');
    expect(results.get('task-C')?.status).toBe('completed');
    // All three should have been executed
    expect(started.has('task-A')).toBe(true);
    expect(started.has('task-B')).toBe(true);
    expect(started.has('task-C')).toBe(true);
  });

  it('blocks downstream when dependency fails (honest)', async () => {
    const plan = {
      tasks: [
        { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'will fail' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-1', goal: 'depends on failed' },
        { id: 'task-3', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'independent' },
      ],
      fallbackUsed: false,
    };
    await swarmGate.createTasks(packet.runId!, plan.tasks);
    const executor = async (task: { id: string }) => {
      if (task.id === 'task-1') throw new Error('task-1 killed');
      return `out-${task.id}`;
    };
    const results = await swarmGate.dispatch({ plan, runId: packet.runId!, packet, broker, workerExecutor: executor as any });
    expect(results.get('task-1')?.status).toBe('failed');
    expect(results.get('task-2')?.status).toBe('failed');
    expect(results.get('task-2')?.error).toMatch(/blocked/i);
    expect(results.get('task-3')?.status).toBe('completed');
  });

  it('persists blocked downstream tasks with row status blocked, not failed', async () => {
    const plan = {
      tasks: [
        { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'will fail' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-1', goal: 'downstream' },
      ],
      fallbackUsed: false,
    };
    await swarmGate.createTasks('run-block-1', plan.tasks);
    await swarmGate.dispatch({
      plan,
      runId: 'run-block-1',
      packet,
      broker,
      workerExecutor: async (t) => {
        if (t.id === 'task-1') throw new Error('boom');
        return 'ok';
      },
    });
    const rows = await swarmGate.listByRun('run-block-1');
    const t1 = rows.find((r) => r.id === 'task-1');
    const t2 = rows.find((r) => r.id === 'task-2');
    expect(t1?.status).toBe('failed');
    expect(t2?.status).toBe('blocked');
    expect(t2?.outputRef).toMatch(/^blocked:/);
  });

  it('lease ownership survives overlapping same-agent dispatches (CRITICAL-2)', async () => {
    const g = globalThis as { __swarmLeaseCleanup?: { agentId: string; cleanup: () => void } };
    // read through a closure: defeats TS narrowing after `delete`
    const getLease = () => g.__swarmLeaseCleanup;
    delete g.__swarmLeaseCleanup;
    const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    let release1!: () => void;
    let release2!: () => void;
    const done1 = new Promise<void>((r) => { release1 = r; });
    const done2 = new Promise<void>((r) => { release2 = r; });
    const plan = {
      tasks: [{ id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'g' }],
      fallbackUsed: false,
    };

    const d1 = swarmGate.dispatch({
      plan, runId: 'run-lease-1', packet, broker,
      workerExecutor: async () => { await done1; return 'one'; },
    });
    await settle();
    expect(getLease()?.agentId).toBe('agent-1');
    const lease1 = getLease()!;

    const d2 = swarmGate.dispatch({
      plan, runId: 'run-lease-2', packet, broker,
      workerExecutor: async () => { await done2; return 'two'; },
    });
    await settle();
    const lease2 = getLease();
    // Same agent overlapping: the second dispatch takes ownership WITHOUT
    // releasing the agent (a same-agent prev cleanup would hand the live
    // agent to the orphan sweeper mid-flight).
    expect(lease2).toBeTruthy();
    expect(lease2).not.toBe(lease1);
    expect(lease2!.agentId).toBe('agent-1');

    release1();
    await d1;
    // First dispatch finishing must not idle an agent the second still uses.
    expect(getLease()).toBe(lease2);

    release2();
    await d2;
    // Only after the owner finishes does the agent go idle.
    expect(getLease()).toBeUndefined();
  });
});

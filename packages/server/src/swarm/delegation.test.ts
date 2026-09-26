import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { swarmGate } from "./swarm-gate.js";
import { DelegationRejectedError, delegate, completeDelegation, estimateTokens } from "./delegation-service.js";
import { listAllDelegations, resetDelegationRepositoryForTests } from "./delegation-repository.js";
import { resetSwarmForTests } from "./swarm-repository.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";

describe("SW-2 Delegation contracts", () => {
  let broker: EventBroker;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    broker = new EventBroker();
    resetSwarmForTests();
    resetDelegationRepositoryForTests();
    // Default depth 2
    process.env.SWARM_MAX_DEPTH = "2";
  });

  afterEach(() => {
    process.env.SWARM_MAX_DEPTH = originalEnv.SWARM_MAX_DEPTH;
  });

  it("cycle attempt A→B→A rejected deterministically with cycle error, never enqueues second", async () => {
    const a = `run_${randomUUID().slice(0, 8)}`;
    const b = `run_${randomUUID().slice(0, 8)}`;

    const events: unknown[] = [];
    const startListener = broker.on("delegation:start" as never, undefined, (ev) => events.push(ev));

    // A -> B should succeed
    const first = await delegate({ parentRunId: a, childRunId: b, taskId: "task-1", broker });
    expect(first.parentRunId).toBe(a);
    expect(first.childRunId).toBe(b);
    expect(first.depth).toBe(1);

    // B -> A should be cycle rejection deterministically
    let err1: unknown = null;
    try {
      await delegate({ parentRunId: b, childRunId: a, taskId: "task-cycle", broker });
    } catch (e) {
      err1 = e;
    }
    expect(err1).toBeInstanceOf(DelegationRejectedError);
    expect((err1 as DelegationRejectedError).code).toBe("cycle");
    expect((err1 as Error).message).toMatch(/cycle/i);

    // Second attempt same must give same deterministic error message/code (no state mutation)
    let err2: unknown = null;
    try {
      await delegate({ parentRunId: b, childRunId: a, taskId: "task-cycle", broker });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(DelegationRejectedError);
    expect((err2 as DelegationRejectedError).code).toBe("cycle");
    expect((err2 as Error).message).toBe((err1 as Error).message);

    // Ensure no additional delegation row was created for the rejected attempt
    const all = await listAllDelegations();
    expect(all).toHaveLength(1);
    expect(all[0].parentRunId).toBe(a);

    // Events: only first delegation emitted start, second never emitted
    expect(events.length).toBe(1);
    broker.off(startListener);
  });

  it("depth 3 rejected when max 2 (depth guard)", async () => {
    const root = `run_${randomUUID().slice(0, 8)}`;
    const c1 = `run_${randomUUID().slice(0, 8)}`;
    const c2 = `run_${randomUUID().slice(0, 8)}`;
    const c3 = `run_${randomUUID().slice(0, 8)}`;

    // root -> c1 depth1
    const r1 = await delegate({ parentRunId: root, childRunId: c1, taskId: "t1", broker });
    expect(r1.depth).toBe(1);
    // c1 -> c2 depth2
    const r2 = await delegate({ parentRunId: c1, childRunId: c2, taskId: "t2", broker });
    expect(r2.depth).toBe(2);

    // c2 -> c3 depth3 should be rejected
    await expect(delegate({ parentRunId: c2, childRunId: c3, taskId: "t3", broker })).rejects.toThrow(DelegationRejectedError);
    try {
      await delegate({ parentRunId: c2, childRunId: c3, taskId: "t3", broker });
      expect.unreachable("should have thrown depth rejection");
    } catch (e) {
      expect((e as DelegationRejectedError).code).toBe("depth");
      expect((e as Error).message).toMatch(/max depth 2 exceeded/i);
      expect((e as DelegationRejectedError).attemptedDepth).toBe(3);
    }

    const all = await listAllDelegations();
    // Only 2 successful rows, third never enqueued
    expect(all).toHaveLength(2);
  });

  it("depth guard disabled when SWARM_MAX_DEPTH=99 (rollback) — depth 3 passes", async () => {
    process.env.SWARM_MAX_DEPTH = "99";
    const root = `run_${randomUUID().slice(0, 8)}`;
    const c1 = `run_${randomUUID().slice(0, 8)}`;
    const c2 = `run_${randomUUID().slice(0, 8)}`;
    const c3 = `run_${randomUUID().slice(0, 8)}`;
    const c4 = `run_${randomUUID().slice(0, 8)}`;

    await delegate({ parentRunId: root, childRunId: c1, taskId: "t1", broker });
    await delegate({ parentRunId: c1, childRunId: c2, taskId: "t2", broker });
    const r3 = await delegate({ parentRunId: c2, childRunId: c3, taskId: "t3", broker });
    expect(r3.depth).toBe(3);
    const r4 = await delegate({ parentRunId: c3, childRunId: c4, taskId: "t4", broker });
    expect(r4.depth).toBe(4);

    // Cycle still enforced even when depth guard disabled
    await expect(delegate({ parentRunId: c4, childRunId: root, taskId: "cycle", broker })).rejects.toThrow(DelegationRejectedError);
    try {
      await delegate({ parentRunId: c4, childRunId: root, taskId: "cycle", broker });
      expect.unreachable();
    } catch (e) {
      expect((e as DelegationRejectedError).code).toBe("cycle");
    }
  });

  it("parent prompt delta ≤ summary+pointer size (≤500 tokens + overhead) not full child output, artifact pointer present when truncation", async () => {
    const parent = `run_${randomUUID().slice(0, 8)}`;
    const child = `run_${randomUUID().slice(0, 8)}`;

    // Create a large child output: 10k chars ~2500 tokens > 500
    const largeOutput = "A".repeat(10000) + "\n" + "B".repeat(2000);
    const fullTokens = estimateTokens(largeOutput);
    expect(fullTokens).toBeGreaterThan(500);

    // Delegate then complete
    await delegate({ parentRunId: parent, childRunId: child, taskId: "big-task", broker });

    let completedPayload: unknown = null;
    const l = broker.on("delegation:completed" as never, undefined, (ev) => {
      completedPayload = ev;
    });

    const { summary, artifactRef, truncated } = await completeDelegation({
      parentRunId: parent,
      childRunId: child,
      fullOutput: largeOutput,
      broker,
      workspaceId: "ws-test",
      producerAgent: "agent-test",
    });

    expect(truncated).toBe(true);
    expect(artifactRef).toBeTruthy();
    expect(summary).toContain(`artifact:${artifactRef}`);
    expect(summary.length).toBeLessThan(largeOutput.length);
    const summaryTokens = estimateTokens(summary);
    // Parent context grows ≤ summary size (assert): summary tokens should be ≤ 500 + overhead (~20 tokens for pointer)
    // MAX 500 + pointer overhead 50 tokens margin
    expect(summaryTokens).toBeLessThanOrEqual(550);
    expect(summaryTokens).toBeLessThan(fullTokens);

    // Event payload contains summary + pointer
    expect(completedPayload).toBeTruthy();
    const payload = (completedPayload as { payload: { summary: string; artifactRef: string | null } }).payload;
    expect(payload.summary).toBe(summary);
    expect(payload.artifactRef).toBe(artifactRef);

    broker.off(l);

    // Small output should NOT truncate and NOT have artifact
    const smallChild = `run_${randomUUID().slice(0, 8)}`;
    const smallParent = `run_${randomUUID().slice(0, 8)}`;
    const smallOutput = "short answer: hello world";
    await delegate({ parentRunId: smallParent, childRunId: smallChild, taskId: "small", broker });
    const smallResult = await completeDelegation({
      parentRunId: smallParent,
      childRunId: smallChild,
      fullOutput: smallOutput,
      broker,
      workspaceId: "ws-test",
      producerAgent: "agent-test",
    });
    expect(smallResult.truncated).toBe(false);
    expect(smallResult.artifactRef).toBeNull();
    expect(smallResult.summary).toBe(smallOutput);
    expect(estimateTokens(smallResult.summary)).toBeLessThanOrEqual(500);
  });

  it("delegation:start and delegation:completed events emitted and consumable by UI timeline", async () => {
    const parent = `run_${randomUUID().slice(0, 8)}`;
    const child = `run_${randomUUID().slice(0, 8)}`;
    const startEvents: Array<{ payload: { parentRunId: string; childRunId: string; depth: number; taskId: string | null } }> = [];
    const completedEvents: Array<{ payload: { parentRunId: string; childRunId: string; summary: string; artifactRef: string | null } }> = [];
    const sL = broker.on("delegation:start" as never, undefined, (ev: unknown) => startEvents.push(ev as never));
    const cL = broker.on("delegation:completed" as never, undefined, (ev: unknown) => completedEvents.push(ev as never));

    await delegate({ parentRunId: parent, childRunId: child, taskId: "task-ui", broker });
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].payload.parentRunId).toBe(parent);
    expect(startEvents[0].payload.childRunId).toBe(child);
    expect(startEvents[0].payload.depth).toBe(1);
    expect(startEvents[0].payload.taskId).toBe("task-ui");

    const out = "x".repeat(100);
    await completeDelegation({ parentRunId: parent, childRunId: child, fullOutput: out, broker });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].payload.parentRunId).toBe(parent);
    expect(completedEvents[0].payload.summary).toBe(out);
    expect(completedEvents[0].payload.artifactRef).toBeNull();

    broker.off(sL);
    broker.off(cL);
  });

  it("swarmDispatcher via swarmGate.dispatch enforces depth/cycle through central dispatcher (never enqueues violating worker)", async () => {
    // Setup chain depth 2 already, next dispatch should have its workers rejected via delegation wrapper
    process.env.SWARM_MAX_DEPTH = "2";
    const root = `run_${randomUUID().slice(0, 8)}`;
    const c1 = `run_${randomUUID().slice(0, 8)}`;
    const c2 = `run_${randomUUID().slice(0, 8)}`;
    await delegate({ parentRunId: root, childRunId: c1, taskId: "t1", broker });
    await delegate({ parentRunId: c1, childRunId: c2, taskId: "t2", broker });
    // Now c2 is depth 2. Dispatching swarm work from c2 should attempt to delegate depth 3 for each worker and be rejected.
    const plan = {
      tasks: [{ id: "task-1", dependsOn: [], assigneeTemplate: "agent-1", goal: "should be rejected by depth" }],
      fallbackUsed: false,
    };
    await swarmGate.createTasks(c2, plan.tasks);
    const fakePacket = {
      requestId: "req-depth-swarm",
      agentId: "agent-1",
      agentName: "A",
      authorityLevel: 2,
      channelId: "ch-1",
      workspaceId: "ws-1",
      userInput: "goal",
      systemPrompt: "sys",
      history: [],
      policies: { maxTokenBudget: 4000, maxIterations: 5, allowToolCalls: true, allowSpawn: true, allowDelegation: true, loopDetection: true, streamOutput: false },
      metadata: { runtimeType: "swarm", provider: "test", modelName: "m", modelModuleId: "mod", startedAt: new Date() },
      _modelConfig: { provider: "test", modelName: "m" },
      runId: c2,
    } as unknown as import("../runtime/types.js").ContextPacket & { _modelConfig: unknown };
    let workerCalled = false;
    const executor = async () => {
      workerCalled = true;
      return "should not happen";
    };
    const results = await swarmGate.dispatch({ plan, runId: c2, packet: fakePacket as never, broker, workerExecutor: executor as never });
    expect(results.get("task-1")?.status).toBe("failed");
    expect(results.get("task-1")?.error).toMatch(/max depth 2 exceeded/i);
    expect(workerCalled).toBe(false);
  });

  it("dispatcher mints uuid child ids that persist as delegation rows", async () => {
    const runId = randomUUID();
    const plan = { tasks: [{ id: "task-1", dependsOn: [], assigneeTemplate: "agent-1", goal: "g" }], fallbackUsed: false };
    await swarmGate.createTasks(runId, plan.tasks);
    const packet = {
      requestId: "req-del-uuid",
      agentId: "agent-1",
      agentName: "A",
      authorityLevel: 2,
      channelId: "ch-1",
      workspaceId: "ws-1",
      userInput: "goal",
      systemPrompt: "sys",
      history: [],
      metadata: { runtimeType: "swarm", provider: "test", modelName: "m" },
      runId,
    } as unknown as import("../runtime/types.js").ContextPacket;
    await swarmGate.dispatch({ plan, runId, packet, broker, workerExecutor: async () => "ok" });

    const all = await listAllDelegations();
    expect(all.length).toBeGreaterThan(0);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const d of all) {
      expect(d.parentRunId).toBe(runId);
      expect(d.childRunId).toMatch(uuidRe);
    }
    // Summary persisted on completion (rows survive past the call — this is
    // what the depth/cycle guard reads in prod, not process-only state).
    expect(all[0].summary).toContain("ok");
  });

  it("delegation events carry workspaceId for workspace-room fan-out", async () => {
    const parent = randomUUID();
    const child = randomUUID();
    const starts: Array<{ payload: Record<string, unknown> }> = [];
    const completeds: Array<{ payload: Record<string, unknown> }> = [];
    const sL = broker.on("delegation:start" as never, undefined, (ev: unknown) => starts.push(ev as never));
    const cL = broker.on("delegation:completed" as never, undefined, (ev: unknown) => completeds.push(ev as never));

    await delegate({ parentRunId: parent, childRunId: child, taskId: "t", broker, workspaceId: "ws-9" });
    await completeDelegation({ parentRunId: parent, childRunId: child, fullOutput: "result", broker, workspaceId: "ws-9" });

    expect(starts).toHaveLength(1);
    expect(starts[0].payload.workspaceId).toBe("ws-9");
    expect(completeds).toHaveLength(1);
    expect(completeds[0].payload.workspaceId).toBe("ws-9");

    broker.off(sL);
    broker.off(cL);
  });

  it("depth guard rejects at depth 3 with real uuid run ids", async () => {
    const root = randomUUID();
    const c1 = randomUUID();
    const c2 = randomUUID();
    const c3 = randomUUID();
    await delegate({ parentRunId: root, childRunId: c1, broker });
    await delegate({ parentRunId: c1, childRunId: c2, broker });
    await expect(delegate({ parentRunId: c2, childRunId: c3, broker })).rejects.toThrow(/max depth 2 exceeded/i);
  });
});

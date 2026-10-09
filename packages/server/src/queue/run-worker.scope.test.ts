import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

type FakeStore = { agents: Record<string, unknown>[] };

function makeFakeJob(data: Record<string, unknown>) {
  const progress: unknown[] = [];
  const job = {
    data,
    token: "lock-token",
    updateProgress: vi.fn(async (payload: unknown) => {
      progress.push(payload);
      return {};
    }),
    extendLock: vi.fn(async () => {}),
  };
  return { job, progress };
}

/**
 * TG-4 / SH-002: processRunJob must execute inside the workspace ALS handle
 * (dbForWorkspace → runWithDb) so bare getDb() writes inside the runtime
 * resolve the workspace DB, not the ambient pool. Fake DB seams come from
 * src/test-setup.ts (__SOCKET_FAKE_DB__); the executor spy reads a bare
 * getDb() at call time under the opt-in fake ALS and records the handle's
 * __workspaceMarker.
 */
describe("TG-4 · queue worker tenant scope (SH-002, run-worker.ts)", () => {
  beforeEach(() => {
    process.env.__SOCKET_FAKE_DB__ = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupWorkerHarness() {
    vi.resetModules();
    const databaseModule = await import("../shared/config/database.js");
    const brokerModule = await import("../event-broker/event-broker-gate.js");
    const runtimeModule = await import("../runtime/runtime-gate.js");
    const workerModule = await import("./run-worker.js");

    const socketTestDb = (databaseModule as any).__socketTestDb as {
      store: FakeStore;
      reset(): void;
      setFakeAls(enabled: boolean): void;
      setWorkspaceDbResolver(fn: ((workspaceId: string) => Promise<unknown> | unknown) | null): void;
      lastBoundDb: unknown;
      boundCalls: unknown[];
    };
    socketTestDb.reset();
    socketTestDb.setFakeAls(true);
    // Seeded agent so processRunJob's resolve leg succeeds (getById → list).
    socketTestDb.store.agents.push({
      id: "agent-worker",
      name: "Worker",
      title: "Test Agent",
      authorityLevel: 0,
      status: "idle",
      isTemplate: false,
      workspaceId: "default",
    });

    brokerModule.setSharedBroker(new brokerModule.EventBroker());

    const markers: Array<string | undefined> = [];
    const seenWorkspaces: Array<string | undefined> = [];
    const executeSpy = vi.spyOn(runtimeModule.runtimeGate, "execute");
    executeSpy.mockImplementation(async (req: any) => {
      seenWorkspaces.push(req.workspaceId);
      markers.push((databaseModule.getDb() as any).__workspaceMarker);
      return { status: "completed" } as any;
    });

    return { workerModule, socketTestDb, markers, seenWorkspaces, executeSpy };
  }

  // Generous timeout: the first test in this file pays the one-time cold cost
  // of dynamic imports inside processRunJob; in the combined artifacts+queue
  // run it exceeded the 5s default and the dangling execution contaminated
  // the next test (SH-002 TG-4 fallout). Same convention as the socket suite.
  it("bound: a ws-a job runs the executor inside the ws-a handle", { timeout: 20_000 }, async () => {
    const { workerModule, socketTestDb, markers, seenWorkspaces } = await setupWorkerHarness();
    const { job, progress } = makeFakeJob({
      channelId: "ch-a",
      agentId: "agent-worker",
      messageId: "msg-1",
      userInput: "hi",
      workspaceId: "ws-a",
      runId: "run-1",
    });

    const result: any = await workerModule.processRunJob(job as any);

    expect(result.status).toBe("completed");
    expect(seenWorkspaces).toEqual(["ws-a"]);
    // A bare getDb() read inside the executor resolved the bound ws-a handle.
    expect(markers).toEqual(["ws-a"]);
    expect((socketTestDb.lastBoundDb as any)?.__workspaceMarker).toBe("ws-a");
    expect((socketTestDb.boundCalls[0] as any)?.__workspaceMarker).toBe("ws-a");
    expect(progress.length).toBeGreaterThanOrEqual(1);
  });

  it("default-bound: a workspace-less job binds the default handle", async () => {
    const { workerModule, markers, seenWorkspaces } = await setupWorkerHarness();
    const { job } = makeFakeJob({
      channelId: "ch-a",
      agentId: "agent-worker",
      messageId: "msg-1",
      userInput: "hi",
      runId: "run-1",
    });

    await workerModule.processRunJob(job as any);

    // effectiveWorkspaceId falls back to "default" — still bound, never bare.
    expect(seenWorkspaces).toEqual(["default"]);
    expect(markers).toEqual(["default"]);
  });

  it("resolver-null: degrades to the unscoped executor with no ALS bind", async () => {
    const { workerModule, socketTestDb, markers, seenWorkspaces } = await setupWorkerHarness();
    // Local-only/unknown workspace: the record resolver yields null, so the
    // wrap is skipped and the executor runs unbound (intended degradation;
    // BullMQ retry semantics stay intact because only the resolver is caught).
    socketTestDb.setWorkspaceDbResolver(() => null);
    const { job } = makeFakeJob({
      channelId: "ch-a",
      agentId: "agent-worker",
      messageId: "msg-1",
      userInput: "hi",
      workspaceId: "ws-a",
      runId: "run-1",
    });

    await workerModule.processRunJob(job as any);

    expect(seenWorkspaces).toEqual(["ws-a"]);
    expect(markers).toEqual([undefined]);
    expect(socketTestDb.boundCalls).toHaveLength(0);
    expect(socketTestDb.lastBoundDb).toBeNull();
  });
});

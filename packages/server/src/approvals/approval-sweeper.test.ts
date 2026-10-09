// AP-003/AP-004 regression guards (fix-approvals-micro-003-004).
//
// AP-003: sweepApprovalsOnce must sweep the ambient getDb() handle even when
// the workspace registry exposes zero DB targets (single-DB deployments where
// the fan-out visits nothing). Without the ambient leg the flip never runs and
// pending rows leak as pending.
//
// AP-004: POST /api/approvals/sweep must delegate to approvalGate.sweepOnce
// (flip + default-deny resume + approval.decided emit), never the flip-only
// sweepExpired; the waiting run resumes and observers see decision "expired".
//
// AP-016: two overlapping sweepApprovalsOnce calls (API inline timer + worker
// timer in separate processes, no leader election) converge by construction:
// the atomic expire gives each row exactly one owner, and the runs CAS admits a
// single waiting_for_approval -> running hop even when both sweeps pass the
// status guard for the same run. Each flipped row emits approval.decided once.
//
// Hermetic: the DB/state/workspace/runs boundaries are mocked, so these run
// without DATABASE_URL or a live PG (the pre-existing integration files remain
// DB-gated). getDb()/runWithDb() never issue queries here.
import Fastify from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = { id: string; runId: string; toolName: string; scope: string | null; riskClass: string };
  type Run = { id: string; status: string; channelId: string; workspaceId: string | null };
  const prevDatabaseUrl = process.env.DATABASE_URL;
  // Fallback for any real-module path: constructing a client is lazy and
  // issues no I/O, but getDb() requires a parseable URL to exist.
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/crowdos_approval_sweeper_test";
  return {
    prevDatabaseUrl,
    expiredRows: [] as Row[],
    runs: new Map<string, Run>(),
    transitions: [] as Array<Record<string, unknown>>,
    transitionAttempts: 0,
    pendingRows: [] as Row[],
    claimedIds: [] as string[],
    // AP-016 race barrier: holds resume attempts until the expected number of
    // sweeps has passed the waiting_for_approval guard, forcing the CAS race.
    casBarrier: {
      enabled: false,
      expected: 0,
      waiting: 0,
      release: undefined as undefined | (() => void),
      promise: undefined as undefined | Promise<void>,
    },
    fanoutCalls: 0,
    ambientDb: { __ambientDb: true },
  };
});

vi.mock("../shared/config/database.js", () => ({
  getDb: () => h.ambientDb,
  runWithDb: (_db: unknown, fn: () => unknown) => fn(),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the sweeper test mock");
  },
  isDatabaseConfigured: () => true,
  isNoDatabaseError: () => false,
  isConnectionError: () => false,
  noteDbFailure: () => {},
  noteDbSuccess: () => {},
  resolveTier: () => ({ tier: "local", url: null }),
  dbScopeKey: () => "global",
  closeDatabaseConnection: async () => {},
}));

vi.mock("../runs/runs-gate.js", () => ({
  runsGate: {
    getById: async (id: string) => h.runs.get(id) ?? null,
    transition: async () => null,
  },
}));

vi.mock("../state/state-gate.js", () => ({
  stateGate: {
    applyRunTransition: async (input: Record<string, unknown>) => {
      // Models runsRepository.applyTransition's CAS (WHERE status = from) plus
      // the sweeper's waiting_for_approval pre-check: the hop lands only while
      // the run is still waiting, so a second sweep that passed the same guard
      // becomes a no-op. The optional barrier parks every attempt until all
      // expected sweeps have arrived, making the overlap deterministic.
      h.transitionAttempts += 1;
      const run = h.runs.get(String(input.runId));
      if (!run || run.status !== "waiting_for_approval") return { changed: false };
      if (h.casBarrier.enabled) {
        h.casBarrier.waiting += 1;
        if (h.casBarrier.waiting >= h.casBarrier.expected) h.casBarrier.release?.();
        await h.casBarrier.promise;
        if (run.status !== "waiting_for_approval") return { changed: false };
      }
      run.status = String(input.to);
      h.transitions.push(input);
      return { changed: true };
    },
    applyMessage: async () => ({}),
  },
}));

// Zero workspace DB targets: single-DB mode (the AP-003 failure mode).
vi.mock("../workspace/workspace-gate.js", () => ({
  forEachWorkspaceDb: async (_fn: unknown) => {
    h.fanoutCalls += 1;
  },
}));

vi.mock("../shared/sockets/register-socket-server.js", () => ({ globalBroker: null }));

import { EventBroker, resetSharedBrokerForTests, setSharedBroker } from "../event-broker/event-broker-gate.js";
import { approvalGate } from "./approval-gate.js";
import { sweepApprovalsOnce } from "./approval-sweeper.js";
import { approvalsRoutes } from "../routes/approvals.js";

function queueExpiredRow(id: string, runId: string): void {
  h.expiredRows.push({ id, runId, toolName: "execute_bash", scope: "scope-x", riskClass: "general" });
  h.runs.set(runId, { id: runId, status: "waiting_for_approval", channelId: "ch-1", workspaceId: null });
}

function captureDecided(broker: EventBroker): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  broker.on("approval.decided" as never, undefined, ((event: { payload: Record<string, unknown> }) => {
    seen.push(event.payload);
  }) as never);
  return seen;
}

beforeEach(() => {
  h.expiredRows.length = 0;
  h.runs.clear();
  h.transitions.length = 0;
  h.transitionAttempts = 0;
  h.pendingRows.length = 0;
  h.claimedIds.length = 0;
  h.casBarrier.enabled = false;
  h.casBarrier.expected = 0;
  h.casBarrier.waiting = 0;
  h.casBarrier.release = undefined;
  h.casBarrier.promise = undefined;
  h.fanoutCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSharedBrokerForTests();
});

afterAll(() => {
  if (h.prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = h.prevDatabaseUrl;
});

describe("AP-003 sweepOnce single-DB fan-out", () => {
  it("expires ambient-DB pendings when the registry exposes zero workspace DBs", async () => {
    queueExpiredRow("ap003-row-1", "ap003-run-1");
    const expireSpy = vi
      .spyOn(approvalGate, "expirePendingApprovals")
      .mockImplementation(async () => h.expiredRows as never);
    const broker = new EventBroker();
    const decided = captureDecided(broker);

    const count = await sweepApprovalsOnce(broker);

    expect(h.fanoutCalls).toBe(1); // workspace fan-out ran but found no targets...
    expect(expireSpy).toHaveBeenCalled(); // ...so the ambient getDb() leg did the flip
    expect(count).toBe(1);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({
      runId: "ap003-run-1",
      to: "running",
      reason: "approval_expired_default_deny",
    });
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ approvalId: "ap003-row-1", decision: "expired" });
  });
});

describe("AP-004 POST /api/approvals/sweep", () => {
  it("resumes the waiting run and emits expired instead of a flip-only sweep", async () => {
    queueExpiredRow("ap004-row-1", "ap004-run-1");
    const expireSpy = vi
      .spyOn(approvalGate, "expirePendingApprovals")
      .mockImplementation(async () => h.expiredRows as never);
    const flipOnly = vi.spyOn(approvalGate, "sweepExpired");
    const broker = new EventBroker();
    setSharedBroker(broker);
    const decided = captureDecided(broker);

    const app = Fastify();
    await app.register(approvalsRoutes);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/approvals/sweep" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ swept: 1 });
    expect(expireSpy).toHaveBeenCalled();
    expect(flipOnly).not.toHaveBeenCalled();
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({
      runId: "ap004-run-1",
      to: "running",
      reason: "approval_expired_default_deny",
    });
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ approvalId: "ap004-row-1", decision: "expired" });
  });
});

describe("AP-016 concurrent sweeps converge", () => {
  // Two sweepApprovalsOnce calls overlapping the way the API inline timer and
  // the worker timer do in a dual deploy. The flip is modeled as the real
  // single-statement UPDATE ... RETURNING: one synchronous claim pass, so each
  // pending row lands in exactly one sweep's expired set. Both rows reference
  // the SAME waiting run (the ledger's "disjoint rows, one run" race), and the
  // barrier holds both resume attempts past the waiting_for_approval pre-check
  // until they collide, forcing the CAS to pick the single winner.
  it("two overlapping sweeps expire each row once, resume the shared run once, emit per row", async () => {
    queueExpiredRow("ap016-row-1", "ap016-run-1");
    queueExpiredRow("ap016-row-2", "ap016-run-1");
    h.pendingRows.push(...h.expiredRows);
    vi.spyOn(approvalGate, "expirePendingApprovals").mockImplementation(async () => {
      const taken = h.pendingRows.splice(0, 1); // atomic UPDATE ... RETURNING
      h.claimedIds.push(...taken.map((r) => r.id));
      return taken as never;
    });
    h.casBarrier.enabled = true;
    h.casBarrier.expected = 2;
    h.casBarrier.promise = new Promise<void>((resolve) => {
      h.casBarrier.release = resolve;
    });
    const broker = new EventBroker();
    const decided = captureDecided(broker);

    // Stagger the starts by one hop: sweep A flips row-1 and parks at the
    // resume barrier, then sweep B flips row-2 and collides with A. Both
    // sweeps are in flight across the flip/resume/emit window (the race under
    // test) without racing the dynamic-import resolution of the mocked DB
    // module, which a same-tick Promise.all start would (vitest resolves
    // concurrent dynamic imports of one specifier past the mock registry).
    const first = sweepApprovalsOnce(broker);
    await vi.waitFor(() => expect(h.transitionAttempts).toBe(1));
    const second = sweepApprovalsOnce(broker);
    const counts = await Promise.all([first, second]);

    // Each row flipped exactly once across both sweeps (disjoint RETURNING sets).
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(h.claimedIds.slice().sort()).toEqual(["ap016-row-1", "ap016-row-2"]);
    // Both sweeps raced the same run past the status guard; CAS admitted one hop.
    expect(h.transitionAttempts).toBe(2);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({
      runId: "ap016-run-1",
      to: "running",
      reason: "approval_expired_default_deny",
    });
    expect(h.runs.get("ap016-run-1")?.status).toBe("running");
    // Emits stay one-per-flip: both rows observed expired, each exactly once.
    expect(decided).toHaveLength(2);
    expect(decided.map((d) => d.approvalId).sort()).toEqual(["ap016-row-1", "ap016-row-2"]);
    expect(decided.every((d) => d.decision === "expired")).toBe(true);
  });
});

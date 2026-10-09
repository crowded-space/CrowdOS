// OBS-004: verifyLedgerAccuracy must compare like-for-like — the SQL ground
// truth is windowed to the same newest-N limit as the dashboard read it
// checks. This fake serves both sides from one dataset so a window/full-table
// scope mismatch shows up as a delta, and pins the near-zero delta rule.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ promptTokens: number; completionTokens: number; costPer1k: number | null; timestamp: number }>,
  lastSelectLimit: -1,
  lastExecuteLimit: -1,
  executeTotalOverride: null as number | null,
  scope: 0,
}));

vi.mock("../shared/config/database.js", () => ({
  // Fresh scope per call: the 60s verify cache must not leak across tests.
  dbScopeKey: () => `verify-scope-${++h.scope}`,
  isDatabaseConfigured: () => true,
  getDb: () => {
    const windowed = (limit: number) =>
      [...h.rows].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    const totalOf = (rows: typeof h.rows) =>
      rows.reduce((s, r) => s + ((r.promptTokens + r.completionTokens) * (r.costPer1k ?? 0)) / 1000, 0);
    return {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            orderBy: () => ({
              limit: (limit: number) => {
                h.lastSelectLimit = limit;
                const rows = windowed(limit).map((r) => ({
                  runId: null,
                  agentId: "a",
                  channelId: "ch",
                  modelModuleId: null,
                  promptTokens: r.promptTokens,
                  completionTokens: r.completionTokens,
                  totalTokens: r.promptTokens + r.completionTokens,
                  timestamp: new Date(1_700_000_000_000 + r.timestamp),
                  costPer1k: r.costPer1k,
                }));
                const p = Promise.resolve(rows) as Promise<unknown> & { where?: unknown };
                p.where = () => Promise.resolve(rows);
                return p;
              },
            }),
          }),
        }),
      }),
      // Ground-truth SUM: honors the window limit the SQL interpolates; falls
      // back to the full table only if the query carried no numeric param.
      execute: async (q: unknown) => {
        const chunks = ((q as { queryChunks?: unknown[] }).queryChunks ?? []) as unknown[];
        // drizzle pushes interpolated params as raw values (or Param wrappers).
        const limit = chunks
          .map((c) => (typeof c === "number" ? c : (c as { value?: unknown })?.value))
          .find((v): v is number => typeof v === "number");
        h.lastExecuteLimit = limit ?? -1;
        const total = h.executeTotalOverride ?? totalOf(limit === undefined ? h.rows : windowed(limit));
        return [{ total }];
      },
    };
  },
}));

vi.mock("../modules/module-gate.js", () => ({
  moduleGate: { model: { list: async () => [] } },
}));

import { observabilityGate } from "./observability-gate.js";

/** N rows at $1 each; newest = highest timestamp. */
function seedRows(count: number): void {
  h.rows = Array.from({ length: count }, (_, i) => ({
    promptTokens: 1000,
    completionTokens: 0,
    costPer1k: 1,
    timestamp: i,
  }));
}

describe("OBS-004 verify ledger accuracy — windowed ground truth", () => {
  beforeEach(() => {
    h.rows = [];
    h.lastSelectLimit = -1;
    h.lastExecuteLimit = -1;
    h.executeTotalOverride = null;
  });

  it("verifies the served dashboard window by default (both sides newest-100)", async () => {
    seedRows(150); // window total $100; full-table total $150
    const res = await observabilityGate.verifyLedgerAccuracy();
    expect(h.lastSelectLimit).toBe(100); // served dashboard default
    expect(h.lastExecuteLimit).toBe(100); // ground truth windowed to the same limit
    expect(res).toMatchObject({ match: true, ledgerTotal: 100, recomputedTotal: 100, deltaPct: 0 });
  });

  it("honors an explicit limit on both sides (1500 rows, limit 1000)", async () => {
    seedRows(1500); // window total $1000; full-table total $1500
    const res = await observabilityGate.verifyLedgerAccuracy({ limit: 1000 });
    expect(h.lastSelectLimit).toBe(1000);
    expect(h.lastExecuteLimit).toBe(1000); // ground truth windowed to the same limit
    expect(res).toMatchObject({ match: true, ledgerTotal: 1000, recomputedTotal: 1000, deltaPct: 0 });
  });

  it("reports a true percentage and still catches a real mismatch", async () => {
    seedRows(100);
    h.executeTotalOverride = 102; // 2% off the $100 window
    const res = await observabilityGate.verifyLedgerAccuracy();
    expect(res.match).toBe(false);
    expect(res.deltaPct).toBeCloseTo(1.96, 2); // 2/102, not 2/max(1, 100)
  });

  it("does not force match:true when the dashboard window is empty but rows exist", async () => {
    seedRows(0);
    h.executeTotalOverride = 5;
    const res = await observabilityGate.verifyLedgerAccuracy();
    expect(res).toMatchObject({ match: false, ledgerTotal: 0, recomputedTotal: 5, deltaPct: 100 });
  });

  it("documents the near-zero rule: empty on both sides matches at delta 0", async () => {
    const res = await observabilityGate.verifyLedgerAccuracy();
    expect(res).toMatchObject({ match: true, ledgerTotal: 0, recomputedTotal: 0, deltaPct: 0 });
  });
});

import { describe, expect, it, vi } from "vitest";

const calls: Array<{ runId: string; options: unknown }> = [];
const staleRows = [
  { id: "run-ws", agentId: "a", channelId: "c", workspaceId: "ws-scoped", runtimeType: "agentic", status: "running", errorCode: null, updatedAt: new Date(Date.now() - 600_000) },
  { id: "run-legacy", agentId: "a", channelId: "c", workspaceId: null, runtimeType: "agentic", status: "running", errorCode: null, updatedAt: new Date(Date.now() - 600_000) },
];

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => ({ for: async () => [...staleRows] }) }),
        }),
      }),
    }),
  }),
  isDatabaseConfigured: () => true,
  runWithDb: async (_db: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../workspace/workspace-gate.js", () => ({
  forEachWorkspaceDb: async (fn: (db: unknown, workspaceId: string | null) => Promise<void>) => {
    await fn({}, "ws-scoped");
  },
}));

vi.mock("./runs-repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runs-repository.js")>();
  return {
    ...actual,
    applyTransition: async (runId: string, to: string, options: unknown = {}) => {
      calls.push({ runId, options });
      return { row: { id: runId, workspaceId: (options as any)?.workspaceId ?? null }, from: "running", to, changed: true, reason: (options as any)?.reason ?? null };
    },
  };
});

import { sweepOrphanedRuns } from "./orphan-sweep.js";

describe("orphan sweep workspace scope", () => {
  it("threads the row workspace into every transition and preserves legacy rows", async () => {
    calls.length = 0;
    const broker = { emit: () => {} };
    await sweepOrphanedRuns(broker as never);
    const scoped = calls.filter((call) => call.runId === "run-ws");
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) expect((call.options as any)?.workspaceId).toBe("ws-scoped");
    const legacy = calls.filter((call) => call.runId === "run-legacy");
    expect(legacy.length).toBeGreaterThan(0);
    for (const call of legacy) expect((call.options as any)?.workspaceId).toBeUndefined();
  });
});

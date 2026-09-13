import { describe, expect, it } from "vitest";

import { runWithDb, dbScopeKey, getDb } from "./database.js";
import { enableRosterCacheForTests, invalidateRosterCache } from "../../agents/agent-roster-cache.js";
import { agentGate } from "../../agents/agent-gate.js";

const fakeDb = (tag: string) => ({
  tag,
  query: {
    agents: {
      findMany: async () => [{ id: `id-${tag}`, name: `Agent ${tag}` }],
    },
  },
});

describe("runWithDb tenant scope", () => {
  it("binds getDb() inside the callback only", () => {
    expect(dbScopeKey()).toBe("global");
    const handle = fakeDb("a") as any;
    let inner: unknown;
    let innerKey = "";
    runWithDb(handle, () => {
      inner = getDb();
      innerKey = dbScopeKey();
    });
    expect(inner).toBe(handle);
    expect(innerKey).not.toBe("global");
    expect(dbScopeKey()).toBe("global");
  });

  it("isolates concurrent scopes", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithDb(fakeDb("a") as any, async () => {
        await new Promise((r) => setTimeout(r, 20));
        seen.push(((getDb() as any).tag as string) ?? "none");
      }),
      runWithDb(fakeDb("b") as any, async () => {
        seen.push(((getDb() as any).tag as string) ?? "none");
      }),
    ]);
    // Interleaved execution must still resolve each scope to its own handle.
    expect(seen).toContain("a");
    expect(seen).toContain("b");
  });

  it("assigns stable keys per handle", () => {
    const handleA = fakeDb("a") as any;
    const k1 = runWithDb(handleA, dbScopeKey);
    expect(runWithDb(handleA, dbScopeKey)).toBe(k1);
    expect(runWithDb(fakeDb("b") as any, dbScopeKey)).not.toBe(k1);
  });
});

describe("tenant-scoped roster cache", () => {
  it("never serves workspace A's roster to workspace B", async () => {
    const restore = enableRosterCacheForTests();
    try {
      invalidateRosterCache();
      const dbA = fakeDb("A") as any;
      const dbB = fakeDb("B") as any;
      const a = await runWithDb(dbA, () => agentGate.list({}));
      const b = await runWithDb(dbB, () => agentGate.list({}));
      expect(a.map((r) => r.name)).toEqual(["Agent A"]);
      expect(b.map((r) => r.name)).toEqual(["Agent B"]);
      // Second read under A hits A's cache entry, not B's rows.
      const a2 = await runWithDb(dbA, () => agentGate.list({}));
      expect(a2.map((r) => r.name)).toEqual(["Agent A"]);
    } finally {
      invalidateRosterCache();
      restore();
    }
  });
});

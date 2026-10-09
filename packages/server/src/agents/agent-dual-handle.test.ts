// AGT-001 / AGT-002 / AGT-005 / AGT-008 / AGT-009 / AGT-014 regressions: the PG replica leg, the
// getById gap-fill, and the bound-scope roster must resolve the OWNING
// workspace's database handle instead of the ambient pool (split-DB /
// socket-scope class); delete() must propagate cascade failures (no in-tx
// swallowing); the PG agents row must carry contextTokenCap (migration 0027);
// modelModuleId null clears while undefined keeps (both tiers); a generic
// profile update must not flip runtime presence (setStatus owns status).
//
// Method (channel-dual-mode precedent): the REAL database.js runs (ALS +
// dualWrite); the workspace gate is faked so a named workspace resolves "dual"
// and getWorkspaceDb returns a recording handle; env DATABASE_URL is unset so
// an unbound getDb() throws fast — a misrouted replica leg then surfaces as an
// outbox entry instead of a write, which the assertions reject.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// True no-live-DB simulation for the unbound getDb() path: unset the
// import-time env singleton so getDb() throws (was: it would try the .env pool).
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

let recorderHandle: any = null;

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  return {
    ...actual,
    // Every named workspace resolves dual in this suite; the URL is derived
    // from the id so outage-window bookkeeping never crosses tests.
    tierContextFor: async (wsId?: string | null) =>
      wsId
        ? { workspaceId: wsId, databaseUrl: "postgresql://u:p@owning-" + wsId + "/db", storagePreference: "default" as const }
        : { workspaceId: null },
    getWorkspaceDb: async () => ({ db: recorderHandle, source: "workspace" as const }),
  };
});

import { runWithDb } from "../shared/config/database.js";
import { agentRegistry } from "./agent-service.js";
import { localGetAgent, localUpsertAgent } from "./agent-local-store.js";
import { invalidateRosterCache } from "./agent-roster-cache.js";
import { readOutbox } from "../shared/core/outbox.js";
import { agents as agentsTable } from "../db/schema.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-agent-handle-"));
  setLocalStoreDirForTests(dir);
  recorderHandle = null;
  invalidateRosterCache();
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function tableName(table: unknown): string {
  return String((table as any)?.[Symbol.for("drizzle:Name")] ?? "unknown");
}

interface RecorderCalls {
  agentUpdates: Array<Record<string, unknown>>;
  runtimeUpdates: Array<Record<string, unknown>>;
  agentInserts: Array<Record<string, unknown>>;
  runtimeInserts: Array<Record<string, unknown>>;
  agentDeletes: number;
  cascadeDeletes: number;
  transactions: number;
}

function makeRecorder(
  opts: {
    pgRow?: Record<string, unknown>;
    pgRows?: Array<Record<string, unknown>>;
    /** AGT-005: force the runtime_states cascade delete to fail. */
    cascadeDeleteError?: unknown;
    /** AGT-009: module reference validation needs a resolvable model row. */
    modelModuleRow?: Record<string, unknown> | null;
  } = {},
) {
  const calls: RecorderCalls = {
    agentUpdates: [],
    runtimeUpdates: [],
    agentInserts: [],
    runtimeInserts: [],
    agentDeletes: 0,
    cascadeDeletes: 0,
    transactions: 0,
  };
  const db: any = {
    query: {
      agents: {
        findFirst: async () => opts.pgRow ?? null,
        findMany: async () => opts.pgRows ?? [],
      },
      instructionModules: { findFirst: async () => ({ id: "instr-1" }) },
      modelModules: { findFirst: async () => opts.modelModuleRow ?? null },
      toolkitModules: { findFirst: async () => null },
      constraintsModules: { findFirst: async () => null },
      capabilitiesModules: { findFirst: async () => null },
    },
    update(table: unknown) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: async () => {
              const name = tableName(table);
              if (name === "agents") calls.agentUpdates.push(patch);
              if (name === "runtime_states") calls.runtimeUpdates.push(patch);
              return [];
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (vals: Record<string, unknown>) => {
          const name = tableName(table);
          if (name === "agents") calls.agentInserts.push(vals);
          if (name === "runtime_states") calls.runtimeInserts.push(vals);
          return {};
        },
      };
    },
    delete(table: unknown) {
      return {
        where: () => {
          const name = tableName(table);
          if (name === "agents") calls.agentDeletes += 1;
          if (name === "runtime_states") {
            calls.cascadeDeletes += 1;
            if (opts.cascadeDeleteError) return Promise.reject(opts.cascadeDeleteError);
          }
          const rows: unknown[] = [];
          const p: any = Promise.resolve(rows);
          // .returning() is chained on the agents delete; keep both shapes.
          p.returning = async () => rows;
          return p;
        },
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.transactions += 1;
      return fn(db);
    },
  };
  return { db, calls };
}

function baseAgent(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-a",
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
    modelModuleId: null,
    instructionModuleId: "instr-1",
    memorySharingPolicy: "full",
    ...overrides,
  };
}

function pgAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-a",
    name: "pg-agent",
    title: "PG Agent",
    authorityLevel: 1,
    status: "idle",
    isTemplate: false,
    archivedAt: null,
    instructionModuleId: "instr-1",
    modelModuleId: null,
    memorySharingPolicy: "full",
    isOmniscient: false,
    permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
    categoryPermissions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function outboxFor(workspaceId: string) {
  return (await readOutbox()).filter((e) => e.workspaceId === workspaceId);
}

describe("AGT-001 · owning-workspace PG handle for unbound writes/re-reads", () => {
  it("update() lands its replica leg on the owning DB and re-reads the merged row", async () => {
    const { db, calls } = makeRecorder();
    recorderHandle = db;
    await localUpsertAgent(baseAgent({ id: "agent-up" }));

    const updated = await agentRegistry.update("agent-up", { title: "Renamed" }, undefined, "ws-a");

    expect(updated?.title).toBe("Renamed");
    // The PG leg executed against the owning handle (not the throwing ambient pool).
    expect(calls.agentUpdates.some((p) => p.title === "Renamed")).toBe(true);
    expect(calls.transactions).toBeGreaterThanOrEqual(1);
    expect(await outboxFor("ws-a")).toHaveLength(0);
    expect((await localGetAgent("agent-up", "ws-a"))?.title).toBe("Renamed");
  });

  it("socket-scope setStatus() flips the replica row in the owning DB", async () => {
    const { db, calls } = makeRecorder();
    recorderHandle = db;
    await localUpsertAgent(baseAgent({ id: "agent-status" }));

    await agentRegistry.setStatus("agent-status", "working", {});

    expect(calls.agentUpdates.some((p) => p.status === "working")).toBe(true);
    expect(calls.runtimeUpdates.some((p) => p.status === "working")).toBe(true);
    expect(await outboxFor("ws-a")).toHaveLength(0);
    expect((await localGetAgent("agent-status", "ws-a"))?.status).toBe("working");
  });

  it("getById() gap-fill reads the owning handle when the local tier has no row", async () => {
    const { db } = makeRecorder({ pgRow: pgAgentRow({ id: "pg-only", name: "pg-only" }) });
    recorderHandle = db;

    const found = await agentRegistry.getById("pg-only", undefined, "ws-a");

    expect(found?.id).toBe("pg-only");
  });
});

describe("AGT-002 · bound-handle roster merges workspace-scoped local rows", () => {
  it("includes a local-only row of the same workspace and excludes other workspaces' rows", async () => {
    const { db } = makeRecorder({ pgRows: [pgAgentRow({ id: "pg-row", name: "pg-row" })] });
    await localUpsertAgent(baseAgent({ id: "local-only" }));
    await localUpsertAgent(baseAgent({ id: "other-ws", workspaceId: "ws-b" }));

    const roster = await runWithDb(db, async () => agentRegistry.list({ workspaceId: "ws-a" }));
    const ids = roster.map((a) => a.id);
    expect(ids).toContain("pg-row");
    expect(ids).toContain("local-only");
    expect(ids).not.toContain("other-ws");

    // Unscoped filters inside a bound scope stay PG-only: without a named
    // workspace there is no honest way to scope local rows.
    const unscoped = await runWithDb(db, async () => agentRegistry.list({}));
    expect(unscoped.map((a) => a.id)).toEqual(["pg-row"]);
  });
});

describe("AGT-005 · delete() cascade failure propagates (no in-tx swallow)", () => {
  it("rejects the caller when the runtime_states cascade delete fails inside the transaction", async () => {
    const boom = new Error("cascade blew up");
    const { db, calls } = makeRecorder({ cascadeDeleteError: boom });
    recorderHandle = db;

    // Pre-fix the in-tx .catch(console.error) swallowed this: delete()
    // resolved a boolean while the driver aborted the whole transaction
    // (rolling back the agents delete) or left the ledger orphaned.
    await expect(agentRegistry.delete("agent-del", db)).rejects.toThrow("cascade blew up");
    expect(calls.agentDeletes).toBe(1);
    expect(calls.cascadeDeletes).toBe(1);
    expect(calls.transactions).toBe(1);
  });
});

describe("AGT-008 · contextTokenCap persists on the PG tier", () => {
  it("create() writes the column (migration 0027) and the read-back keeps it", async () => {
    // Migration present: schema column + SQL file.
    expect((agentsTable as any).contextTokenCap).toBeDefined();
    const sql = readFileSync(new URL("../db/migrations/0027_agents_context_token_cap.sql", import.meta.url), "utf8");
    expect(sql).toContain("context_token_cap");

    const { db, calls } = makeRecorder({ pgRow: pgAgentRow({ contextTokenCap: 9000 }) });
    recorderHandle = db;

    const created = await agentRegistry.create({ ...baseAgent(), contextTokenCap: 9000 } as any, db);

    // Pre-fix the create row omitted the field: the PG tier dropped it
    // while the local file kept it (dual-tier divergence).
    expect(calls.agentInserts).toHaveLength(1);
    expect(calls.agentInserts[0].contextTokenCap).toBe(9000);
    expect(created.contextTokenCap).toBe(9000);
  });
});

describe("AGT-009 · modelModuleId null clears (both tiers), undefined keeps", () => {
  it("update() clears the reference on null and preserves it on undefined", async () => {
    const { db, calls } = makeRecorder({ modelModuleRow: { id: "mod-x" } });
    recorderHandle = db;
    await localUpsertAgent(baseAgent({ id: "agent-mod", modelModuleId: "mod-x" }));

    // undefined keeps the stored reference (service merge + local mirror).
    await agentRegistry.update("agent-mod", { title: "Keep" }, undefined, "ws-a");
    expect(calls.agentUpdates[calls.agentUpdates.length - 1]?.modelModuleId).toBe("mod-x");
    expect((await localGetAgent("agent-mod", "ws-a"))?.modelModuleId).toBe("mod-x");

    // null is an explicit clear — pre-fix ?? kept the old id on both tiers.
    const cleared = await agentRegistry.update("agent-mod", { modelModuleId: null }, undefined, "ws-a");
    expect(cleared?.modelModuleId).toBeNull();
    expect(calls.agentUpdates[calls.agentUpdates.length - 1]?.modelModuleId).toBeNull();
    expect((await localGetAgent("agent-mod", "ws-a"))?.modelModuleId).toBeNull();
  });
});

describe("AGT-014 · profile updates do not flip runtime presence", () => {
  it("title-only update leaves runtime_states untouched; explicit status still syncs", async () => {
    const { db, calls } = makeRecorder();
    recorderHandle = db;
    await localUpsertAgent(baseAgent({ id: "agent-presence", status: "working" }));

    await agentRegistry.update("agent-presence", { title: "Renamed" }, undefined, "ws-a");
    // Pre-fix every non-offline merged status rewrote runtime_states to idle
    // mid-run; presence belongs to setStatus / an explicit status input.
    expect(calls.runtimeUpdates).toHaveLength(0);
    expect(calls.agentUpdates[calls.agentUpdates.length - 1]?.status).toBe("working");
    expect((await localGetAgent("agent-presence", "ws-a"))?.status).toBe("working");

    await agentRegistry.update("agent-presence", { status: "offline" }, undefined, "ws-a");
    expect(calls.runtimeUpdates).toHaveLength(1);
    expect(calls.runtimeUpdates[0].status).toBe("offline");
  });
});


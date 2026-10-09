// IMPL-AGENTLIST500-001 regression: the explicit-handle roster path
// (`list(filters, dbOverride)` — the ONLY production caller is
// routes/agents.ts passing request.db) must degrade exactly like the bound
// (ALS) path when the tenant PG leg fails (unprovisioned schema / outage,
// 42P01): serve the workspace-scoped local rows instead of rejecting, which
// surfaced as GET /api/agents -> 500 and cleared the client's tenant slices.
//
// Method (agent-dual-handle.test.ts precedent): real database.js, env
// DATABASE_URL unset so a misrouted unbound getDb() throws fast; the fake
// handle throws a drizzle-wrapped 42P01 whose code lives on the cause chain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { agentRegistry } from "./agent-service.js";
import { localUpsertAgent } from "./agent-local-store.js";
import { invalidateRosterCache } from "./agent-roster-cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-agent-list-degrade-"));
  setLocalStoreDirForTests(dir);
  invalidateRosterCache();
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function baseAgent(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-a",
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
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

/** Drizzle wraps driver errors: the SQLSTATE lives on the nested cause. */
function drizzleWrapped42P01(): Error {
  const driverError = Object.assign(new Error('relation "agents" does not exist'), { code: "42P01" });
  return new Error('Failed query: select * from "agents"', { cause: driverError });
}

function failingHandle(): any {
  return {
    query: {
      agents: {
        findMany: async () => {
          throw drizzleWrapped42P01();
        },
      },
    },
  };
}

function workingHandle(pgRows: Array<Record<string, unknown>>): any {
  return {
    query: {
      agents: {
        findMany: async () => pgRows,
      },
    },
  };
}

describe("IMPL-AGENTLIST500-001 · explicit-handle roster degrades like the bound path", () => {
  it("resolves with the workspace's local rows when the tenant handle throws 42P01", async () => {
    await localUpsertAgent(baseAgent({ id: "local-a", name: "local-a" }));
    await localUpsertAgent(baseAgent({ id: "local-b", name: "local-b", authorityLevel: 2 }));

    // Pre-fix this rejected: list() handed the override straight to
    // loadRoster, whose findMany threw and 500'd GET /api/agents.
    const roster = await agentRegistry.list({ workspaceId: "ws-a" }, failingHandle());

    expect(roster.map((a) => a.id)).toEqual(["local-a", "local-b"]);
  });

  it("returns the merged PG+local roster when the handle works", async () => {
    await localUpsertAgent(baseAgent({ id: "local-only", name: "local-only" }));
    const handle = workingHandle([pgAgentRow({ id: "pg-row", name: "pg-row" })]);

    const roster = await agentRegistry.list({ workspaceId: "ws-a" }, handle);

    // Sorted by authorityLevel then name (both L1: "local-only" < "pg-row").
    expect(roster.map((a) => a.id)).toEqual(["local-only", "pg-row"]);
  });

  it("excludes local rows of a different workspace", async () => {
    await localUpsertAgent(baseAgent({ id: "a-row", name: "a-row" }));
    await localUpsertAgent(baseAgent({ id: "b-row", workspaceId: "ws-b", name: "b-row" }));

    const roster = await agentRegistry.list({ workspaceId: "ws-a" }, failingHandle());

    expect(roster.map((a) => a.id)).toEqual(["a-row"]);
  });

  it("keeps unscoped filters PG-only: a failing handle resolves empty, no local fan-out", async () => {
    await localUpsertAgent(baseAgent({ id: "local-a", name: "local-a" }));

    // Contract after the fix (pinned): pgCatchNull swallows the 42P01 and the
    // workspaceId === undefined guard returns the PG rows only (empty here).
    // Without a named workspace there is no honest way to scope local rows.
    const roster = await agentRegistry.list({}, failingHandle());

    expect(roster).toEqual([]);
  });
});

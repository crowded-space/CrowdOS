import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { messageGate } from "./message-gate.js";
import { appendJsonl, localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const tenantDbSeam = vi.hoisted(() => ({
  workspaceId: null as string | null,
  db: null as any,
  ambientDb: null as any,
  channelId: null as string | null,
  channelWorkspaceId: null as string | null,
  getDbCalls: 0,
  dbForWorkspaceCalls: 0,
  localOnlyWorkspaceId: null as string | null,
  localOnlyTier: null as string | null,
}));

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config/database.js")>();
  return {
    ...actual,
    getDb: () => {
      tenantDbSeam.getDbCalls += 1;
      if (tenantDbSeam.ambientDb) return tenantDbSeam.ambientDb;
      return actual.getDb();
    },
    resolveTier: (ctx: { workspaceId?: string | null }) => {
      if (tenantDbSeam.workspaceId && ctx.workspaceId === tenantDbSeam.workspaceId) {
        return { tier: "dual" as const, url: "postgresql://tenant-db/test" };
      }
      const resolved = actual.resolveTier(ctx);
      if (tenantDbSeam.localOnlyWorkspaceId === ctx.workspaceId) tenantDbSeam.localOnlyTier = resolved.tier;
      return resolved;
    },
    dbForWorkspace: async (workspaceId: string) => {
      tenantDbSeam.dbForWorkspaceCalls += 1;
      return tenantDbSeam.workspaceId === workspaceId && tenantDbSeam.db
        ? tenantDbSeam.db
        : actual.dbForWorkspace(workspaceId);
    },
  };
});

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  return {
    ...actual,
    tierContextFor: async (workspaceId?: string | null) =>
      tenantDbSeam.workspaceId === workspaceId
        ? { workspaceId: workspaceId ?? null, databaseUrl: "postgresql://tenant-db/test", storagePreference: "default" }
        : actual.tierContextFor(workspaceId),
    getWorkspaceDb: async (workspaceId: string, opts?: unknown) =>
      tenantDbSeam.workspaceId === workspaceId && tenantDbSeam.db
        ? { db: tenantDbSeam.db, source: "workspace" as const, workspaceId }
        : actual.getWorkspaceDb(workspaceId, opts as any),
  };
});

vi.mock("../channels/channel-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/channel-gate.js")>();
  return {
    ...actual,
    channelGate: {
      ...actual.channelGate,
      get: async (channelId: string) => tenantDbSeam.channelId === channelId
        ? { id: channelId, workspaceId: tenantDbSeam.channelWorkspaceId }
        : actual.channelGate.get(channelId),
    },
  };
});

let storeDir: string;

beforeEach(() => {
  tenantDbSeam.workspaceId = null;
  tenantDbSeam.db = null;
  tenantDbSeam.ambientDb = null;
  tenantDbSeam.channelId = null;
  tenantDbSeam.channelWorkspaceId = null;
  tenantDbSeam.getDbCalls = 0;
  tenantDbSeam.dbForWorkspaceCalls = 0;
  tenantDbSeam.localOnlyWorkspaceId = null;
  tenantDbSeam.localOnlyTier = null;
  storeDir = mkdtempSync(join(tmpdir(), "message-exists-"));
  setLocalStoreDirForTests(storeDir);
});

afterEach(() => {
  tenantDbSeam.workspaceId = null;
  tenantDbSeam.db = null;
  tenantDbSeam.ambientDb = null;
  tenantDbSeam.channelId = null;
  tenantDbSeam.channelWorkspaceId = null;
  tenantDbSeam.getDbCalls = 0;
  tenantDbSeam.dbForWorkspaceCalls = 0;
  tenantDbSeam.localOnlyWorkspaceId = null;
  tenantDbSeam.localOnlyTier = null;
  setLocalStoreDirForTests(null);
  rmSync(storeDir, { recursive: true, force: true });
});

describe("messageGate.existsInChannel", () => {
  it("matches the raw local message id only inside the requested channel and workspace", async () => {
    await appendJsonl("channel-a", { id: "message-a", channelId: "channel-a", workspaceId: null }, null);
    await appendJsonl("channel-b", { id: "message-a", channelId: "channel-b", workspaceId: null }, null);
    await appendJsonl("channel-a", { id: "misfiled-message", channelId: "channel-b", workspaceId: null }, null);
    await appendJsonl("channel-a", { id: "message-in-wrong-workspace", channelId: "channel-a", workspaceId: "ws-b" }, "ws-a");
    await appendJsonl("channel-a", { id: "message-a", channelId: "channel-a", workspaceId: "ws-a" }, "ws-a");
    await appendJsonl("channel-a", { id: "legacy-workspace-message", channelId: "channel-a", workspaceId: null }, "ws-a");

    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: null })).toBe(true);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: "default" })).toBe(true);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-b", workspaceId: null })).toBe(true);
    expect(await messageGate.existsInChannel("misfiled-message", { channelId: "channel-a", workspaceId: null })).toBe(false);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: "ws-a" })).toBe(true);
    expect(await messageGate.existsInChannel("legacy-workspace-message", { channelId: "channel-a", workspaceId: "ws-a" })).toBe(true);
    expect(await messageGate.existsInChannel("legacy-workspace-message", { channelId: "channel-a", workspaceId: "ws-b" })).toBe(false);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: "ws-b" })).toBe(false);
    expect(await messageGate.existsInChannel("message-in-wrong-workspace", { channelId: "channel-a", workspaceId: "ws-a" })).toBe(false);
    expect(await messageGate.existsInChannel("missing", { channelId: "channel-a", workspaceId: null })).toBe(false);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-missing", workspaceId: null })).toBe(false);
  });

  it("uses the explicit database handle and predicates on id, channel, and workspace", async () => {
    const selected: unknown[] = [];
    const db = {
      query: {
        messages: {
          findFirst: async ({ where }: { where: unknown }) => {
            const query = new PgDialect().sqlToQuery(where as any);
            selected.push(query);
            const params = query.params;
            return params.includes("message-a") && params.includes("channel-a") && params.includes("ws-a")
              ? { id: "message-a", channelId: "channel-a", workspaceId: "ws-a" }
              : undefined;
          },
        },
      },
    };

    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: "ws-a", db })).toBe(true);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-b", workspaceId: "ws-a", db })).toBe(false);
    expect(await messageGate.existsInChannel("message-a", { channelId: "channel-a", workspaceId: "ws-b", db })).toBe(false);

    const sql = (selected[0] as { sql: string }).sql;
    expect(sql).toContain('"messages"."id"');
    expect(sql).toContain('"messages"."channel_id"');
    expect(sql).toContain('"messages"."workspace_id"');
  });

  it("treats null and default as the same workspace in database rows", async () => {
    const dbFor = (workspaceId: string | null) => ({
      query: {
        messages: {
          findFirst: async ({ where }: { where: unknown }) => {
            const query = new PgDialect().sqlToQuery(where as any);
            const workspaceClause = query.sql.slice(query.sql.indexOf('"messages"."workspace_id"'));
            const hasDefaultAlias = workspaceClause.toLowerCase().includes("is null") && query.params.includes("default");
            return query.params.includes("message-default") && query.params.includes("channel-default") &&
              hasDefaultAlias && (workspaceId === null || workspaceId === "default")
              ? { id: "message-default", channelId: "channel-default", workspaceId }
              : undefined;
          },
        },
      },
    });

    expect(await messageGate.existsInChannel("message-default", { channelId: "channel-default", workspaceId: "default", db: dbFor(null) })).toBe(true);
    expect(await messageGate.existsInChannel("message-default", { channelId: "channel-default", workspaceId: null, db: dbFor("default") })).toBe(true);
  });

  it("uses the resolved workspace database to find legacy rows with null workspace_id", async () => {
    const db = {
      query: {
        messages: {
          findFirst: async ({ where }: { where: unknown }) => {
            const query = new PgDialect().sqlToQuery(where as any);
            const workspaceClause = query.sql.slice(query.sql.indexOf('"messages"."workspace_id"')).toLowerCase();
            return query.params.includes("legacy-message") && query.params.includes("channel-legacy") &&
              workspaceClause.includes("is null") && query.params.includes("ws-legacy")
              ? { id: "legacy-message", channelId: "channel-legacy", workspaceId: null }
              : undefined;
          },
        },
      },
    };

    tenantDbSeam.workspaceId = "ws-legacy";
    tenantDbSeam.db = db;

    expect(await messageGate.existsInChannel("legacy-message", { channelId: "channel-legacy", workspaceId: "ws-legacy" })).toBe(true);
  });

  it("does not assign a shared-override legacy null row to an arbitrary workspace", async () => {
    const originalOverride = process.env.CROWDOS_LOCALSTORE_DIR;
    const sharedDir = mkdtempSync(join(tmpdir(), "message-exists-shared-"));
    const workspaceId = `ws-shared-${Date.now()}`;
    process.env.CROWDOS_LOCALSTORE_DIR = sharedDir;
    setLocalStoreDirForTests(null);

    try {
      await appendJsonl("channel-shared", { id: "legacy-null", channelId: "channel-shared", workspaceId: null }, workspaceId);
      await appendJsonl("channel-shared", { id: "explicit-owner", channelId: "channel-shared", workspaceId }, workspaceId);

      expect(await messageGate.existsInChannel("legacy-null", { channelId: "channel-shared", workspaceId })).toBe(false);
      expect(await messageGate.existsInChannel("explicit-owner", { channelId: "channel-shared", workspaceId })).toBe(true);
      expect(await messageGate.existsInChannel("legacy-null", { channelId: "channel-shared", workspaceId: null })).toBe(true);
    } finally {
      setLocalStoreDirForTests(storeDir);
      if (originalOverride === undefined) delete process.env.CROWDOS_LOCALSTORE_DIR;
      else process.env.CROWDOS_LOCALSTORE_DIR = originalOverride;
      rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  it("returns a Local hit without querying the tenant database", async () => {
    const workspaceId = "ws-local-hit";
    await appendJsonl("channel-local-hit", { id: "local-message", channelId: "channel-local-hit", workspaceId }, workspaceId);
    tenantDbSeam.workspaceId = workspaceId;
    tenantDbSeam.db = { query: { messages: { findFirst: async () => { throw new Error("database should not be queried"); } } } };

    expect(await messageGate.existsInChannel("local-message", { channelId: "channel-local-hit", workspaceId })).toBe(true);
    expect(tenantDbSeam.getDbCalls).toBe(0);
  });

  it("does not query the ambient database for a Local-only workspace miss", async () => {
    const workspaceId = `ws-local-only-${Date.now()}`;
    const configuredDatabaseUrl = (env as any).DATABASE_URL;
    const processDatabaseUrl = process.env.DATABASE_URL;
    const globalDatabaseUrl = "postgresql://global-only/test";
    tenantDbSeam.localOnlyWorkspaceId = workspaceId;
    (env as any).DATABASE_URL = globalDatabaseUrl;
    process.env.DATABASE_URL = globalDatabaseUrl;

    try {
      expect((env as any).DATABASE_URL).toBe(globalDatabaseUrl);
      expect(await messageGate.existsInChannel("missing-local", { channelId: "channel-local-only", workspaceId })).toBe(false);
      expect(tenantDbSeam.localOnlyTier).toBe("local");
      expect(tenantDbSeam.dbForWorkspaceCalls).toBe(0);
      expect(tenantDbSeam.getDbCalls).toBe(0);
    } finally {
      (env as any).DATABASE_URL = configuredDatabaseUrl;
      if (processDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = processDatabaseUrl;
    }
  });

  it("propagates local JSONL read failures", async () => {
    const messageFileDirectory = join(localStoreDirsForTests("ws-io").crowdos, "messages", "broken-channel.jsonl");
    mkdirSync(messageFileDirectory, { recursive: true });

    await expect(
      messageGate.existsInChannel("message-io", { channelId: "broken-channel", workspaceId: "ws-io" }),
    ).rejects.toThrow();
  });

  it("propagates explicit database read failures", async () => {
    const failure = new Error("database read failed");
    const db = { query: { messages: { findFirst: async () => { throw failure; } } } };

    await expect(
      messageGate.existsInChannel("message-db", { channelId: "channel-db", workspaceId: "ws-db", db }),
    ).rejects.toBe(failure);
  });
});

describe("messageGate.listRecent", () => {
  it("fills an empty Local result from the channel workspace database", async () => {
    const workspaceId = `ws-list-recent-${Date.now()}`;
    const channelId = `channel-list-recent-${Date.now()}`;
    const tenantRows = [{ id: "tenant-message", channelId, workspaceId, sequenceNumber: 7, timestamp: new Date("2026-01-01T00:00:00.000Z") }];
    const ambientRows = [{ id: "ambient-message", channelId, workspaceId, sequenceNumber: 8, timestamp: new Date("2026-01-02T00:00:00.000Z") }];
    tenantDbSeam.workspaceId = workspaceId;
    tenantDbSeam.channelId = channelId;
    tenantDbSeam.channelWorkspaceId = workspaceId;
    tenantDbSeam.db = { query: { messages: { findMany: async () => tenantRows } } };
    tenantDbSeam.ambientDb = { query: { messages: { findMany: async () => ambientRows } } };

    expect(await messageGate.listRecent(channelId, 5)).toEqual(tenantRows);
  });
});

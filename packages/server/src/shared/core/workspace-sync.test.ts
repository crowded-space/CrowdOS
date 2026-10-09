// Dual-boot pairing + outbox + tier matrix. No PG: tenant handles are faked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "./local-file.js";
import { resolveTier, isConnectionError, noteDbFailure, noteDbSuccess } from "../config/database.js";
import { env } from "../config/env.js";

vi.mock("../../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workspace/workspace-gate.js")>();
  const records = new Map<string, any>();
  const fakeDb = {
    query: {
      workspaces: { findMany: async () => fakeDbWorkspaceRows.map((r) => ({ id: r })) },
      categories: { findMany: async () => [] },
      channels: { findMany: async () => [] },
      agents: { findMany: async () => [] },
      messages: { findMany: async () => [] },
    },
    insert: () => ({ values: async () => ({ onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  };
  return {
    ...actual,
    getWorkspaceRecord: async (id: string) => records.get(id) ?? null,
    saveWorkspaceRecord: async (record: any) => {
      records.set(record.id, { ...record });
      return record;
    },
    listWorkspaceRecords: async () => [...records.values()],
    getWorkspaceDb: async () => ({ db: fakeDb, source: "workspace" as const }),
    closeWorkspaceDatabase: async () => {},
    tierContextFor: async (wsId?: string | null) => {
      if (!wsId) return { workspaceId: null };
      const rec = records.get(wsId);
      if (!rec) return { workspaceId: wsId };
      return {
        workspaceId: wsId,
        databaseUrl: rec.databaseUrl?.trim() || null,
        storagePreference: rec.storagePreference === "local" ? "local" : "default",
      };
    },
    __testRegistry: records,
  };
});

let fakeDbWorkspaceRows: string[] = [];

import {
  evaluateDbPairing,
  drainOutbox,
  outboxBacklog,
} from "./workspace-sync.js";
import { appendOutbox, readOutbox } from "./outbox.js";
import { dualWrite } from "../config/database.js";
import { localCreateCategory } from "../../channels/channel-local-store.js";

let dir: string;

async function seedRecord(id: string, fields: Record<string, unknown> = {}) {
  const gate = await import("../../workspace/workspace-gate.js") as any;
  await gate.saveWorkspaceRecord({
    id,
    name: id,
    icon: "💼",
    databaseUrl: "",
    rootPath: join(dir, id),
    screenLockPinHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-sync-"));
  setLocalStoreDirForTests(dir);
  fakeDbWorkspaceRows = [];
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("tier resolution matrix", () => {
  it("prefers local when forced, even with a URL", () => {
    expect(resolveTier({ storagePreference: "local", databaseUrl: "postgresql://u:p@h/db" }).tier).toBe("local");
  });
  it("is local with no URL anywhere", () => {
    // env singleton is import-time; override it to simulate a DB-less boot.
    const prev = env.DATABASE_URL;
    (env as any).DATABASE_URL = undefined;
    try {
      expect(resolveTier({}).tier).toBe("local");
    } finally {
      (env as any).DATABASE_URL = prev;
    }
  });
  it("ignores the process-wide URL for workspace tier selection", () => {
    // Even with the global DATABASE_URL set, an empty workspace context has
    // no assigned workspace URL and resolves local.
    const prev = env.DATABASE_URL;
    (env as any).DATABASE_URL = "postgresql://env:u@localhost:5432/predetermined";
    try {
      expect(resolveTier({}).tier).toBe("local");
      expect(resolveTier({ workspaceId: null }).tier).toBe("local");
      expect(resolveTier({ workspaceId: "ws-1", databaseUrl: "postgresql://u:p@h/db" }).tier).toBe("dual");
    } finally {
      (env as any).DATABASE_URL = prev;
    }
  });
  it("outage windows flip reachable URLs to local, success clears", () => {
    const url = "postgresql://u:p@down-host/db";
    expect(resolveTier({ databaseUrl: url }).tier).toBe("dual");
    noteDbFailure(url, Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(resolveTier({ databaseUrl: url }).tier).toBe("local");
    noteDbSuccess(url);
    expect(resolveTier({ databaseUrl: url }).tier).toBe("dual");
  });
  it("classifies connection errors vs logic errors", () => {
    expect(isConnectionError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isConnectionError(new Error("DATABASE_URL is not set"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("NO_DATABASE: workspace ws-1 has no databaseUrl"), { code: "NO_DATABASE" }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("null value in column"), { code: "23502" }))).toBe(false);
    expect(isConnectionError(new Error("boom"))).toBe(false);
    // Drizzle wraps driver failures: the real code sits on `cause`, and the
    // wrapper carries no code of its own. Inspecting only the top level
    // misclassified every wrapped outage as a logic error.
    expect(
      isConnectionError(
        Object.assign(new Error("Failed query: select 1"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
        }),
      ),
    ).toBe(true);
    expect(
      isConnectionError(
        Object.assign(new Error("Failed query: select 1"), {
          cause: Object.assign(new Error("null value in column"), { code: "23502" }),
        }),
      ),
    ).toBe(false);
    // Bounded walk: a self-referential chain must terminate, not spin.
    const looped: { message: string; cause?: unknown } = { message: "looped" };
    looped.cause = looped;
    expect(isConnectionError(looped)).toBe(false);
  });
});

describe("outbox round-trip", () => {
  it("appends, reads oldest-first, removes by id", async () => {
    await appendOutbox({ workspaceId: "ws-1", entity: "channel", op: "upsert", rowId: "c1", row: { id: "c1" } });
    await appendOutbox({ workspaceId: "ws-1", entity: "channel", op: "delete", rowId: "c2", row: null });
    const rows = await readOutbox(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].rowId).toBe("c1");
    const { removeOutboxIds } = await import("./outbox.js");
    await removeOutboxIds([rows[0].id]);
    expect(await readOutbox(10)).toHaveLength(1);
  });
});

describe("dualWrite", () => {
  // ponytail: unavailability flags are process-global — distinct URLs per
  // test plus cleanup, or outage windows leak across tests.
  const urls = new Set<string>();
  const track = (url: string) => {
    urls.add(url);
    return url;
  };
  afterEach(() => {
    for (const url of urls) noteDbSuccess(url);
    urls.clear();
  });

  it("forced-local writes files and queues when a DB exists", async () => {
    let pgCalls = 0;
    let localCalls = 0;
    await dualWrite({
      ctx: { workspaceId: "ws-1", databaseUrl: track("postgresql://u:p@h1/db"), storagePreference: "local" },
      entity: "channel",
      op: "upsert",
      id: "c9",
      row: { id: "c9" },
      pgWrite: async () => { pgCalls++; },
      localWrite: async () => { localCalls++; return "local-row" as any; },
    });
    expect(pgCalls).toBe(0);
    expect(localCalls).toBe(1);
    expect(await outboxBacklog("ws-1")).toBe(1);
  });

  it("dual mode writes both tiers with no queue", async () => {
    let pgCalls = 0;
    await dualWrite({
      ctx: { workspaceId: "ws-1", databaseUrl: track("postgresql://u:p@h2/db"), storagePreference: "default" },
      entity: "channel",
      op: "upsert",
      id: "c9",
      row: { id: "c9" },
      pgWrite: async () => { pgCalls++; },
      localWrite: async () => "local-row" as any,
    });
    expect(pgCalls).toBe(1);
    expect(await outboxBacklog("ws-1")).toBe(0);
  });

  it("connection failure degrades to local plus queue", async () => {
    await dualWrite({
      ctx: { workspaceId: "ws-1", databaseUrl: track("postgresql://u:p@h3/db"), storagePreference: "default" },
      entity: "channel",
      op: "upsert",
      id: "c9",
      row: { id: "c9" },
      pgWrite: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
      localWrite: async () => "local-row" as any,
    });
    expect(await outboxBacklog("ws-1")).toBe(1);
  });

  // §17 local-first: local is the COMMIT POINT, so a replica-leg failure of ANY
  // class (connection or logic) cannot fail a write that already committed.
  // The previous PG-first order surfaced a committed local row as a caller
  // error — the divergence class this inversion exists to remove.
  it("replica-leg logic errors do not fail an already-committed local write", async () => {
    let localCalls = 0;
    const result = await dualWrite({
      ctx: { workspaceId: "ws-1", databaseUrl: track("postgresql://u:p@h4/db"), storagePreference: "default" },
      entity: "channel",
      op: "upsert",
      id: "c9",
      row: { id: "c9" },
      pgWrite: async () => { throw Object.assign(new Error("null value"), { code: "23502" }); },
      localWrite: async () => { localCalls++; return "x" as any; },
    });
    expect(result).toBe("x");
    expect(localCalls).toBe(1);
    // Replica lag is queued for replay (poison entries are dropped by drain).
    expect(await outboxBacklog("ws-1")).toBe(1);
  });

  // The new invariant the inversion introduces: a local (truth-tier) failure is
  // fatal and the replica must never be written from a write that did not commit.
  it("local failures propagate and never touch the replica", async () => {
    let pgCalls = 0;
    await expect(
      dualWrite({
        ctx: { workspaceId: "ws-1", databaseUrl: track("postgresql://u:p@h5/db"), storagePreference: "default" },
        entity: "channel",
        op: "upsert",
        id: "c9",
        row: { id: "c9" },
        pgWrite: async () => { pgCalls++; },
        localWrite: async () => { throw new Error("local disk full"); },
      }),
    ).rejects.toThrow("local disk full");
    expect(pgCalls).toBe(0);
    expect(await outboxBacklog("ws-1")).toBe(0);
  });
});

describe("evaluateDbPairing", () => {
  it("no-database record short-circuits", async () => {
    await seedRecord("ws-nodb");
    expect(await evaluateDbPairing("ws-nodb")).toMatchObject({ action: "no-database" });
  });

  it("fresh database plus empty local pairs", async () => {
    await seedRecord("ws-fresh", { databaseUrl: "postgresql://u:p@h/db" });
    const res = await evaluateDbPairing("ws-fresh");
    expect(res.action).toBe("paired");
  });

  it("unrelated database content quarantines to conflict and keeps serving local", async () => {
    await seedRecord("ws-mine", { databaseUrl: "postgresql://u:p@h/db" });
    await localCreateCategory({ name: "General", workspaceId: "ws-mine", createdBy: "system", position: 0 });
    fakeDbWorkspaceRows = ["ws-stranger"];
    const res = await evaluateDbPairing("ws-mine");
    expect(res.action).toBe("conflict");
    // Drain must refuse while quarantined: entry stays pending.
    await appendOutbox({ workspaceId: "ws-mine", entity: "channel", op: "upsert", rowId: "cx", row: { id: "cx" } });
    const drain = await drainOutbox("ws-mine");
    expect(drain.replayed).toBe(0);
    expect(await outboxBacklog("ws-mine")).toBe(1);
  });
});

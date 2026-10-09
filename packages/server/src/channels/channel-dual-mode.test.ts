// Dual-mode (PG + local) regressions for the fix-channels batch:
//   CHN-003  archived names are reusable on BOTH tiers (local + PG dup scans)
//   CHN-032  settings writes commit local-first (PG second) via dualWrite
//   CHN-008  a dead PG queues a channelSettings outbox entry instead of losing the pin
//   CHN-009  settings replay + push + pull legs exist in workspace-sync
//   CHN-033  a local guard-failure union never reaches the PG replica leg
//
// Method: the real database.js (dualWrite/outbox) runs; the workspace gate is
// faked so a workspace resolves to "dual" without a live Postgres, and a
// recording handle is bound through runWithDb for the PG leg.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";
import { channelSettings as channelSettingsTable, channels as channelsTable } from "../db/schema.js";

// True no-live-DB simulation for the UNBOUND getDb() path: unset the import-time
// env singleton so getDb() throws fast (was: it would try the .env pool).
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  const records = new Map<string, any>();
  return {
    ...actual,
    getWorkspaceRecord: async (id: string) => records.get(id) ?? null,
    getWorkspaceDb: async () => ({ db: fakeDbHandle, source: "workspace" as const }),
    // Every named workspace resolves dual in this suite; the URL is derived
    // from the id so outage-window bookkeeping never crosses tests.
    tierContextFor: async (wsId?: string | null) =>
      wsId
        ? { workspaceId: wsId, databaseUrl: urlFor(wsId), storagePreference: "default" as const }
        : { workspaceId: null },
    __testRecords: records,
  };
});

let fakeDbHandle: any = null;
const urlFor = (wsId: string) => `postgresql://u:p@dual-${wsId}/db`;

import { channelGate } from "./channel-gate.js";
import {
  localCreateChannel,
  localGetChannelSettings,
  localUpdateChannel,
} from "./channel-local-store.js";
import { dualWrite, noteDbSuccess, runWithDb } from "../shared/config/database.js";
import { appendOutbox, readOutbox } from "../shared/core/outbox.js";
import { drainOutbox, outboxBacklog, pullWorkspaceFromDb, pushWorkspaceToDb } from "../shared/core/workspace-sync.js";

let dir: string;
const trackedUrls = new Set<string>();

function seedLocalChannelRows(workspaceId: string, rows: any[]): void {
  const { crowdos } = localStoreDirsForTests(workspaceId);
  mkdirSync(crowdos, { recursive: true });
  writeFileSync(join(crowdos, "channels.json"), JSON.stringify(rows), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-dualmode-"));
  setLocalStoreDirForTests(dir);
  fakeDbHandle = null;
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

afterEach(() => {
  for (const url of trackedUrls) noteDbSuccess(url);
  trackedUrls.clear();
});

function tableName(table: unknown): string {
  return String((table as any)?.[Symbol.for("drizzle:Name")] ?? "unknown");
}

interface WriteCall {
  table: string;
  row: any;
  set?: any;
}

interface QueryCapture {
  table: string;
  sql: string;
  params: unknown[];
  limit?: number;
  offset?: number;
}

interface RecorderDb {
  calls: WriteCall[];
  queries: QueryCapture[];
  query: Record<string, unknown>;
  insert: (table: unknown) => { values: (row: any) => any };
  delete: () => { where: () => Promise<void> };
  update: () => { set: () => { where: () => Promise<void> } };
}

const dialect = new PgDialect();

/** Run a drizzle where-callback with the real operators and capture its SQL. */
function captureWhere(cb: unknown, table: unknown): { sql: string; params: unknown[] } | null {
  if (typeof cb !== "function") return null;
  try {
    const expr = (cb as any)(table, { and, eq, isNull, sql });
    const q = dialect.sqlToQuery(expr as never);
    return { sql: q.sql, params: (q.params ?? []) as unknown[] };
  } catch {
    return null;
  }
}

function captureExpression(expression: unknown): { sql: string; params: unknown[] } | null {
  if (!expression) return null;
  try {
    const q = dialect.sqlToQuery(expression as never);
    return { sql: q.sql, params: (q.params ?? []) as unknown[] };
  } catch {
    return null;
  }
}

function makeRecorder(fixtures: {
  channels?: any[];
  channelList?: (opts: any) => any[] | Promise<any[]>;
  categories?: any[];
  settings?: any[];
  messages?: any[];
  /** Row a channels.findFirst returns (simulates a PG-side live duplicate). */
  channelFindFirst?: any;
  /** Row a channelSettings.findFirst returns (PG-side existing pin). */
  settingFindFirst?: any;
  onWrite?: (call: WriteCall) => Promise<void> | void;
} = {}): RecorderDb {
  const calls: WriteCall[] = [];
  const queries: QueryCapture[] = [];
  const db: RecorderDb = {
    calls,
    queries,
    query: {
      channels: {
        findFirst: async (opts: any = {}) => {
          const captured = captureWhere(opts.where, channelsTable);
          if (captured) queries.push({ table: "channels", ...captured });
          return fixtures.channelFindFirst ?? null;
        },
        findMany: async (opts: any = {}) => {
          const captured = captureExpression(opts.where);
          if (captured) queries.push({
            table: "channels",
            ...captured,
            limit: opts.limit,
            offset: opts.offset,
          });
          return fixtures.channelList ? fixtures.channelList(opts) : fixtures.channels ?? [];
        },
      },
      categories: { findFirst: async () => null, findMany: async () => fixtures.categories ?? [] },
      agents: { findMany: async () => [] },
      messages: { findMany: async () => fixtures.messages ?? [] },
      channelSettings: {
        findFirst: async (opts: any = {}) => {
          const captured = captureWhere(opts.where, channelSettingsTable);
          if (captured) queries.push({ table: "channel_settings", ...captured });
          return fixtures.settingFindFirst ?? null;
        },
        findMany: async () => fixtures.settings ?? [],
      },
    },
    insert(table: any) {
      return {
        values: (row: any) => {
          let recorded: Promise<void> | null = null;
          const record = (set?: any): Promise<void> => {
            if (!recorded) {
              const call = { table: tableName(table), row, set };
              calls.push(call);
              recorded = Promise.resolve(fixtures.onWrite?.(call)).then(() => undefined);
            }
            return recorded;
          };
          // Thenable: a plain awaited insert works, and the conflict arms
          // record the same single logical write.
          return {
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              record().then(resolve, reject),
            onConflictDoUpdate: ({ set }: any) => record(set),
            onConflictDoNothing: () => record(),
          };
        },
      };
    },
    delete: () => ({ where: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  return db;
}

function makeChannelListRecorder(
  rows: any[],
  localIds: readonly string[],
  afterPosition = Number.NEGATIVE_INFINITY,
): RecorderDb {
  const localIdSet = new Set(localIds);
  return makeRecorder({
    channelList: async (opts) => {
      const query = dialect.sqlToQuery(opts.where as never);
      const excludedIds = new Set(
        query.sql.toLowerCase().includes(" not in ")
          ? (query.params ?? []).filter((value): value is string =>
              typeof value === "string" && localIdSet.has(value),
            )
          : [],
      );
      let cursorPosition = afterPosition;
      let cursorId = "";
      const params = query.params ?? [];
      const positionIndex = params.length - 2;
      if (typeof params[positionIndex] === "number" && typeof params[positionIndex + 1] === "string") {
        cursorPosition = params[positionIndex] as number;
        cursorId = params[positionIndex + 1] as string;
      }
      return rows
        .filter((row) =>
          row.position > cursorPosition || (row.position === cursorPosition && row.id > cursorId),
        )
        .filter((row) => !excludedIds.has(row.id))
        .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
        .slice(0, opts.limit);
    },
  });
}

// ─── CHN-003 + CHN-033: archived recreate + guard-failure PG skip ───────
describe("dual-mode create: archived names + guard-failure union (CHN-003/033)", () => {
  it("PG dup guard skips archived rows and lowercases BOTH sides (CHN-002/003)", async () => {
    const ws = "ws-pgsql";
    trackedUrls.add(urlFor(ws));
    const recorder = makeRecorder();
    fakeDbHandle = recorder;

    const created = await runWithDb(recorder as any, () =>
      channelGate.create({ name: "MixedCase", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any, undefined, ws),
    );
    expect("channel" in (created as any)).toBe(true);

    const dupQueries = recorder.queries.filter((q: QueryCapture) => q.table === "channels");
    expect(dupQueries.length).toBeGreaterThan(0);
    const sqlText = dupQueries[0].sql;
    // CHN-002: both sides lowered.
    expect(sqlText).toContain("lower(");
    expect(dupQueries[0].params).toContain("mixedcase");
    // CHN-003: archived rows excluded from the duplicate scan.
    expect(sqlText).toContain('"archived_at" is null');
    // §30: the scan is scoped to the creating workspace.
    expect(sqlText).toContain('"workspace_id" = ');
  });

  it("recreate after archive succeeds locally AND replicates to PG (no phantom, no error)", async () => {
    const ws = "ws-recreate";
    trackedUrls.add(urlFor(ws));
    // Seed the archived row directly in the local tier.
    const old = await localCreateChannel({ name: "temp", type: "standard", createdBy: "system", categoryId: null, workspaceId: ws, position: 0 });
    await localUpdateChannel(old.channel.id, { type: "archived" });

    const recorder = makeRecorder();
    fakeDbHandle = recorder;
    const created = await runWithDb(recorder as any, () =>
      channelGate.create({ name: "temp", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any, undefined, ws),
    );

    // CHN-003: the archived name is reusable — the create is a real channel.
    expect("channel" in (created as any)).toBe(true);
    // CHN-033: exactly one PG insert (the new row), none for the rejected path.
    const channelWrites = recorder.calls.filter((c: WriteCall) => c.table === "channels");
    expect(channelWrites).toHaveLength(1);
    expect(channelWrites[0].row.id).toBe((created as any).channel.id);
    // No phantom: the archived row's id was never re-inserted.
    expect(channelWrites[0].row.id).not.toBe(old.channel.id);
    // Local tier holds exactly one live row with the name.
    const live = await channelGate.list({ workspaceId: ws });
    expect(live.filter((c: any) => c.name === "temp")).toHaveLength(1);
  });

  it("a local guard-failure union aborts the PG leg and queues nothing (CHN-033)", async () => {
    const ws = "ws-guard";
    trackedUrls.add(urlFor(ws));
    await localCreateChannel({ name: "dup", type: "standard", createdBy: "system", categoryId: null, workspaceId: ws, position: 0 });

    const recorder = makeRecorder();
    fakeDbHandle = recorder;
    let pgCalls = 0;
    const result = await runWithDb(recorder as any, () =>
      dualWrite({
        ctx: { workspaceId: ws, databaseUrl: urlFor(ws), storagePreference: "default" },
        entity: "channel",
        op: "upsert",
        id: "new-id",
        row: { id: "new-id" },
        pgWrite: async () => { pgCalls++; },
        // The REAL local create sees the live dup and returns its union.
        localWrite: () => localCreateChannel({ id: "new-id", name: "dup", type: "standard", createdBy: "system", categoryId: null, workspaceId: ws, position: 0 }),
      }),
    );

    expect((result as any).error).toBe("duplicate_name");
    expect(pgCalls).toBe(0);
    expect(await outboxBacklog(ws)).toBe(0);
  });
});

// ─── CHN-032 extra: partial patches never null unspecified PG pins ──────
describe("settings partial-patch merge (CHN-032)", () => {
  it("a single-pin patch leaves the other pins untouched in PG", async () => {
    const ws = "ws-partial";
    trackedUrls.add(urlFor(ws));
    const recorder = makeRecorder({
      settingFindFirst: { channelId: "ch-partial", workspaceId: ws, pinnedRuntime: "coding", activeAgentId: "agent-owl", defaultAgentId: "agent-raven" },
    });
    fakeDbHandle = recorder;

    await runWithDb(recorder as any, () =>
      channelGate.updateSettings("ch-partial", { activeAgentId: "agent-new" }, undefined, ws),
    );

    const write = recorder.calls.find((c: WriteCall) => c.table === "channel_settings");
    expect(write?.set).toMatchObject({ activeAgentId: "agent-new" });
    // Unspecified pins are absent from the PG set (never nulled).
    expect(write?.set).not.toHaveProperty("pinnedRuntime");
    expect(write?.set).not.toHaveProperty("defaultAgentId");
  });
});

// ─── CHN-032: settings local-first ordering ─────────────────────────────
describe("settings write order (CHN-032)", () => {
  it("commits locally BEFORE the PG replica leg runs", async () => {
    const ws = "ws-order";
    trackedUrls.add(urlFor(ws));
    let localAtPgTime: any = "unset";
    const recorder = makeRecorder({
      onWrite: async (call) => {
        if (call.table === "channel_settings") {
          // Probe the local tier at the exact moment the PG leg executes.
          localAtPgTime = await localGetChannelSettings("ch-order", ws);
        }
      },
    });
    fakeDbHandle = recorder;

    const result = await runWithDb(recorder as any, () =>
      channelGate.updateSettings("ch-order", { pinnedRuntime: "coding" }, undefined, ws),
    );

    expect("settings" in (result as any)).toBe(true);
    expect(localAtPgTime?.pinnedRuntime).toBe("coding");
    expect(recorder.calls.some((c: WriteCall) => c.table === "channel_settings")).toBe(true);
    expect(await outboxBacklog(ws)).toBe(0);
  });
});

// ─── CHN-008: PG failure queues a settings outbox entry ─────────────────
describe("settings durability on PG outage (CHN-008)", () => {
  it("keeps the local pin and enqueues a channelSettings outbox row when PG is dead", async () => {
    const ws = "ws-outage";
    trackedUrls.add(urlFor(ws));
    // No bound handle: getDb() throws (no DATABASE_URL), so the PG leg fails.
    const result = await channelGate.updateSettings("ch-outage", { pinnedRuntime: "research" }, undefined, ws);

    expect("settings" in (result as any)).toBe(true);
    expect((result as any).settings.pinnedRuntime).toBe("research");
    expect((await localGetChannelSettings("ch-outage", ws))?.pinnedRuntime).toBe("research");

    const entries = (await readOutbox(10)).filter((e) => e.workspaceId === ws);
    expect(entries).toHaveLength(1);
    expect(entries[0].entity).toBe("channelSettings");
    expect(entries[0].rowId).toBe("ch-outage");
    expect((entries[0].row as any)?.pinnedRuntime).toBe("research");
  });
});

// ─── CHN-009: settings replay + push + pull legs ────────────────────────
describe("settings sync legs (CHN-009)", () => {
  it("drainOutbox replays a channelSettings entry into PG", async () => {
    const ws = "ws-replay";
    const url = urlFor(ws);
    trackedUrls.add(url);
    noteDbSuccess(url);
    await appendOutbox({
      workspaceId: ws,
      entity: "channelSettings",
      op: "upsert",
      rowId: "ch-replay",
      row: { channelId: "ch-replay", workspaceId: ws, pinnedRuntime: "coding", activeAgentId: "agent-owl", defaultAgentId: null, updatedAt: new Date().toISOString() },
    });

    const recorder = makeRecorder();
    fakeDbHandle = recorder;
    const drain = await drainOutbox(ws);
    expect(drain.replayed).toBe(1);
    expect(drain.pending).toBe(0);
    const write = recorder.calls.find((c: WriteCall) => c.table === "channel_settings");
    expect(write?.row).toMatchObject({ channelId: "ch-replay", workspaceId: ws, pinnedRuntime: "coding", activeAgentId: "agent-owl" });
    expect(write?.set).toMatchObject({ pinnedRuntime: "coding", activeAgentId: "agent-owl" });
  });

  it("pushWorkspaceToDb pushes local settings pins for this workspace's channels", async () => {
    const ws = "ws-push";
    const cat = await channelGate.createCategory({ name: "General", workspaceId: ws, createdBy: "system" });
    const created = await localCreateChannel({ name: "general", type: "standard", createdBy: "system", categoryId: cat.id, workspaceId: ws, position: 0 });
    await channelGate.updateSettings(created.channel.id, { pinnedRuntime: "agentic", defaultAgentId: "agent-raven" }, undefined, ws);

    const recorder = makeRecorder();
    fakeDbHandle = recorder;
    const counts = await pushWorkspaceToDb(ws);

    expect(counts.settings).toBe(1);
    const write = recorder.calls.find((c: WriteCall) => c.table === "channel_settings");
    expect(write?.row).toMatchObject({ channelId: created.channel.id, workspaceId: ws, pinnedRuntime: "agentic", defaultAgentId: "agent-raven" });
  });

  it("pullWorkspaceFromDb restores settings pins into the local store", async () => {
    const ws = "ws-pull";
    const recorder = makeRecorder({
      channels: [{ id: "ch-pull", categoryId: null, workspaceId: ws, folderPath: null, name: "general", type: "standard", createdBy: "system", position: 0, createdAt: new Date(), archivedAt: null, archivedReason: null }],
      settings: [{ channelId: "ch-pull", workspaceId: ws, pinnedRuntime: "swarm", activeAgentId: null, defaultAgentId: "agent-raven", updatedAt: new Date() }],
    });
    fakeDbHandle = recorder;

    const counts = await pullWorkspaceFromDb(ws, { force: true });
    expect(counts.settings).toBe(1);
    const local = await localGetChannelSettings("ch-pull", ws);
    expect(local).toMatchObject({ channelId: "ch-pull", workspaceId: ws, pinnedRuntime: "swarm", defaultAgentId: "agent-raven" });
  });
});

describe("channel list cursor pagination across tiers", () => {
  it("preserves explicit database offsets above the Local/PG union cap", async () => {
    const row = {
      id: "db-offset-row",
      categoryId: null,
      workspaceId: "ws-db-offset",
      folderPath: null,
      name: "database row",
      type: "standard",
      createdBy: "system",
      position: 0,
      createdAt: new Date(0),
      archivedAt: null,
      archivedReason: null,
    };
    const recorder = makeRecorder({ channels: [row] });

    const result = await channelGate.list({
      limit: 1,
      cursor: "10001",
      workspaceId: "ws-db-offset",
      db: recorder,
    });

    expect(result).toEqual([row]);
    expect(recorder.queries.find((query) => query.table === "channels")?.offset).toBe(10001);
  });

  it("applies the union offset cap after explicit-database schema fallback", async () => {
    const db = {
      query: {
        channels: {
          findMany: async () => {
            throw Object.assign(new Error("missing tenant table"), { code: "42P01" });
          },
        },
      },
    };

    await expect(
      channelGate.list({ limit: 1, cursor: "10001", workspaceId: "ws-schema-fallback", db }),
    ).rejects.toThrow("Numeric channel offsets are limited to 10000");
  });

  it("continues the merged keyset page and keeps the local duplicate authoritative", async () => {
    const ws = "ws-channel-pages-dual";
    const localRows: Array<{ id: string; name: string; position: number }> = [];
    for (let position = 0; position <= 200; position++) {
      const id = `channel-${String(position).padStart(3, "0")}`;
      const row = await localCreateChannel({
        id,
        name: `local-${position}`,
        type: "standard",
        createdBy: "system",
        categoryId: null,
        workspaceId: ws,
        position,
      });
      localRows.push({ id, name: row.channel.name, position });
    }

    const pgRows = [
      {
        id: localRows[50].id,
        categoryId: null,
        workspaceId: ws,
        folderPath: null,
        name: "pg-stale-duplicate",
        type: "standard",
        createdBy: "system",
        position: 50,
        createdAt: new Date(),
        archivedAt: null,
        archivedReason: null,
      },
      {
        id: "pg-channel-201",
        categoryId: null,
        workspaceId: ws,
        folderPath: null,
        name: "pg-tail",
        type: "standard",
        createdBy: "system",
        position: 201,
        createdAt: new Date(),
        archivedAt: null,
        archivedReason: null,
      },
    ];
    const recorder = makeRecorder({ channels: pgRows });
    fakeDbHandle = recorder;
    const project = (rows: any[]) => rows.map(({ id, name, position }) => ({ id, name, position }));

    const firstPage = await runWithDb(recorder as any, () => channelGate.list({ limit: 200, workspaceId: ws }));
    expect(project(firstPage)).toEqual(localRows.slice(0, 200));
    expect(project(firstPage.slice(50, 51))).toEqual([{ id: localRows[50].id, name: "local-50", position: 50 }]);

    const last = localRows[199];
    const secondPage = await runWithDb(recorder as any, () =>
      channelGate.list({ limit: 200, cursor: `${last.position}:${last.id}`, workspaceId: ws }),
    );
    expect(project(secondPage)).toEqual([
      localRows[200],
      { id: "pg-channel-201", name: "pg-tail", position: 201 },
    ]);
  });

  it("fills a keyset page when earlier Local rows shadow a PG batch", async () => {
    const ws = "ws-channel-pages-shadowed";
    const localRows = Array.from({ length: 200 }, (_, position) => ({
      id: `shadow-${String(position).padStart(3, "0")}`,
      categoryId: null,
      workspaceId: ws,
      folderPath: null,
      name: `local-${position}`,
      type: "standard",
      createdBy: "system",
      position,
      createdAt: new Date(0).toISOString(),
      archivedAt: null,
      archivedReason: null,
    }));
    seedLocalChannelRows(ws, localRows);
    const localIds = localRows.map((row) => row.id);

    const pgRows = Array.from({ length: 400 }, (_, index) => {
      const position = 200 + index;
      return {
        id: index < 200 ? localIds[index] : `pg-${position}`,
        categoryId: null,
        workspaceId: ws,
        folderPath: null,
        name: `pg-${position}`,
        type: "standard",
        createdBy: "system",
        position,
        createdAt: new Date(),
        archivedAt: null,
        archivedReason: null,
      };
    });
    const recorder = makeChannelListRecorder(pgRows, localIds, 199);
    fakeDbHandle = recorder;

    const page = await runWithDb(recorder as any, () =>
      channelGate.list({ limit: 200, cursor: "199:shadow-199", workspaceId: ws }),
    );
    expect(page.map(({ id, name, position }: any) => ({ id, name, position }))).toEqual(
      pgRows.slice(200).map(({ id, name, position }) => ({ id, name, position })),
    );
    const pageQueries = recorder.queries.filter((query) => query.table === "channels");
    expect(pageQueries).toHaveLength(2);
    expect(pageQueries.every((query) => query.limit === 200 && query.params.length <= 3)).toBe(true);
  });

  it("does not resurrect a PG row shadowed by an archived Local channel", async () => {
    const ws = "ws-channel-pages-archived-shadow";
    const archivedRows = Array.from({ length: 2 }, (_, index) => ({
      id: `archived-local-${index}`,
      categoryId: null,
      workspaceId: ws,
      folderPath: null,
      name: `local-archived-${index}`,
      type: "archived",
      createdBy: "system",
      position: 50 + index,
      createdAt: new Date(0).toISOString(),
      archivedAt: new Date(0).toISOString(),
      archivedReason: null,
    }));
    seedLocalChannelRows(ws, archivedRows);
    const archivedIds = archivedRows.map((row) => row.id);
    const pgRows = [
      ...archivedIds.map((id, index) => ({
        id,
        categoryId: null,
        workspaceId: ws,
        folderPath: null,
        name: `pg-stale-active-${index}`,
        type: "standard",
        createdBy: "system",
        position: 200 + index,
        createdAt: new Date(),
        archivedAt: null,
        archivedReason: null,
      })),
      ...Array.from({ length: 200 }, (_, index) => ({
        id: `pg-live-${202 + index}`,
        categoryId: null,
        workspaceId: ws,
        folderPath: null,
        name: `pg-live-${202 + index}`,
        type: "standard",
        createdBy: "system",
        position: 202 + index,
        createdAt: new Date(),
        archivedAt: null,
        archivedReason: null,
      })),
    ];
    const recorder = makeChannelListRecorder(pgRows, archivedIds, 199);
    fakeDbHandle = recorder;

    const page = await runWithDb(recorder as any, () =>
      channelGate.list({ limit: 200, cursor: "199:after", workspaceId: ws }),
    );
    expect(page).toHaveLength(200);
    expect(page.every(({ id }: any) => !archivedIds.includes(id))).toBe(true);
    expect(page[0]).toMatchObject({ id: "pg-live-202", position: 202 });
    const pageQueries = recorder.queries.filter((query) => query.table === "channels");
    expect(pageQueries).toHaveLength(2);
    expect(pageQueries.every((query) => query.limit === 200 && query.params.length <= 3)).toBe(true);
  });

  it("returns merged numeric-offset pages past the per-tier 200-row window", async () => {
    const ws = "ws-channel-pages-offset";
    const fullLocalRows = Array.from({ length: 350 }, (_, position) => ({
      id: `offset-${String(position).padStart(3, "0")}`,
      categoryId: null,
      workspaceId: ws,
      folderPath: null,
      name: `local-${position}`,
      type: "standard",
      createdBy: "system",
      position,
      createdAt: new Date(0).toISOString(),
      archivedAt: null,
      archivedReason: null,
    }));
    seedLocalChannelRows(ws, fullLocalRows);
    const localRows = fullLocalRows.map(({ id, name, position }) => ({ id, name, position }));
    const localIds = fullLocalRows.map((row) => row.id);
    const pgRows = [{
      id: "pg-after-local",
      categoryId: null,
      workspaceId: ws,
      folderPath: null,
      name: "pg-after-local",
      type: "standard",
      createdBy: "system",
      position: 500,
      createdAt: new Date(),
      archivedAt: null,
      archivedReason: null,
    }];
    const recorder = makeChannelListRecorder(pgRows, localIds);
    fakeDbHandle = recorder;

    const page = await runWithDb(recorder as any, () =>
      channelGate.list({ limit: 100, cursor: "250", workspaceId: ws }),
    );
    expect(page.map(({ id, name, position }: any) => ({ id, name, position }))).toEqual(
      localRows.slice(250, 350),
    );
  });
});

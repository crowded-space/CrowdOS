import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/config/database.js", () => ({
  getDb: () => buildPerfTestDb(),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the perf test fake");
  },
  ensurePgVectorExtension: async () => {},
  closeDatabaseConnection: async () => {},
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
}));

vi.mock("../../shared/sockets/register-socket-server.js", () => ({
  globalBroker: null,
}));

vi.mock("../../tools/safety/guard.js", () => ({
  Guard: { validatePath: () => "/tmp/perftest" },
}));

vi.mock("../../tools/safety/hardened-exec.js", () => ({
  execHardened: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
}));

vi.mock("../../agents/agent-gate.js", () => ({
  agentGate: { list: async () => [] },
}));

import { Column, Param, SQL, StringChunk } from "drizzle-orm";
import type { AgentProfile } from "../../agents/agent-gate.js";
import * as schemaModule from "../../db/schema.js";
import { contextPipeline } from "./context-pipeline-manager.js";

type Row = Record<string, unknown>;

const TABLES = [
  "channels",
  "categories",
  "messages",
  "agent_memory_notes",
  "model_modules",
  "instruction_modules",
  "constraints_modules",
  "runtime_overrides",
  "compressed_summaries",
  "agent_instruction_stacks",
] as const;

const store: Record<string, Row[]> = TABLES.reduce((acc, name) => {
  acc[name] = [];
  return acc;
}, {} as Record<string, Row[]>);

const queryCounts: Record<string, number> = {};

function bump(relation: string): void {
  const key = relation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  queryCounts[key] = (queryCounts[key] ?? 0) + 1;
}

function resetPerfStore(): void {
  for (const name of TABLES) store[name].length = 0;
  for (const key of Object.keys(queryCounts)) delete queryCounts[key];
}

function tableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

function rowsFor(table: unknown): Row[] {
  const name = tableName(table);
  if (!name) throw new Error(`perfTestDb: unmapped table ${String(name)}`);
  if (!store[name]) store[name] = [];
  return store[name];
}

function tsKeyMap(table: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (value instanceof Column) map[value.name] = key;
  }
  return map;
}

const keyMapCache = new Map<unknown, Record<string, string>>();

function tsKeyOf(table: unknown, column: Column): string {
  let map = keyMapCache.get(table);
  if (!map) {
    map = tsKeyMap(table);
    keyMapCache.set(table, map);
  }
  return map[column.name] ?? column.name;
}

function eqValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

function cmpValue(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : Number(a);
  const bv = b instanceof Date ? b.getTime() : Number(b);
  return av - bv;
}

function chunkKind(chunk: unknown): string {
  const ctor = (chunk as any)?.constructor;
  return ctor ? String(ctor[Symbol.for("drizzle:entityKind")] ?? "") : "";
}

function predicate(table: unknown, column: Column, op: string, values: unknown[]): (row: Row) => boolean {
  const key = tsKeyOf(table, column);
  return (row) => {
    const left = row[key];
    if (op.trim() === "=") return values.some((v) => eqValue(left, v));
    if (op.trim() === "<>" || op.trim() === "!=") return !values.some((v) => eqValue(left, v));
    throw new Error(`perfTestDb: unsupported operator '${op}'`);
  };
}

function walkCondition(table: unknown, node: SQL): (row: Row) => boolean {
  const preds: Array<(row: Row) => boolean> = [];
  const logics: Array<"and" | "or"> = [];
  let currentColumn: Column | null = null;
  let opBuffer = "";
  let values: unknown[] = [];

  const flush = () => {
    if (currentColumn) preds.push(predicate(table, currentColumn, opBuffer || "=", values));
    currentColumn = null;
    opBuffer = "";
    values = [];
  };

  for (const chunk of node.queryChunks) {
    const kind = chunkKind(chunk);
    if (chunk instanceof StringChunk || kind === "StringChunk") {
      const text = ((chunk as StringChunk).value ?? []).join("");
      if (!currentColumn && preds.length > 0 && /\b(and|or)\b/i.test(text)) {
        flush();
        for (const m of text.match(/\b(and|or)\b/gi) ?? []) {
          logics.push(m.toLowerCase() as "and" | "or");
        }
        continue;
      }
      opBuffer += text;
    } else if (chunk instanceof Column || kind === "Column") {
      flush();
      currentColumn = chunk as Column;
    } else if (chunk instanceof Param || kind === "Param") {
      values.push((chunk as Param).value);
    } else if (chunk instanceof SQL || kind === "SQL") {
      flush();
      preds.push(walkCondition(table, chunk as SQL));
    } else if (Array.isArray(chunk)) {
      for (const item of chunk) {
        if (item instanceof Param || chunkKind(item) === "Param") values.push((item as Param).value);
      }
    }
  }
  flush();

  if (preds.length === 0) return () => true;
  if (preds.length === 1) return preds[0];
  return (row) => {
    let acc = preds[0](row);
    for (let i = 1; i < preds.length; i++) {
      acc = (logics[i - 1] ?? "and") === "or" ? acc || preds[i](row) : acc && preds[i](row);
    }
    return acc;
  };
}

function compileCondition(table: unknown, cond: unknown): (row: Row) => boolean {
  if (cond == null) return () => true;
  return walkCondition(table, cond as SQL);
}

type OrderKey = { column: Column; dir: "asc" | "desc" };

function resolveOrderKeys(table: unknown, orderBy: unknown): OrderKey[] {
  if (typeof orderBy !== "function") return [];
  const keys: OrderKey[] = [];
  const helpers = {
    asc: (column: Column) => {
      keys.push({ column, dir: "asc" });
      return column;
    },
    desc: (column: Column) => {
      keys.push({ column, dir: "desc" });
      return column;
    },
  };
  const fakeTable = new Proxy(
    {},
    {
      get(_t, prop) {
        const col = (table as any)[prop];
        if (col instanceof Column) return col;
        throw new Error(`perfTestDb: unknown order column ${String(prop)}`);
      },
    },
  );
  (orderBy as (t: unknown, h: typeof helpers) => unknown)(fakeTable, helpers);
  return keys;
}

function sortedCopy(rows: Row[], table: unknown, keys: OrderKey[]): Row[] {
  if (keys.length === 0) return [...rows];
  return [...rows].sort((a, b) => {
    for (const { column, dir } of keys) {
      const delta = cmpValue(a[tsKeyOf(table, column)], b[tsKeyOf(table, column)]);
      if (delta !== 0) return dir === "asc" ? delta : -delta;
    }
    return 0;
  });
}

function buildPerfTestDb() {  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        const snakeProp = prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const table = Object.values(schemaTables()).find(
          (v) => (v as any)?.[Symbol.for("drizzle:Name")] === snakeProp,
        );
        if (!table) throw new Error(`perfTestDb.query: unknown relation '${prop}'`);

        const findMany = (opts: { where?: unknown; orderBy?: unknown; limit?: number } = {}) => {
          bump(prop);
          const filtered = rowsFor(table).filter(compileCondition(table, opts.where));
          const sorted = sortedCopy(filtered, table, resolveOrderKeys(table, opts.orderBy));
          const limited = typeof opts.limit === "number" ? sorted.slice(0, opts.limit) : sorted;
          return Promise.resolve(limited.map((r) => ({ ...r })));
        };

        return {
          findMany,
          findFirst: async (opts: { where?: unknown; orderBy?: unknown } = {}) => {
            const rows = await findMany({ ...opts, limit: 1 });
            return rows[0] ?? null;
          },
        };
      },
    },
  );

  return {
    query,
    select: () => {
      const run = async () => [] as Row[];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => run(),
        limit: () => run(),
        then: (
          onFulfilled?: (rows: Row[]) => unknown,
          onRejected?: (err: unknown) => unknown,
        ) => Promise.resolve([] as Row[]).then(onFulfilled, onRejected),
        catch: (onRejected: (err: unknown) => unknown) =>
          Promise.resolve([] as Row[]).catch(onRejected),
      };
      return chain;
    },
    transaction: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
  };
}

let schemaTablesCache: Record<string, unknown> | null = null;
function schemaTables(): Record<string, unknown> {
  if (!schemaTablesCache) {
    schemaTablesCache = Object.fromEntries(Object.entries(schemaModule));
  }
  return schemaTablesCache!;
}

const CHANNEL_ID = "perf-test-kernel";
const BASE_TS = new Date("2026-06-01T00:00:00Z").getTime();

const AGENT_PROFILE: AgentProfile = {
  id: "agent-perf-1",
  name: "PerfBot",
  title: "Performance Probe",
  authorityLevel: 3,
  modelModuleId: "mod-missing",
  instructionModuleId: "mod-missing",
  memorySharingPolicy: "full",
  isOmniscient: false,
  permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
  status: "idle",
  isTemplate: false,
  createdAt: new Date(BASE_TS),
  updatedAt: new Date(BASE_TS),
};

function seedChannel(messageCount: number, noteCount = 300): void {
  store.channels.push({
    id: CHANNEL_ID,
    name: "perf-channel",
    categoryId: null,
    createdBy: "user-1",
    position: 0,
  });

  const authors = [
    { id: AGENT_PROFILE.id, name: "PerfBot", level: "3", type: "agent" },
    { id: "user-1", name: "Operator", level: "stakeholder", type: "user" },
    { id: "agent-peer", name: "PeerBot", level: "3", type: "agent" },
  ];

  for (let i = 0; i < messageCount; i++) {
    const author = authors[i % authors.length];
    store.messages.push({
      id: `msg-${i}`,
      channelId: CHANNEL_ID,
      authorId: author.id,
      authorName: author.name,
      authorLevel: author.level,
      authorType: author.type,
      content: `hello ${i}`,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: i + 1,
      timestamp: new Date(BASE_TS + i * 1000),
    });
  }

  for (let i = 0; i < noteCount; i++) {
    store.agent_memory_notes.push({
      id: `note-${i}`,
      agentId: AGENT_PROFILE.id,
      channelId: CHANNEL_ID,
      noteType: "semantic",
      noteTimestamp: new Date(BASE_TS + i * 1000),
      importanceScore: (i % 100) / 100,
      confidence: "high",
      sourceType: "direct_experience",
      emotionalValence: "neutral",
      accessCount: 0,
      lastAccessed: null,
      links: [],
      contradictionFlags: [],
      lifecycleStatus: "active",
      archivedAt: null,
      archiveReason: null,
      suppressedAt: null,
      suppressReason: null,
      suppressUntil: null,
      hook: `hook ${i}`,
      brief: `brief ${i}`,
      createdAt: new Date(BASE_TS),
      updatedAt: new Date(BASE_TS),
    });
  }
}

function assembleOnce() {
  return contextPipeline.assemble({
    agent: AGENT_PROFILE,
    channelId: CHANNEL_ID,
    workspaceId: "default",
    userInput: "run the hot path probe",
    runtimeType: "conversational" as never,
  });
}

describe("PERF-2 · bounded hot-path queries across one assemble", () => {
  beforeEach(() => {
    resetPerfStore();
  });

  it("5k-message channel: history fetched ONCE per send (not twice)", async () => {
    seedChannel(5000);

    const packet = await assembleOnce();

    expect(queryCounts.messages).toBe(1);
    expect(packet.history.length).toBe(30);
    const systemPrompt = packet.systemPrompt;
    expect(systemPrompt).toContain("[CHANNEL CONTEXT — MULTI-AGENT AWARENESS]");
    expect(systemPrompt).toContain("@PerfBot");
    expect(String(packet.history[0].content)).toContain("[From @");
  }, 15_000);

  it("per-send message query count is flat vs channel age", async () => {
    seedChannel(100);
    await assembleOnce();
    expect(queryCounts.messages).toBe(1);

    resetPerfStore();
    seedChannel(5000);
    await assembleOnce();
    expect(queryCounts.messages).toBe(1);

    await assembleOnce();
    expect(queryCounts.messages).toBe(2);
  }, 15_000);

  it("memory-notes query count is O(1) windowed regardless of note count", async () => {
    seedChannel(200, 300);
    const packet = await assembleOnce();

    expect(queryCounts.agent_memory_notes).toBe(1);
    expect(typeof packet.memoryPreviewBlock).toBe("string");
  }, 15_000);

  it("shared-window slices preserve each middleware's output semantics", async () => {
    seedChannel(45);
    const packet = await assembleOnce();

    // VisibilityMatrix: newest 30, chronological ascending
    const stamps = packet.history.map((h) => new Date(h.timestamp).getTime());
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    expect(stamps[stamps.length - 1]).toBe(BASE_TS + 44 * 1000);

    // ChannelAwareness roster: newest-30 slice still yields distinct speakers + self
    const systemPrompt = packet.systemPrompt;
    expect(systemPrompt).toContain("@PerfBot");
    expect(systemPrompt).toContain("@PeerBot");
    expect(systemPrompt).toContain("@Operator");

    // Shared memo rides on the mutable packet only — final metadata drops it
    expect((packet.metadata as unknown as Record<string, unknown>)["__sharedHistoryFetch"]).toBeUndefined();
  }, 15_000);
});

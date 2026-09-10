import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Column, Param, SQL, StringChunk } from "drizzle-orm";
import * as schema from "../db/schema.js";

vi.mock("../Shared/config/database.js", () => ({
  getDb: () => buildSpawnTestDb(),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the spawn test fake");
  },
  ensurePgVectorExtension: async () => {},
  closeDatabaseConnection: async () => {},
  withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(buildSpawnTestDb()),
}));

import { AgentSpawnManager } from "./agentSpawnManager.js";
import { agentGate } from "./agentGate.js";

// RT-4/SW-1: legacy spawn manager retired behind SWARM_LEGACY flag; archive tests need legacy enabled
process.env.SWARM_LEGACY = "true"
import {
  runSpawnRetentionSweep,
  startSpawnRetentionSweeper,
  resetSpawnRetentionSweeperForTests,
} from "./spawnRetentionSweeper.js";
import { LibrarianRuntime } from "../Shared/core/librarianRuntime.js";
import { IndexBuilder } from "../Shared/core/indexBuilder.js";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const TABLE_KEYS = [
  "model_modules",
  "instruction_modules",
  "toolkit_modules",
  "agents",
  "categories",
  "channels",
  "spawn_requests",
  "runtime_states",
  "task_files",
  "messages",
  "workspace_agents",
  "channel_index",
  "compressed_summaries",
] as const;

const store: Record<(typeof TABLE_KEYS)[number], Row[]> = TABLE_KEYS.reduce((acc, key) => {
  acc[key] = [];
  return acc;
}, {} as Record<(typeof TABLE_KEYS)[number], Row[]>);

const seqCounters = new Map<string, number>();

function resetStore(): void {
  for (const key of TABLE_KEYS) store[key].length = 0;
  seqCounters.clear();
}

function rowsFor(table: unknown): Row[] {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  if (typeof name === "string" && (TABLE_KEYS as readonly string[]).includes(name)) {
    return store[name as (typeof TABLE_KEYS)[number]];
  }
  throw new Error(`spawnTestDb: unmapped table ${String(name)}`);
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
  return false;
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

function binaryPredicate(table: unknown, column: Column, op: string, values: unknown[]): Predicate {
  const key = tsKeyOf(table, column);
  const normalized = op.trim();
  return (row) => {
    const left = row[key];
    switch (true) {
      case normalized === "=":
        return values.some((v) => eqValue(left, v));
      case normalized === "<>" || normalized === "!=":
        return !values.some((v) => eqValue(left, v));
      case normalized === ">":
        return values.every((v) => cmpValue(left, v) > 0);
      case normalized === ">=":
        return values.every((v) => cmpValue(left, v) >= 0);
      case normalized === "<":
        return values.every((v) => cmpValue(left, v) < 0);
      case normalized === "<=":
        return values.every((v) => cmpValue(left, v) <= 0);
      case normalized === "is null":
        return left == null;
      case normalized === "is not null":
        return left != null;
      case normalized.startsWith("in"):
        return values.some((v) => eqValue(left, v));
      default:
        throw new Error(`spawnTestDb: unsupported operator '${normalized}'`);
    }
  };
}

function walkCondition(table: unknown, node: SQL): Predicate {
  const preds: Predicate[] = [];
  const logics: Array<"and" | "or"> = [];
  let currentColumn: Column | null = null;
  let opBuffer = "";
  let values: unknown[] = [];

  const flush = () => {
    if (currentColumn) {
      if (values.length === 0) {
        const literal = opBuffer.match(/^\s*(<>|!=|>=|<=|=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (literal) {
          opBuffer = literal[1];
          values.push(Number(literal[2]));
        }
      }
      preds.push(binaryPredicate(table, currentColumn, opBuffer || "=", values));
    }
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
        else values.push(item);
      }
    } else if (typeof chunk !== "object" && chunk != null) {
      values.push(chunk);
    }
  }
  flush();

  if (preds.length === 0) return () => true;
  if (preds.length === 1) return preds[0];
  return (row) => {
    let acc = preds[0](row);
    for (let i = 1; i < preds.length; i++) {
      const logic = logics[i - 1] ?? "and";
      acc = logic === "or" ? acc || preds[i](row) : acc && preds[i](row);
    }
    return acc;
  };
}

function compileCondition(table: unknown, cond: unknown): Predicate {
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
  const fakeTable = new Proxy({}, {
    get(_target, prop) {
      const col = (table as any)[prop];
      if (col instanceof Column) return col;
      throw new Error(`spawnTestDb: unknown order column ${String(prop)}`);
    },
  });
  (orderBy as (t: unknown, h: typeof helpers) => unknown)(fakeTable, helpers);
  return keys;
}

function sortedCopy(rows: Row[], table: unknown, keys: OrderKey[]): Row[] {
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { column, dir } of keys) {
      const delta = cmpValue(a[tsKeyOf(table, column)], b[tsKeyOf(table, column)]);
      if (delta !== 0) return dir === "asc" ? delta : -delta;
    }
    return 0;
  });
}

function buildSpawnTestDb() {
  function findSchemaTable(name: string): unknown {
    return Object.values(schema).find(
      (v) => typeof v === "object" && v !== null && (v as any)[Symbol.for("drizzle:Name")] === name,
    );
  }

  return {
    insert(table: unknown) {
      return {
        values(values: Row) {
          const rec: Row = { ...values };
          rowsFor(table).push(rec);
          const done = async () => rec;
          const promise = done() as Promise<Row> & { returning: () => Promise<Row[]> };
          promise.returning = async () => [{ ...rec }];
          return promise;
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Row) {
          return {
            where(cond: unknown) {
              const predicate = compileCondition(table, cond);
              const updated: Row[] = [];
              for (const row of rowsFor(table)) {
                if (predicate(row)) {
                  Object.assign(row, patch);
                  updated.push({ ...row });
                }
              }
              const done = async () => [] as Row[];
              const promise = done() as Promise<Row[]> & { returning: () => Promise<Row[]> };
              promise.returning = async () => updated;
              return promise;
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(cond: unknown) {
          const predicate = compileCondition(table, cond);
          const rows = rowsFor(table);
          const removed: Row[] = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            if (predicate(rows[i])) removed.push(...rows.splice(i, 1));
          }
          const done = async () => [] as Row[];
          const promise = done() as Promise<Row[]> & { returning: () => Promise<Row[]> };
          promise.returning = async () => removed.map((r) => ({ ...r }));
          return promise;
        },
      };
    },
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const state: { predicate: Predicate | null } = { predicate: null };
          const run = (): Row[] => {
            const matched = rowsFor(table).filter(state.predicate ?? (() => true));
            if (!fields) return matched.map((r) => ({ ...r }));
            const out: Row = {};
            for (const [alias, expr] of Object.entries(fields)) {
              out[alias] = expr instanceof Column && matched.length > 0 ? matched[0][tsKeyOf(table, expr)] : null;
            }
            return [out];
          };
          const finish = () => Promise.resolve(run());
          const makeChainable = () => ({
            limit(n: number) {
              return Promise.resolve(run().slice(0, n));
            },
            then(
              onFulfilled?: (rows: Row[]) => unknown,
              onRejected?: (err: unknown) => unknown,
            ) {
              return finish().then(onFulfilled, onRejected);
            },
            catch(onRejected: (err: unknown) => unknown) {
              return finish().catch(onRejected);
            },
          });
          return {
            where(cond: unknown) {
              state.predicate = compileCondition(table, cond);
              return makeChainable();
            },
            limit(n: number) {
              return Promise.resolve(run().slice(0, n));
            },
            then(
              onFulfilled?: (rows: Row[]) => unknown,
              onRejected?: (err: unknown) => unknown,
            ) {
              return finish().then(onFulfilled, onRejected);
            },
            catch(onRejected: (err: unknown) => unknown) {
              return finish().catch(onRejected);
            },
          };
        },
      };
    },
    execute(node: SQL) {
      let channelKey = "default";
      for (const chunk of node.queryChunks) {
        if (chunk instanceof Param || chunkKind(chunk) === "Param") {
          channelKey = String((chunk as Param).value);
          break;
        }
      }
      const next = (seqCounters.get(channelKey) ?? 0) + 1;
      seqCounters.set(channelKey, next);
      return Promise.resolve([{ last_seq: next }]);
    },
    transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(buildSpawnTestDb());
    },
    query: new Proxy(
      {},
      {
        get(_target, prop: string) {
          const snake = prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
          const table = findSchemaTable(snake);
          if (!table) throw new Error(`spawnTestDb.query: unknown relation '${prop}'`);

          const findMany = (opts: { where?: unknown; orderBy?: unknown; limit?: number } = {}) => {
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
    ),
  };
}

// ---------- seed helpers ----------

const BROKER = { emit: vi.fn() } as unknown as Parameters<typeof AgentSpawnManager.dispatchAgent>[0];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function seedModules(withApiKey = false): void {
  store.model_modules.push({
    id: "mod-1",
    label: "Flash",
    provider: "google",
    modelName: "gemini-2.0-flash",
    apiKey: withApiKey ? "AIzaSY-TEST-PLAINTEXT-KEY" : null,
    endpointUrl: null,
  });
  store.instruction_modules.push({ id: "inst-1", label: "Base", base: [] });
}

function seedTemplateAgent(id: string, name: string, subtype: "worker" | "supervisor"): void {
  store.agents.push({
    id,
    name,
    title: `Template ${subtype}`,
    species: "Falcon",
    authorityLevel: 3,
    l3Subtype: subtype,
    modelModuleId: "mod-1",
    instructionModuleId: "inst-1",
    toolkitModuleId: null,
    memorySharingPolicy: "none",
    isOmniscient: false,
    status: "idle",
    isTemplate: true,
    permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function seedChannel(id: string, name: string): void {
  store.channels.push({
    id,
    workspaceId: "default",
    categoryId: null,
    name,
    type: "standard",
    createdBy: "tester",
    position: 0,
    createdAt: new Date(),
  });
}

function seedMessages(channelId: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    store.messages.push({
      id: `msg-${channelId}-${i}`,
      channelId,
      authorId: i % 2 === 0 ? "bob" : "alice",
      authorName: i % 2 === 0 ? "Bob" : "Alice",
      authorLevel: "stakeholder",
      authorType: "user",
      content: `hello world ${i}`,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: i,
      timestamp: new Date(),
    });
  }
}

function librarianProfile(modelModuleId: string | null): any {
  return {
    id: "agent-librarian",
    name: "Librarian",
    title: "Swarm Librarian",
    authorityLevel: 1,
    modelModuleId,
    instructionModuleId: "inst-1",
  };
}

describe("DB-3 · spawn-verdict archive lifecycle", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("archives pair channel, agents and task_files instead of deleting them", async () => {
    seedModules();
    seedTemplateAgent("tpl-worker", "Falcon Worker", "worker");
    seedTemplateAgent("tpl-spv", "Owl Supervisor", "supervisor");
    seedChannel("ch-origin", "origin");

    const report = await AgentSpawnManager.dispatchAgent(BROKER, "human-operator", "ch-origin", {
      workerTemplateId: "tpl-worker",
      supervisorTemplateId: "tpl-spv",
      subtasks: [{ id: "st-1", title: "Alpha", instructions: "produce output", priority: "high" }],
      failurePolicy: "escalate",
      maxRetries: 0,
    } as Parameters<typeof AgentSpawnManager.dispatchAgent>[3]);

    expect(report.status).toBe("completed");

    const pairChannel = store.channels.find((c) => String(c.id).startsWith("ch-pair-st-1-"));
    expect(pairChannel).toBeDefined();
    expect(pairChannel!.archivedAt).toBeInstanceOf(Date);
    expect(pairChannel!.archivedReason).toBe("spawn_verdict");
    expect(pairChannel!.type).toBe("pair_private");

    const taskFile = store.task_files.find((tf) => tf.subtaskId === "st-1");
    expect(taskFile).toBeDefined();
    expect(taskFile!.archivedAt).toBeInstanceOf(Date);
    expect(taskFile!.archivedReason).toBe("spawn_verdict");

    const worker = store.agents.find((a) => a.id === taskFile!.workerAgentId);
    const spv = store.agents.find((a) => a.id === taskFile!.supervisorAgentId);
    expect(worker).toBeDefined();
    expect(spv).toBeDefined();
    expect(worker!.archivedAt).toBeInstanceOf(Date);
    expect(worker!.archivedReason).toBe("spawn_verdict");
    expect(spv!.archivedAt).toBeInstanceOf(Date);

    // runtime_states remain ephemeral hard-deletes
    const lingeringStates = store.runtime_states.filter(
      (s) => s.agentId === worker!.id || s.agentId === spv!.id,
    );
    expect(lingeringStates).toHaveLength(0);

    // evidence trail survives: messages + welcome history intact
    const pairMessages = store.messages.filter((m) => m.channelId === pairChannel!.id);
    expect(pairMessages.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("hides archived artifacts from channel listings and agent rosters", async () => {
    seedModules();
    seedTemplateAgent("tpl-worker", "Falcon Worker", "worker");
    seedTemplateAgent("tpl-spv", "Owl Supervisor", "supervisor");
    seedChannel("ch-origin", "origin");

    await AgentSpawnManager.dispatchAgent(BROKER, "human-operator", "ch-origin", {
      workerTemplateId: "tpl-worker",
      supervisorTemplateId: "tpl-spv",
      subtasks: [{ id: "st-1", title: "Alpha", instructions: "produce output", priority: "high" }],
      failurePolicy: "escalate",
      maxRetries: 0,
    } as Parameters<typeof AgentSpawnManager.dispatchAgent>[3]);

    const { listChannels } = (await vi.importActual("../Channels/channelService.js")) as {
      listChannels(): Promise<Array<{ id: string }>>;
    };
    const visibleChannels = await listChannels();
    expect(visibleChannels.map((c) => c.id)).not.toContain(expect.stringMatching(/^ch-pair-st-1-/));
    expect(visibleChannels.map((c) => c.id)).toContain("ch-origin");

    const rosterAll = await agentGate.list();
    const archiveFlags = rosterAll as Array<{ id: string; isTemplate: boolean; l3Subtype?: string | null; archivedAt?: Date | null }>;
    expect(archiveFlags.every((a) => a.archivedAt == null)).toBe(true);
    expect(archiveFlags.map((a) => a.id)).toEqual(expect.arrayContaining(["tpl-worker", "tpl-spv"]));
    expect(archiveFlags.some((a) => a.isTemplate === false && a.l3Subtype === "worker")).toBe(false);
  }, 30_000);
});

describe("DB-3 · spawn retention sweeper", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.RETENTION_DAYS;
    delete process.env.RETENTION_SWEEP_MS;
  });

  it("purges only rows archived beyond the retention window", async () => {
    seedChannel("ch-live", "live");
    seedChannel("ch-fresh-archived", "fresh");
    store.channels.find((c) => c.id === "ch-fresh-archived")!.archivedAt = new Date();
    store.channels.find((c) => c.id === "ch-fresh-archived")!.archivedReason = "spawn_verdict";

    const staleAgent = {
      id: "agent-stale",
      name: "Stale Instance",
      title: "Worker Instance",
      authorityLevel: 3,
      memorySharingPolicy: "none",
      isTemplate: false,
      status: "idle",
      archivedAt: daysAgo(40),
      archivedReason: "spawn_verdict",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.agents.push(staleAgent);
    seedTemplateAgent("tpl-live", "Live Template", "worker");

    store.task_files.push({
      id: "tf-stale",
      spawnRequestId: "spawn-x",
      subtaskId: "st-old",
      title: "old",
      content: "old content",
      workerAgentId: "agent-stale",
      supervisorAgentId: "agent-stale",
      status: "completed",
      archivedAt: daysAgo(31),
      archivedReason: "spawn_verdict",
      createdAt: new Date(),
    });

    process.env.RETENTION_SWEEP_MS = String(6 * 60 * 60 * 1000);
    const result = await runSpawnRetentionSweep();

    expect(result).toEqual({ purgedTaskFiles: 1, purgedAgents: 1, purgedChannels: 0 });
    expect(store.agents.some((a) => a.id === "agent-stale")).toBe(false);
    expect(store.task_files.some((tf) => tf.id === "tf-stale")).toBe(false);
    expect(store.agents.some((a) => a.id === "tpl-live")).toBe(true);
    expect(store.channels.some((c) => c.id === "ch-fresh-archived")).toBe(true);
    expect(store.channels.some((c) => c.id === "ch-live")).toBe(true);
  });

  it("honors RETENTION_DAYS=0 by purging every archived row while keeping live rows", async () => {
    seedChannel("ch-live", "live");
    for (const id of ["arch-a", "arch-b"]) {
      store.agents.push({
        id,
        name: id,
        title: "Worker Instance",
        authorityLevel: 3,
        memorySharingPolicy: "none",
        isTemplate: false,
        status: "idle",
        archivedAt: daysAgo(1),
        archivedReason: "spawn_verdict",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    process.env.RETENTION_DAYS = "0";
    const result = await runSpawnRetentionSweep();

    expect(result.purgedAgents).toBe(2);
    expect(result.purgedChannels).toBe(0);
    expect(store.agents).toHaveLength(0);
    expect(store.channels.some((c) => c.id === "ch-live")).toBe(true);
  });

  it("startSpawnRetentionSweeper registers at most one interval per process", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startSpawnRetentionSweeper();
      startSpawnRetentionSweeper();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      const handle = spy.mock.results[0]?.value as ReturnType<typeof setInterval> | undefined;
      spy.mockRestore();
      if (handle) clearInterval(handle);
      resetSpawnRetentionSweeperForTests();
    }
  });
});

describe("DB-3 · librarian honesty on provider failure", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the index degraded with redacted last_error and persists NO fabricated summary", async () => {
    seedModules(true);
    seedChannel("ch-degrade", "degrade-chan");
    seedMessages("ch-degrade", 2);

    const fetchMock = vi.fn().mockRejectedValue(
      new Error("POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSY-TEST-PLAINTEXT-KEY failed: ECONNREFUSED"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new LibrarianRuntime();
    const result = await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-degrade");

    expect(result).toContain("[INDEX DEGRADED]");
    expect(result).toContain("#degrade-chan");
    expect(result).not.toContain("Key topics center on workspace development");
    expect(result).not.toContain("(Indexed via librarian specialist fallback)");

    const [idxRow] = store.channel_index;
    expect(idxRow).toBeDefined();
    expect(idxRow!.status).toBe("degraded");
    expect(idxRow!.lastError).toContain("[REDACTED]");
    expect(String(idxRow!.lastError)).not.toContain("AIzaSY-TEST-PLAINTEXT-KEY");
    expect(idxRow!.topicSummary).toContain("[INDEX DEGRADED]");

    expect(store.compressed_summaries).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never calls the provider when no model credentials exist — degrade without fabrication", async () => {
    seedModules(false);
    seedChannel("ch-nomodel", "nomodel-chan");
    seedMessages("ch-nomodel", 2);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new LibrarianRuntime();
    const result = await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-nomodel");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toContain("[INDEX DEGRADED]");
    const [idxRow] = store.channel_index;
    expect(idxRow!.status).toBe("degraded");
    expect(idxRow!.lastError).toBe("no_model_configured");
    expect(store.compressed_summaries).toHaveLength(0);
  });

  it("surfaces degraded status in help and search output", async () => {
    seedModules(false);
    seedChannel("ch-flagged", "flagged-chan");
    seedMessages("ch-flagged", 2);

    const runtime = new LibrarianRuntime();
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-flagged");

    const help = await (runtime as unknown as { handleHelpCommand(): Promise<string> }).handleHelpCommand();
    expect(help).toContain("DEGRADED");
    expect(help).toContain("no_model_configured");

    const search = await (
      runtime as unknown as { handleSearchCommand(q: string, workspaceId: string): Promise<string> }
    ).handleSearchCommand("flagged", "default");
    expect(search).toContain("DEGRADED INDEX");
    expect(search).toContain("no_model_configured");
  });

  it("recovers to ok and un-degrades on subsequent successful indexing", async () => {
    seedModules(true);
    seedChannel("ch-recover", "recover-chan");
    seedMessages("ch-recover", 2);

    const failing = vi.fn().mockRejectedValue(new Error("request to endpoint?key=AIzaSY-TEST-PLAINTEXT-KEY aborted"));
    vi.stubGlobal("fetch", failing);
    const runtime = new LibrarianRuntime();
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-recover");
    expect(store.channel_index[0]!.status).toBe("degraded");

    const succeeding = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Clean verified summary." }] } }] }),
    });
    vi.stubGlobal("fetch", succeeding);
    const summary = await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-recover");

    expect(summary).toBe("Clean verified summary.");
    const [idxRow] = store.channel_index;
    expect(idxRow!.status).toBe("ok");
    expect(idxRow!.lastError).toBeNull();
    expect(idxRow!.topicSummary).toBe("Clean verified summary.");
    expect(store.compressed_summaries).toHaveLength(1);
  });

  it("reindexStaleChannels retries degraded entries even without drift", async () => {
    seedModules(true);
    store.agents.push(librarianProfile("mod-1"));
    seedChannel("ch-stale", "stale-chan");
    seedMessages("ch-stale", 2);
    store.channel_index.push({
      channelId: "ch-stale",
      channelPath: "#stale-chan",
      topicSummary: "[INDEX DEGRADED] Summary unavailable.",
      lastIndexedAt: new Date(),
      messageCountSinceIndex: 0,
      status: "degraded",
      lastError: "provider_http_500",
    });

    const succeeding = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Recovered summary." }] } }] }),
    });
    vi.stubGlobal("fetch", succeeding);

    await IndexBuilder.reindexStaleChannels(BROKER);

    expect(succeeding).toHaveBeenCalledTimes(1);
    const [idxRow] = store.channel_index;
    expect(idxRow!.status).toBe("ok");
    expect(idxRow!.lastError).toBeNull();
    expect(idxRow!.topicSummary).toBe("Recovered summary.");
  });
});

describe("PERF-4 · librarian delta indexing", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    delete process.env.DELTA_INDEX;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DELTA_INDEX;
  });

  function fetchReturning(text: string): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    });
  }

  /** Chars fed to the summarizer (user prompt of the single provider call). */
  function summarizerInputChars(fetchMock: ReturnType<typeof vi.fn>): number {
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    return String(body.contents[0].parts[0].text).length;
  }

  function appendMessages(channelId: string, fromSeq: number, toSeq: number): void {
    for (let i = fromSeq; i <= toSeq; i++) {
      store.messages.push({
        id: `msg-${channelId}-${i}`,
        channelId,
        authorId: i % 2 === 0 ? "bob" : "alice",
        authorName: i % 2 === 0 ? "Bob" : "Alice",
        authorLevel: "stakeholder",
        authorType: "user",
        content: `hello world ${i}`,
        mentions: [],
        isInternalMonologue: false,
        sequenceNumber: i,
        timestamp: new Date(),
      });
    }
  }

  it("1k-message fixture: second pass feeds ≤20% of the full-window chars to the summarizer", async () => {
    seedModules(true);
    seedChannel("ch-1k", "thousand");
    seedMessages("ch-1k", 1000);

    const fullPass = fetchReturning("Compiled full-history summary.");
    vi.stubGlobal("fetch", fullPass);
    const runtime = new LibrarianRuntime();
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-1k");

    expect(fullPass).toHaveBeenCalledTimes(1);
    const [idxAfterSeed] = store.channel_index;
    expect(idxAfterSeed!.lastSeq).toBe(1000);
    const fullChars = summarizerInputChars(fullPass);
    expect(fullChars).toBeGreaterThan(10_000);

    appendMessages("ch-1k", 1001, 1020);

    const deltaPass = fetchReturning("Compiled delta summary.");
    vi.stubGlobal("fetch", deltaPass);
    const deltaSummary = await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-1k");

    expect(deltaSummary).toBe("Compiled delta summary.");
    expect(deltaPass).toHaveBeenCalledTimes(1);
    const [idxAfterDelta] = store.channel_index;
    expect(idxAfterDelta!.lastSeq).toBe(1020);
    expect(store.compressed_summaries).toHaveLength(2);

    const deltaChars = summarizerInputChars(deltaPass);
    // −80% acceptance: delta input chars ≤ 20% of the full-reload proxy
    expect(deltaChars).toBeLessThanOrEqual(fullChars * 0.2);
    expect(deltaChars / fullChars).toBeLessThan(0.05); // observed ~2.5%
  }, 30_000);

  it("skips the provider call entirely when no pending delta exists", async () => {
    seedModules(true);
    seedChannel("ch-caught-up", "caught-up");
    seedMessages("ch-caught-up", 5);

    const first = fetchReturning("Up-to-date summary.");
    vi.stubGlobal("fetch", first);
    const runtime = new LibrarianRuntime();
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-caught-up");

    const second = await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-caught-up");

    expect(second).toBe("Up-to-date summary.");
    expect(first).toHaveBeenCalledTimes(1);
    expect(store.compressed_summaries).toHaveLength(1);
  });

  it("DELTA_INDEX=false rolls back to legacy full-reload window", async () => {
    process.env.DELTA_INDEX = "false";
    seedModules(true);
    seedChannel("ch-legacy", "legacy-chan");
    seedMessages("ch-legacy", 50);

    const first = fetchReturning("Legacy pass one.");
    vi.stubGlobal("fetch", first);
    const runtime = new LibrarianRuntime();
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-legacy");

    appendMessages("ch-legacy", 51, 60);

    const second = fetchReturning("Legacy pass two.");
    vi.stubGlobal("fetch", second);
    await runtime.indexChannel(BROKER, librarianProfile("mod-1"), "ch-legacy");

    expect(second).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(second.mock.calls[0][1].body));
    const userText = String(body.contents[0].parts[0].text);
    // Full reload: earliest message present again and no delta previous-summary prefix
    expect(userText).toContain("[Alice]: hello world 1");
    expect(userText).toContain("hello world 60");
    expect(userText).not.toContain("[PREVIOUS SUMMARY]");
    const latest = store.channel_index[store.channel_index.length - 1];
    expect(latest!.lastSeq).toBe(60);
  });
});

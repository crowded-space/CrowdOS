import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/config/database.js", () => ({
  getDb: () => buildRosterTestDb(),
  getSqlClient: () => {
    throw new Error("getSqlClient is not available under the roster test fake");
  },
  ensurePgVectorExtension: async () => {},
  closeDatabaseConnection: async () => {},
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
  isDatabaseConfigured: () => true,
}));

import { Column, Param, SQL, StringChunk } from "drizzle-orm";
import * as schemaModule from "../db/schema.js";
import { agentRegistry } from "./agent-service.js";
import {
  enableRosterCacheForTests,
  invalidateRosterCache,
} from "./agent-roster-cache.js";

type Row = Record<string, unknown>;

const store = {
  agents: [] as Row[],
  runtime_states: [] as Row[],
  model_modules: [] as Row[],
  instruction_modules: [] as Row[],
};

const agentsFindManyCalls = { count: 0 };

function resetRosterStore(): void {
  store.agents.length = 0;
  store.runtime_states.length = 0;
  store.model_modules.length = 0;
  store.instruction_modules.length = 0;
  agentsFindManyCalls.count = 0;
}

function tableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

function rowsFor(table: unknown): Row[] {
  const name = tableName(table);
  if (name === "agents") return store.agents;
  if (name === "runtime_states" || name === "model_modules" || name === "instruction_modules") {
    return store[name];
  }
  throw new Error(`rosterTestDb: unmapped table ${String(name)}`);
}

function tsKeyMap(table: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (value instanceof Column) map[value.name] = key;
  }
  return map;
}

function tsKeyOf(table: unknown, column: Column): string {
  return tsKeyMap(table)[column.name] ?? column.name;
}

function eqValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

function chunkKind(chunk: unknown): string {
  const ctor = (chunk as any)?.constructor;
  return ctor ? String(ctor[Symbol.for("drizzle:entityKind")] ?? "") : "";
}

function walkCondition(table: unknown, node: SQL): (row: Row) => boolean {
  const preds: Array<(row: Row) => boolean> = [];
  const logics: Array<"and" | "or"> = [];
  let currentColumn: Column | null = null;
  let opBuffer = "";
  let values: unknown[] = [];

  const flush = () => {
    if (currentColumn) {
      const key = tsKeyOf(table, currentColumn);
      const op = opBuffer.trim() || "=";
      const captured = [...values];
      preds.push((row) => {
        const left = row[key];
        if (op === "=") return captured.some((v) => eqValue(left, v));
        if (op === "is null") return left == null;
        if (op === "is not null") return left != null;
        throw new Error(`rosterTestDb: unsupported operator '${op}'`);
      });
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
      acc = (logics[i - 1] ?? "and") === "or" ? acc || preds[i](row) : acc && preds[i](row);
    }
    return acc;
  };
}

function compileCondition(table: unknown, cond: unknown): (row: Row) => boolean {
  if (cond == null) return () => true;
  return walkCondition(table, cond as SQL);
}

function buildRosterTestDb() {
  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        const snakeProp = prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const table = Object.values(schemaModule).find(
          (v) => typeof v === "object" && v !== null && (v as any)[Symbol.for("drizzle:Name")] === snakeProp,
        );
        if (!table) throw new Error(`rosterTestDb.query: unknown relation '${prop}'`);

        const runQuery = (opts: { where?: unknown }, limit?: number) => {
          const filtered = rowsFor(table).filter(compileCondition(table, opts.where));
          return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
        };

        return {
          findMany: async (opts: { where?: unknown; orderBy?: unknown; limit?: number } = {}) => {
            if (prop === "agents") agentsFindManyCalls.count++;
            return runQuery(opts, opts.limit).map((r) => ({ ...r }));
          },
          findFirst: async (opts: { where?: unknown } = {}) => {
            const rows = runQuery(opts, 1);
            return rows.length > 0 ? { ...rows[0] } : null;
          },
        };
      },
    },
  );

  return {
    query,
    insert(table: unknown) {
      return {
        values(values: Row) {
          const rec: Row = { ...values };
          const done = async () => rec;
          const promise = done() as Promise<Row> & { returning: () => Promise<Row[]> };
          promise.returning = async () => [rec];
          rowsFor(table).push(rec);
          return promise;
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Row) {
          return {
            where(where: unknown) {
              const predicateFn = compileCondition(table, where);
              const updated: Row[] = [];
              for (const row of rowsFor(table)) {
                if (predicateFn(row)) {
                  Object.assign(row, patch);
                  updated.push({ ...row });
                }
              }
              return Promise.resolve(updated);
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(where: unknown) {
          const predicateFn = compileCondition(table, where);
          const rows = rowsFor(table);
          const deleted: Row[] = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            if (predicateFn(rows[i])) {
              deleted.push(rows[i]);
              rows.splice(i, 1);
            }
          }
          const done = async () => deleted;
          const promise = done() as Promise<Row[]> & { returning: () => Promise<Row[]> };
          promise.returning = async () => deleted;
          return promise;
        },
      };
    },
    transaction: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
  };
}

const MODEL_MODULE_ID = "mod-model-1";
const INSTRUCTION_MODULE_ID = "mod-instruction-1";

function seedModuleRows(): void {
  store.model_modules.push({ id: MODEL_MODULE_ID, provider: "google", modelName: "gemini-2.0-flash" });
  store.instruction_modules.push({ id: INSTRUCTION_MODULE_ID, name: "basic" });
}

function createInput(name: string) {
  return {
    name,
    title: "Roster Probe",
    authorityLevel: 3 as const,
    modelModuleId: MODEL_MODULE_ID,
    instructionModuleId: INSTRUCTION_MODULE_ID,
    memorySharingPolicy: "full" as const,
  };
}

describe("PERF-2 · roster TTL cache", () => {
  let restoreCache: (() => void) | null = null;

  beforeEach(() => {
    resetRosterStore();
    seedModuleRows();
    invalidateRosterCache();
    restoreCache = enableRosterCacheForTests();
  });

  afterEach(() => {
    restoreCache?.();
    restoreCache = null;
  });

  it("second list() within the TTL is served from cache (no extra scan)", async () => {
    store.agents.push({ id: "a-1", name: "Alpha", authorityLevel: 3, isTemplate: false, archivedAt: null });

    const first = await agentRegistry.list({ isTemplate: false });
    expect(agentsFindManyCalls.count).toBe(1);

    const second = await agentRegistry.list({ isTemplate: false });
    expect(agentsFindManyCalls.count).toBe(1);
    expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));
  });

  it("create invalidates the cached roster", async () => {
    await agentRegistry.create(createInput("Fresh"));

    const before = agentsFindManyCalls.count;
    const roster = await agentRegistry.list({ isTemplate: false });
    expect(roster.some((a) => a.name === "Fresh")).toBe(true);
    expect(agentsFindManyCalls.count).toBe(before + 1);

    const again = await agentRegistry.list({ isTemplate: false });
    expect(agentsFindManyCalls.count).toBe(before + 1);
    expect(again.some((a) => a.name === "Fresh")).toBe(true);
  });

  it("update and delete invalidate the cached roster", async () => {
    const created = await agentRegistry.create(createInput("Mutable"));

    const beforeUpdate = agentsFindManyCalls.count;
    await agentRegistry.update(created.id, { title: "Renamed Probe" });
    const afterUpdate = await agentRegistry.list({ isTemplate: false });
    expect(afterUpdate.find((a) => a.id === created.id)?.title).toBe("Renamed Probe");
    expect(agentsFindManyCalls.count).toBeGreaterThan(beforeUpdate);

    const beforeDelete = agentsFindManyCalls.count;
    const deleted = await agentRegistry.delete(created.id);
    expect(deleted).toBe(true);
    const afterDelete = await agentRegistry.list();
    expect(afterDelete.some((a) => a.id === created.id)).toBe(false);
    expect(agentsFindManyCalls.count).toBeGreaterThan(beforeDelete);
  });

  it("archived rows never enter the cache (DB-3 guard holds through cache)", async () => {
    store.agents.push({
      id: "a-live",
      name: "Live",
      authorityLevel: 3,
      isTemplate: false,
      archivedAt: null,
    });
    store.agents.push({
      id: "a-archived",
      name: "Ghost",
      authorityLevel: 3,
      isTemplate: false,
      archivedAt: new Date(),
    });

    const roster = await agentRegistry.list({ isTemplate: false });
    expect(roster.map((a) => a.id)).toEqual(["a-live"]);

    const cached = await agentRegistry.list({ isTemplate: false });
    expect(cached.map((a) => a.id)).toEqual(["a-live"]);
    expect(agentsFindManyCalls.count).toBe(1);
  });
});

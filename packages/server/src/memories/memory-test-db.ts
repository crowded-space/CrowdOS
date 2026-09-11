import { Column, Param, SQL, StringChunk } from "drizzle-orm";
import * as schema from "../db/schema.js";

export interface MemTestStore {
  agents: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  log: Record<string, unknown>[];
  dbCalls: number;
}

export const memTestStore: MemTestStore = {
  agents: [],
  channels: [],
  notes: [],
  log: [],
  dbCalls: 0,
};

export function resetMemTestStore(): void {
  memTestStore.agents.length = 0;
  memTestStore.channels.length = 0;
  memTestStore.notes.length = 0;
  memTestStore.log.length = 0;
  memTestStore.dbCalls = 0;
}

export function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

function snakeName(tsName: string): string {
  return tsName.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function tableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

function rowsFor(table: unknown): Row[] {
  switch (tableName(table)) {
    case "agents": return memTestStore.agents;
    case "channels": return memTestStore.channels;
    case "agent_memory_notes": return memTestStore.notes;
    case "memory_update_log": return memTestStore.log;
    default: throw new Error(`memTestDb: unmapped table ${String(tableName(table))}`);
  }
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
        throw new Error(`memTestDb: unsupported operator '${normalized}'`);
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
      throw new Error(`memTestDb: unknown order column ${String(prop)}`);
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

function sqlText(node: SQL): string {
  let out = "";
  for (const chunk of node.queryChunks) {
    const kind = chunkKind(chunk);
    if (chunk instanceof StringChunk || kind === "StringChunk") out += ((chunk as StringChunk).value ?? []).join("");
    else if (chunk instanceof SQL || kind === "SQL") out += sqlText(chunk as SQL);
    else out += "?";
  }
  return out;
}

export function buildMemTestDb() {
  return {
    insert(table: unknown) {
      memTestStore.dbCalls++;
      return {
        values(values: Row) {
          const rec: Row = { ...values };
          for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
            if (!(col instanceof Column) || rec[key] !== undefined || !col.hasDefault) continue;
            const candidate = (col as any).defaultFn
              ? (col as any).defaultFn()
              : (col as any).default;
            if (
              candidate !== undefined &&
              candidate !== null &&
              !(candidate instanceof SQL) &&
              !(candidate instanceof Param)
            ) {
              rec[key] = candidate;
            }
          }
          if (rec.createdAt === undefined) rec.createdAt = new Date();
          if (rec.updatedAt === undefined) rec.updatedAt = new Date();
          rowsFor(table).push(rec);
          const done = async () => rec;
          const promise = done() as Promise<Row> & { returning: () => Promise<Row[]> };
          promise.returning = async () => [{ ...rec }];
          return promise;
        },
      };
    },
    update(table: unknown) {
      memTestStore.dbCalls++;
      return {
        set(patch: Row) {
          return {
            where(where: unknown) {
              const predicate = compileCondition(table, where);
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
      memTestStore.dbCalls++;
      return {
        where(where: unknown) {
          const predicate = compileCondition(table, where);
          const rows = rowsFor(table);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (predicate(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve([] as Row[]);
        },
      };
    },
    select(fields: Record<string, unknown>) {
      memTestStore.dbCalls++;
      return {
        from(table: unknown) {
          let source: Row[] = rowsFor(table);
          let predicate: Predicate = () => true;
          const run = (): Row[] => {
            const matched = source.filter(predicate);
            const out: Row = {};
            for (const [alias, expr] of Object.entries(fields)) {
              if (expr instanceof SQL && sqlText(expr).toLowerCase().includes("count")) {
                out[alias] = matched.length;
              } else if (expr instanceof Column) {
                out[alias] = matched.length > 0 ? matched[0][tsKeyOf(table, expr)] : null;
              } else {
                out[alias] = null;
              }
            }
            return [out];
          };
          return {
            where(where: unknown) {
              predicate = compileCondition(table, where);
              return run();
            },
            groupBy(_cols: unknown) {
              return this;
            },
            having(_cond: unknown) {
              return this;
            },
            then(onFulfilled?: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
              return Promise.resolve(run()).then(onFulfilled, onRejected);
            },
            catch(onRejected: (err: unknown) => unknown) {
              return Promise.resolve(run()).catch(onRejected);
            },
          };
        },
      };
    },
    query: new Proxy(
      {},
      {
        get(_target, prop: string) {
          const table = Object.values(schema).find(
            (v) => typeof v === "object" && v !== null && (v as any)[Symbol.for("drizzle:Name")] === snakeName(prop),
          );
          if (!table) throw new Error(`memTestDb.query: unknown relation '${String(prop)}'`);

          const findMany = (opts: { where?: unknown; orderBy?: unknown; limit?: number } = {}) => {
            memTestStore.dbCalls++;
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

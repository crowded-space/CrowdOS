import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "./env.js";
import * as schema from "../../db/schema.js";

let sqlClient: postgres.Sql | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

// ponytail: request-scoped tenant handle via stdlib ALS — one mechanism so
// every bare getDb() in the request path resolves to the tenant DB with zero
// per-route/per-service edits. Boot timers/workers run outside any context
// and keep the global pool. Ceiling: explicit dbOverride still wins wherever
// call sites already thread it.
type DbInstance = ReturnType<typeof drizzle<typeof schema>>;
const dbContext = new AsyncLocalStorage<DbInstance>();

/** Run fn with getDb() bound to the given handle (tenant request scope). */
export function runWithDb<T>(db: DbInstance, fn: () => T): T {
  return dbContext.run(db, fn);
}

const dbScopeIds = new WeakMap<object, number>();
let nextDbScopeId = 1;

/**
 * Cache-namespace discriminator for in-memory data caches. "global" outside
 * tenant scope, stable per pooled handle inside it — without this, a roster
 * (or modules/skills/routing) row cached for workspace A is served to B.
 * Rotation creates a new handle (cold cache, safe direction); TTL bounds
 * stale entries from retired handles.
 */
export function dbScopeKey(): string {
  const store = dbContext.getStore();
  if (!store) return "global";
  let id = dbScopeIds.get(store);
  if (id === undefined) {
    id = nextDbScopeId++;
    dbScopeIds.set(store, id);
  }
  return `ws${id}`;
}

function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Configure it before using the database layer.");
  }

  return env.DATABASE_URL;
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getSqlClient(): postgres.Sql {
  if (!sqlClient) {
    // Pool is shared by API + workers. connect_timeout bounds how long a query
    // waits for a free slot before pool exhaustion (incl. 53300) surfaces to callers.
    // M5: prepare:true for plan caching + statement_timeout 15s so one slow
    // query can't pin a slot; keep DB_POOL_MAX / connect/idle timeouts as-is.
    const poolMax = parsePositiveIntEnv(process.env.DB_POOL_MAX, 20);
    const connectTimeout = parsePositiveIntEnv(process.env.DB_CONNECT_TIMEOUT_S, 10);
    sqlClient = postgres(requireDatabaseUrl(), {
      prepare: true,
      max: poolMax,
      idle_timeout: 20,
      connect_timeout: connectTimeout,
      max_lifetime: 60 * 30,
      connection: { statement_timeout: 15000 },
      onnotice: () => {},
    });
    console.log(`[db] pool init max=${poolMax} connect_timeout=${connectTimeout}s statement_timeout=15s`);
  }

  return sqlClient;
}

export function getDb(): DbInstance {
  return dbContext.getStore() ?? (dbInstance ??= drizzle(getSqlClient(), { schema }));
}

/** Transaction client handed to withTransaction callbacks. */
export type DbTx = Parameters<Parameters<DbInstance["transaction"]>[0]>[0];

/** Either the standalone pool-backed db or an in-flight transaction. */
export type DbLike = DbInstance | DbTx;

/**
 * DB-2: run `fn` inside a single postgres transaction; any thrown error rolls
 * back every write performed through the provided client.
 */
export async function withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

export async function ensurePgVectorExtension(): Promise<void> {
  const sql = getSqlClient();

  try {
    await sql`create extension if not exists vector`;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "23505" || error.code === "42710")
    ) {
      return;
    }

    throw error;
  }
}

export async function closeDatabaseConnection(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
  }
}

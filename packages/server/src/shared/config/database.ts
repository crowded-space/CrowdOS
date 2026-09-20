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
    throw new Error(
      "DATABASE_URL is not set. Local workspace registry remains available; PG-backed features (chat history, RAG) are degraded until a database is configured."
    );
  }

  return env.DATABASE_URL;
}

/** C3 local-first (§17-18): true when a PG URL is configured. */
export function isDatabaseConfigured(): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

// ─── Local-truth tier resolution (CrowdOS §17) ──────────────────────────
// Local files are truth; PG is a best-effort write-through replica.
// Workspaces resolve an effective store tier per call: "dual" (write PG +
// local, read PG) or "local" (PG paused or unreachable). Preference lives on
// the registry record so it survives DB outages; reachability is cached
// per URL so one outage doesn't add a timeout to every request.
// Converge is local-wins only (push); PG→local union/resequence is removed.

export type StoreTier = "dual" | "local";

const UNAVAILABLE_TTL_MS = 20_000;
const unreachableUntil = new Map<string, number>();

/** Explicit "no database configured here" marker (record-only tiers). */
export const NO_DATABASE_CODE = "NO_DATABASE";

export function isNoDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).code === NO_DATABASE_CODE;
}

/** Connection-class failures (worth falling back) vs logic errors (not). */
export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isNoDatabaseError(err)) return true;
  const code = String((err as any).code ?? "");
  const message = String((err as any).message ?? "").toLowerCase();
  if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNRESET)$/.test(code)) return true;
  if (/^(08|57P01|57P02|57P03|53300)/.test(code)) return true;
  if (!code && /database_url is not set|fetch failed|connection (refused|timed out|terminated)|timeout|econn/i.test(message)) {
    return true;
  }
  return false;
}

export function noteDbFailure(url: string | null | undefined, err: unknown): void {
  if (!url || !isConnectionError(err)) return;
  unreachableUntil.set(url, Date.now() + UNAVAILABLE_TTL_MS);
}

export function noteDbSuccess(url: string | null | undefined): void {
  if (!url) return;
  unreachableUntil.delete(url);
}

/** True when the URL is configured and not inside a cached outage window. */
export function isUrlReachable(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return false;
  const until = unreachableUntil.get(trimmed);
  if (until === undefined) return true;
  if (until <= Date.now()) {
    unreachableUntil.delete(trimmed);
    return true;
  }
  return false;
}

export interface TierContext {
  /** Per-workspace DB URL (record) — falls back to the global URL. */
  databaseUrl?: string | null;
  /** Registry preference — absent means "default". */
  storagePreference?: string | null;
  /** Workspace id the op belongs to (for backlog attribution). */
  workspaceId?: string | null;
}

/**
 * Resolve the effective store tier. Record-only (CrowdOS local-first):
 * the URL comes exclusively from the workspace registry record
 * (`ctx.databaseUrl`). The process env URL is CLI-only (drizzle-kit
 * migrations/seed, tests) and is NEVER consulted at runtime, so a
 * hardcoded .env URL can no longer become a silent predetermined database.
 * "local" when preference forces it, when no record URL resolves, or when
 * the URL sits inside an outage window.
 */
export function resolveTier(ctx: TierContext = {}): { tier: StoreTier; url: string | null } {
  const url = ctx.databaseUrl?.trim() || null;
  if (ctx.storagePreference === "local") return { tier: "local", url };
  if (!url || !isUrlReachable(url)) return { tier: "local", url };
  return { tier: "dual", url };
}

/**
 * §17 local-first READ: the local store is the source of truth, so it is
 * consulted FIRST and its answer wins whenever it has content for the query.
 *
 * PG is a gap-filler, not a peer: it is read only when the local tier returns
 * nothing for the query (a workspace whose rows still live only in PG, or
 * content written by another process before this workspace’s first local
 * append). PG results are returned read-only and are NEVER written back —
 * moving PG content into the local tier stays an explicit pull/import
 * (workspace-sync).
 *
 * Failure policy: a local-tier throw is a real failure (it is the truth tier)
 * and is only rescued by a successful PG read. A PG read failure degrades to
 * the local answer, flagging the outage window on connection-class errors;
 * logic errors from PG propagate, because they must not be masked.
 */
export async function withStoreFallback<T>(
  ctx: TierContext,
  dbOp: () => Promise<T>,
  localOp: () => Promise<T>,
  opts: { localIsEmpty?: (value: T) => boolean } = {},
): Promise<T> {
  const { tier, url } = resolveTier(ctx);
  const isEmpty = opts.localIsEmpty ?? defaultLocalIsEmpty;
  // Tier "local" (forced-local preference, no URL, or cached outage window):
  // the local tier is the only tier — there is nothing to fall back to.
  if (tier === "local") return localOp();

  let localValue: T;
  try {
    localValue = await localOp();
  } catch (localErr) {
    try {
      const out = await dbOp();
      noteDbSuccess(url);
      return out;
    } catch {
      throw localErr;
    }
  }
  if (!isEmpty(localValue)) return localValue;

  // Local tier has nothing for this query — ask the replica.
  try {
    const out = await dbOp();
    noteDbSuccess(url);
    return out;
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    noteDbFailure(url, err);
    return localValue;
  }
}

/**
 * Default emptiness probe for the local-first read order: a local tier that
 * produced no rows has no opinion, so the PG gap-filler may answer. A non-empty
 * array is a real answer; scalars/objects always count as answers.
 */
function defaultLocalIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * §17 local-first WRITE: the local store is written FIRST and is the commit
 * point; PG is a best-effort replica fed afterwards.
 *
 * Ordering rationale: the document names exactly one source of truth. Writing
 * PG first made it de-facto primary — a PG success turned the local file into a
 * derivative copy, and the two legs could disagree. Local first means a local
 * success IS a durable success, and every PG failure (connection-class or a
 * logic error) is queued on the outbox for replay instead of being reported to
 * a caller whose write already committed.
 *
 * Callers still validate before mutating (guards run first). A local failure
 * propagates and PG is never touched. Returns the local result (single stable
 * shape for routes).
 */
export async function dualWrite<T>(opts: {
  ctx: TierContext;
  entity: "category" | "channel" | "agent" | "message";
  op: "upsert" | "delete";
  id: string;
  row?: Record<string, unknown> | null;
  pgWrite: () => Promise<unknown>;
  localWrite: () => Promise<T>;
}): Promise<T> {
  const { tier, url } = resolveTier(opts.ctx);
  // 1. Local commit — the source of truth. A throw propagates; PG untouched.
  const out = await opts.localWrite();
  // No replica target configured: nothing to converge to later.
  if (!url) return out;

  const queueReplica = async (reason: unknown, connectionClass: boolean): Promise<void> => {
    const { appendOutbox } = await import("../core/outbox.js");
    await appendOutbox({
      workspaceId: opts.ctx.workspaceId ?? null,
      entity: opts.entity,
      op: opts.op,
      rowId: opts.id,
      row: opts.row ?? null,
    }).catch(() => {});
    console.warn(
      "[dualWrite] local " + opts.op + " " + opts.entity + ":" + opts.id +
        " committed; PG replica leg failed (" + (connectionClass ? "connection" : "logic") +
        ") and was queued for replay: " + (reason instanceof Error ? reason.message : String(reason)),
    );
  };

  // Paused (storage preference) or inside a cached outage window: the local
  // commit stands and the row is queued for convergence.
  if (tier === "local") {
    await queueReplica(new Error("PG tier paused or unreachable"), true);
    return out;
  }

  // 2. Replica leg. A failure here must never surface as a caller-visible
  // error: local already committed, so the write is durable.
  try {
    await opts.pgWrite();
    noteDbSuccess(url);
  } catch (err) {
    const connectionClass = isConnectionError(err);
    if (connectionClass) noteDbFailure(url, err);
    await queueReplica(err, connectionClass);
  }
  return out;
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

/**
 * Resolve the drizzle handle for a workspace's record database.
 * Record-only: throws NO_DATABASE when the workspace has no databaseUrl —
 * callers degrade to local instead. NEVER falls back to the process env URL
 * (CLI-only); that fallback was the "single predetermined db" leak.
 * NOTE: workspace-handle threading is complete for runs/tokens/snapshot;
 * memories still consult the env gate until their API carries workspace
 * context (documented gap).
 */
export async function dbForWorkspace(workspaceId: string | null | undefined): Promise<DbInstance> {
  if (!workspaceId) {
    throw Object.assign(new Error("NO_DATABASE: no workspace context (local-only)"), { code: NO_DATABASE_CODE });
  }
  const { tierContextFor } = await import("../../workspace/workspace-gate.js");
  const ctx = await tierContextFor(workspaceId);
  if (resolveTier(ctx).tier !== "dual") {
    throw Object.assign(new Error(`NO_DATABASE: workspace ${workspaceId} is local-only`), { code: NO_DATABASE_CODE });
  }
  const { getWorkspaceDb } = await import("../../workspace/workspace-gate.js");
  return (await getWorkspaceDb(workspaceId)).db as DbInstance;
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

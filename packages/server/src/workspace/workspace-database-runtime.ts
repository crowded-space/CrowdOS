// ─── Workspace Database Runtime (Phase 2: DB routing) ───────────────
// Pooled per-workspace Postgres handles with an LRU cap, idle eviction, and
// URL-hash rotation. Secrets live only in workspaces.json connection strings
// held in memory — never in logs or errors.
// ponytail: `.env` lookup kept as legacy fallback; remove when importer lands.
//
// Routing contract (workspace-scoped):
//   - `getWorkspaceDb(workspaceId)` resolves `{ db, source: "workspace" }`
//     from the registry record (or per-workspace env file).
//   - No id or no assigned URL throws NO_DATABASE — NEVER the process-wide
//     DATABASE_URL pool (that fallback was the "single predetermined db" leak).
//     Callers degrade to local files.
//   - `source === "global"` is retained on the type for the tenant hook's
//     local-mode branch but is no longer produced here.
//   - One drizzle handle === one Postgres database: never mix handles inside
//     a single transaction.

import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDb } from "../shared/config/database.js";
import * as schema from "../db/schema.js";
import { readWorkspaceDatabaseUrl } from "./workspace-database.js";
import { getWorkspaceRecord, listWorkspaceRecords } from "./workspace-registry.js";

export type WorkspaceDbSource = "workspace" | "global";

export interface ResolvedWorkspaceDb {
  db: ReturnType<typeof getDb>;
  source: WorkspaceDbSource;
  workspaceId: string | null;
}

interface PooledWorkspaceDb {
  sql: postgres.Sql;
  db: ReturnType<typeof getDb>;
  urlHash: string;
  lastUsed: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function maxPools(): number {
  return envInt("CROWDOS_WS_DB_MAX_POOLS", 10);
}

function idleEvictMs(): number {
  return envInt("CROWDOS_WS_DB_IDLE_MS", 10 * 60 * 1000);
}

const pools = new Map<string, PooledWorkspaceDb>();

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function openPool(url: string): PooledWorkspaceDb {
  const sql = postgres(url, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }), urlHash: hashUrl(url), lastUsed: Date.now() };
}

async function evictIdle(now: number): Promise<void> {
  const idleMs = idleEvictMs();
  const stale: string[] = [];
  for (const [id, pool] of pools) {
    if (now - pool.lastUsed > idleMs) stale.push(id);
  }
  await Promise.all(stale.map((id) => closeWorkspaceDatabase(id)));
}

/**
 * Resolve the drizzle handle for a workspace-assigned database. Throws
 * NO_DATABASE when no id or database URL is assigned — NEVER falls back to the
 * process-wide DATABASE_URL pool (that fallback was the "single predetermined
 * db" leak). Callers degrade to local.
 * Rotates the pooled handle when the assigned URL changed on disk.
 */
const rotationChains = new Map<string, Promise<void>>();

export async function getWorkspaceDb(
  workspaceId?: string | null,
  opts?: { envPath?: string },
): Promise<ResolvedWorkspaceDb> {
  if (!workspaceId) {
    throw Object.assign(new Error("NO_DATABASE: no workspace context (local-only)"), { code: "NO_DATABASE" });
  }
  // WS-007: serialize rotation per workspace. Concurrent callers during a
  // URL change both saw the stale pool and orphaned a client. Chain on a
  // per-id promise so only one rotation runs at a time.
  const prev = rotationChains.get(workspaceId) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>((res) => { release = res; });
  rotationChains.set(workspaceId, prev.then(() => turn));
  await prev;
  try {
    return await getWorkspaceDbInner(workspaceId, opts);
  } finally {
    release();
    if (rotationChains.get(workspaceId)?.then) {
      // Leave chain cleanup to the next waiter; bounded by workspace count.
    }
  }
}

async function getWorkspaceDbInner(
  workspaceId: string,
  opts?: { envPath?: string },
): Promise<ResolvedWorkspaceDb> {
  let url: string | null = null;
  try {
    const regRecord = await getWorkspaceRecord(workspaceId);
    if (regRecord?.databaseUrl?.trim()) url = regRecord.databaseUrl.trim();
  } catch {}
  if (!url) url = (await readWorkspaceDatabaseUrl(workspaceId, opts))?.trim() || null;
  if (!url) {
    throw Object.assign(new Error(`NO_DATABASE: workspace ${workspaceId} has no databaseUrl (local-only)`), { code: "NO_DATABASE" });
  }

  const existing = pools.get(workspaceId);
  if (existing) {
    if (existing.urlHash === hashUrl(url)) {
      existing.lastUsed = Date.now();
      return { db: existing.db, source: "workspace", workspaceId };
    }
    // Assigned URL changed (replace/hand-edit) — drop the stale pool.
    await closeWorkspaceDatabase(workspaceId);
  }

  await evictIdle(Date.now());
  while (pools.size >= maxPools()) {
    let oldestId: string | null = null;
    let oldestUse = Number.POSITIVE_INFINITY;
    for (const [id, pool] of pools) {
      if (pool.lastUsed < oldestUse) {
        oldestUse = pool.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    await closeWorkspaceDatabase(oldestId);
  }

  const pool = openPool(url);
  pools.set(workspaceId, pool);
  return { db: pool.db, source: "workspace", workspaceId };
}

/** Drop one workspace pool (disconnect/replace/delete). Best-effort close. */
export async function closeWorkspaceDatabase(workspaceId: string): Promise<void> {
  const pool = pools.get(workspaceId);
  if (!pool) return;
  pools.delete(workspaceId);
  try {
    await pool.sql.end({ timeout: 5 });
  } catch {
    // ignore close errors
  }
}

/** Drop every workspace pool (shutdown). Best-effort. */
export async function closeAllWorkspaceDatabases(): Promise<void> {
  const ids = [...pools.keys()];
  await Promise.all(ids.map((id) => closeWorkspaceDatabase(id)));
}

/** Pool inventory for diagnostics. Contains ids and sources only — no URLs. */
export function getWorkspaceDbPoolStats(): Array<{ workspaceId: string; lastUsed: number }> {
  return [...pools.entries()].map(([workspaceId, pool]) => ({ workspaceId, lastUsed: pool.lastUsed }));
}

/** Test-only reset: drops pools without touching real connections. */
export function __resetWorkspaceDbPoolsForTests(): void {
  pools.clear();
}

// ponytail: serial + per-target best-effort — one dead database never stalls
// the rest. Only workspace-assigned pools are targets; the process-wide pool
// is never added to tenant fan-out.
// Parallelize if fleets make the serial pass slow.
// ─── SYNC-1 schema readiness (auto schema sync) ─────────────────────────
// A configured database is only query-ready when the CrowdOS relations exist.
// A stale/partial schema (reachable but missing tables) answers NO tenant query
// — without this probe the bind looks healthy while every read degrades. The
// probe is one information_schema query, cached 60s per workspace; unknown
// workspaces and probe failures report `ready: null` (honest unknown), never throw.
const SCHEMA_PROBE_TABLES = ["workspaces", "categories", "channels", "messages", "agents", "runs", "token_usage_log", "model_modules", "channel_settings"] as const;
const SCHEMA_PROBE_TTL_MS = 60_000;
const schemaProbeCache = new Map<string, { at: number; ready: boolean | null; missing: string[] }>();

export async function checkWorkspaceSchemaReady(
  workspaceId: string,
): Promise<{ ready: boolean | null; missing: string[] }> {
  const now = Date.now();
  const hit = schemaProbeCache.get(workspaceId);
  if (hit && now - hit.at < SCHEMA_PROBE_TTL_MS) return { ready: hit.ready, missing: hit.missing };
  const put = (ready: boolean | null, missing: string[]) => {
    if (schemaProbeCache.size > 200) schemaProbeCache.clear();
    schemaProbeCache.set(workspaceId, { at: Date.now(), ready, missing });
    return { ready, missing };
  };
  let resolved: ResolvedWorkspaceDb;
  try {
    resolved = await getWorkspaceDb(workspaceId);
  } catch {
    return put(null, []);
  }
  if (resolved.source !== "workspace") return put(null, []);
  try {
    const rows = (await (resolved.db as any).execute(`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('${SCHEMA_PROBE_TABLES.join("','")}')`)) as unknown as Array<{ table_name: string }>;
    const have = new Set((rows ?? []).map((r) => String((r as any)?.table_name ?? (r as any)?.tableName ?? "")));
    const missing = (SCHEMA_PROBE_TABLES as readonly string[]).filter((t) => !have.has(t));
    return put(missing.length === 0, missing);
  } catch {
    return put(null, []);
  }
}

/** Drop a cached schema probe (bind/change-db, tests). */
export function invalidateWorkspaceSchemaProbe(workspaceId?: string | null): void {
  if (!workspaceId) { schemaProbeCache.clear(); return; }
  schemaProbeCache.delete(workspaceId);
}
export async function forEachWorkspaceDb(
  fn: (db: ReturnType<typeof getDb>, workspaceId: string | null) => Promise<void>,
): Promise<void> {
  const targets: Array<{ db: ReturnType<typeof getDb>; workspaceId: string | null }> = [];
  try {
    const records = await listWorkspaceRecords();
    for (const record of records) {
      const databaseUrl = record.databaseUrl?.trim() || (await readWorkspaceDatabaseUrl(record.id))?.trim();
      if (!databaseUrl) continue;
      try {
        const resolved = await getWorkspaceDb(record.id);
        if (resolved.source === "workspace") targets.push({ db: resolved.db, workspaceId: record.id });
    } catch (err) {
      // WS-008: skipped sweep targets were invisible. Warn with the id so
      // dead databases surface in logs instead of silently losing coverage.
      console.warn(`[workspace] sweep target ${record.id} unreachable, skipping:`, (err as Error)?.message ?? err);
      }
    }
  } catch {
    // Registry unreadable: no sweep targets.
  }
  const seen = new Set<object>();
  for (const target of targets) {
    if (seen.has(target.db)) continue;
    seen.add(target.db);
    try {
      await fn(target.db, target.workspaceId);
    } catch (err) {
      // WS-008: per-target sweep failures were silent coverage loss.
      console.warn(`[workspace] sweep target ${target.workspaceId ?? "unknown"} failed:`, (err as Error)?.message ?? err);
    }
  }
}

// ─── Workspace Database Runtime (Phase 2: DB routing) ───────────────
// Pooled per-workspace Postgres handles with an LRU cap, idle eviction, and
// URL-hash rotation. Secrets live only in workspaces.json connection strings
// held in memory — never in logs or errors.
// ponytail: `.env` lookup kept as legacy fallback; remove when importer lands.
//
// Routing contract (record-only):
//   - `getWorkspaceDb(workspaceId)` resolves `{ db, source: "workspace" }`
//     from the registry record (or per-workspace env file).
//   - No id or no assigned URL throws NO_DATABASE — NEVER the process env
//     pool (that fallback was the "single predetermined db" leak; env URLs
//     are CLI-only). Callers degrade to local files.
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
 * Resolve the drizzle handle for a workspace's record database. Record-only:
 * throws NO_DATABASE when no id is given or no database URL is assigned —
 * NEVER falls back to the process env pool (that fallback was the "single
 * predetermined db" leak; env URLs are CLI-only). Callers degrade to local.
 * Rotates the pooled handle when the assigned URL changed on disk.
 */
export async function getWorkspaceDb(
  workspaceId?: string | null,
  opts?: { envPath?: string },
): Promise<ResolvedWorkspaceDb> {
  if (!workspaceId) {
    throw Object.assign(new Error("NO_DATABASE: no workspace context (local-only)"), { code: "NO_DATABASE" });
  }
  let url: string | null = null;
  try {
    const regRecord = await getWorkspaceRecord(workspaceId);
    if (regRecord?.databaseUrl) url = regRecord.databaseUrl;
  } catch {}
  if (!url) url = await readWorkspaceDatabaseUrl(workspaceId, opts);
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
// the rest. Record-only: no global-pool target (env URLs are CLI-only).
// Parallelize if fleets make the serial pass slow.
export async function forEachWorkspaceDb(
  fn: (db: ReturnType<typeof getDb>, workspaceId: string | null) => Promise<void>,
): Promise<void> {
  const targets: Array<{ db: ReturnType<typeof getDb>; workspaceId: string | null }> = [];
  try {
    const records = await listWorkspaceRecords();
    for (const record of records) {
      if (!record.databaseUrl?.trim()) continue;
      try {
        const resolved = await getWorkspaceDb(record.id);
        if (resolved.source === "workspace") targets.push({ db: resolved.db, workspaceId: record.id });
      } catch {
        // Skip dead databases.
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
    } catch {
      // Next workspace.
    }
  }
}

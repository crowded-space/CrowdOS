// ─── Workspace Database (BYODB) ─────────────────────────────────────
// Bring-your-own-database: each workspace may point at its own PostgreSQL
// instance. The secret itself lives ONLY in the local `.env` file under a
// per-workspace key (`CROWDOS_WS_<ID>_DATABASE_URL`); the workspace row in
// Postgres keeps just a non-secret descriptor (host/port/db name) inside
// `metadata.database` so API responses never leak credentials.
//
// The `CROWDOS_WS_` prefix intentionally matches none of the
// PROJECT_ENV_PREFIXES in Shared/config/env.ts, so managed keys stay inert
// for strict config boot.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { TtlCache } from "../shared/core/ttl-cache.js";

// ponytail: .env path cached 60s — walk did up to 5 access probes per getWorkspaceDb call.
const envPathCache = new TtlCache<string>(60_000, 100);

export const WORKSPACE_DB_ENV_PREFIX = "CROWDOS_WS_";
export const WORKSPACE_DB_ENV_SUFFIX = "_DATABASE_URL";
const MANAGED_HEADER = "# Per-workspace databases (BYODB) — managed by Crowd OS.";
const MAX_URL_LENGTH = 2000;

export interface WorkspaceDatabaseDescriptor {
  configured: boolean;
  host?: string;
  port?: number | null;
  database?: string;
  /** True when the Crowd OS schema was provisioned on this database
   * (migrations applied). False/unknown otherwise — reads/writes still
   * route there, but may fail until provisioned. */
  schemaReady?: boolean;
  updatedAt?: string;
}

export interface WorkspaceDatabaseTestResult {
  host: string;
  port: number | null;
  database: string;
}

/** Env key for a workspace id. Sanitized to `[A-Z0-9_]` so it is `.env`-safe. */
export function workspaceDatabaseEnvKey(workspaceId: string): string {
  const sanitized = workspaceId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  if (!sanitized) throw new Error("Invalid workspace id for database key.");
  return `${WORKSPACE_DB_ENV_PREFIX}${sanitized}${WORKSPACE_DB_ENV_SUFFIX}`;
}

function fail(message: string): never {
  throw new Error(`Invalid workspace database URL: ${message}`);
}

/** Shape-validate a user-supplied Postgres URL. Never logs or stores it. */
export function parseWorkspaceDatabaseUrl(raw: string): { url: string; host: string; port: number | null; database: string } {
  const url = raw.trim();
  if (!url) fail("empty value.");
  if (url.length > MAX_URL_LENGTH) fail(`exceeds ${MAX_URL_LENGTH} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F]/.test(url)) fail("contains control characters.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail("unparseable. Expected postgresql://user:password@host:5432/dbname.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed!.protocol)) {
    fail("must use the postgres:// or postgresql:// scheme.");
  }
  if (!parsed!.hostname) fail("missing host.");
  const database = parsed!.pathname.replace(/^\//, "").split("/")[0] ?? "";
  return {
    url,
    host: parsed!.hostname,
    port: parsed!.port ? Number(parsed!.port) : null,
    database: database ? decodeURIComponent(database) : "",
  };
}

/** Non-secret descriptor safe to persist in workspace metadata + API output. */
export function describeWorkspaceDatabaseUrl(raw: string, schemaReady = false): WorkspaceDatabaseDescriptor {
  const parsed = parseWorkspaceDatabaseUrl(raw);
  return {
    configured: true,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    schemaReady,
    updatedAt: new Date().toISOString(),
  };
}

/** Nearest `.env` walking up from cwd (dev: packages/server/.env, root runs: .env).
 * `CROWDOS_WS_ENV_FILE` overrides the location outright (custom layouts, tests).
 * Async (access probes) so per-request `getWorkspaceDb` calls never block the loop. */
export async function resolveWorkspaceEnvFilePath(startDir: string = process.cwd()): Promise<string> {
  const override = process.env.CROWDOS_WS_ENV_FILE?.trim();
  if (override) return resolve(override);
  const cacheKey = resolve(startDir);
  const cached = envPathCache.get(cacheKey);
  if (cached) return cached;
  let dir = cacheKey;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, ".env");
    try {
      await fs.access(candidate);
      envPathCache.set(cacheKey, candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = join(cacheKey, ".env");
  envPathCache.set(cacheKey, fallback);
  return fallback;
}

function escapeEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// In-process mutex serializing `.env` read-modify-write cycles so concurrent
// workspace creates/updates/deletes cannot silently drop each other's keys
// (last-writer-wins on a stale read). Cross-process races remain possible but
// are out of scope for the single-user desktop app.
let envWriteChain: Promise<void> = Promise.resolve();

function withEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = envWriteChain.then(fn, fn);
  envWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Insert or replace the workspace key in the local `.env`, preserving every
 * other line byte-for-byte. Atomic via tmp-file rename in the same directory.
 * Returns the env key that was written.
 */
export async function upsertWorkspaceDatabaseEnv(
  workspaceId: string,
  databaseUrl: string,
  opts?: { envPath?: string },
): Promise<string> {
  const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
  const key = workspaceDatabaseEnvKey(workspaceId);
  const envPath = opts?.envPath ?? (await resolveWorkspaceEnvFilePath());

  return withEnvLock(async () => {
    let current = "";
    try {
      current = await fs.readFile(envPath, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw new Error(`Failed to read workspace env file: ${err?.message ?? err}`);
    }

    const lines = current ? current.split("\n") : [];
    const kept = lines.filter((line) => !line.startsWith(`${key}=`));
    if (!kept.some((line) => line.trim() === MANAGED_HEADER)) {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== "") kept.push("");
      kept.push(MANAGED_HEADER);
    }
    kept.push(`${key}=${escapeEnvValue(parsed.url)}`);
    const next = `${kept.join("\n").replace(/\n+$/, "\n")}`;

    const tmpPath = join(dirname(envPath) || tmpdir(), `.env.crowdos-tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmpPath, next, { mode: 0o600 });
      await fs.rename(tmpPath, envPath);
    } catch (err: any) {
      try { await fs.rm(tmpPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`Failed to persist workspace database configuration: ${err?.message ?? err}`);
    }
    // The on-disk content changed outside the reader cache path — drop the
    // cached parse so subsequent reads see this write.
    clearWorkspaceEnvCache(envPath);
    return key;
  });
}

/** Remove the workspace key from the local `.env` (best-effort; no-op if absent). */
export async function removeWorkspaceDatabaseEnv(workspaceId: string, opts?: { envPath?: string }): Promise<void> {
  const key = workspaceDatabaseEnvKey(workspaceId);
  const envPath = opts?.envPath ?? (await resolveWorkspaceEnvFilePath());
  return withEnvLock(async () => {
    let current: string;
    try {
      current = await fs.readFile(envPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw new Error(`Failed to read workspace env file: ${err?.message ?? err}`);
    }
    const kept = current.split("\n").filter((line) => !line.startsWith(`${key}=`));
    if (kept.length === current.split("\n").length) return;
    const tmpPath = join(dirname(envPath) || tmpdir(), `.env.crowdos-tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmpPath, kept.join("\n"), { mode: 0o600 });
      await fs.rename(tmpPath, envPath);
    } catch (err: any) {
      try { await fs.rm(tmpPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`Failed to persist workspace database configuration: ${err?.message ?? err}`);
    }
    clearWorkspaceEnvCache(envPath);
  });
}

/**
 * Read-only connectivity probe against a user-supplied URL: opens a
 * single short-lived connection, runs `select 1`, closes it. Rejects with a
 * redacted, user-facing message (never echoes the URL or credentials).
 */
export async function testWorkspaceDatabaseConnection(databaseUrl: string, timeoutMs = 8000): Promise<WorkspaceDatabaseTestResult> {
  const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(parsed.url, {
      max: 1,
      prepare: false,
      connect_timeout: Math.min(10, Math.max(1, Math.ceil(timeoutMs / 1000))),
      idle_timeout: 5,
      max_lifetime: 10,
      onnotice: () => {},
    });
    const run = (async () => {
      await sql!`select 1 as ok`;
    })();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("timed out"), { code: "CONNECT_TIMEOUT" }));
      }, timeoutMs);
      timer.unref?.();
    });
    // Abort promptly kills the pending query's conn; finally ends the pool.
    controller.signal.addEventListener("abort", () => {
      void sql?.end({ timeout: 2 }).catch(() => {});
    }, { once: true });
    try {
      await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { host: parsed.host, port: parsed.port, database: parsed.database };
  } catch (err: any) {
    throw new Error(mapConnectionError(err));
  } finally {
    if (sql) {
      try { await sql.end({ timeout: 2 }); } catch { /* ignore close errors */ }
    }
  }
}

function mapConnectionError(err: any): string {
  const code = err?.code as string | undefined;
  if (code === "28P01" || code === "28P04" || code === "28000") {
    return "Authentication failed — check the username and password.";
  }
  if (code === "3D000") return "Connected, but the database does not exist.";
  if (code === "ECONNREFUSED") return "Connection refused — check the host/port and that Postgres is running.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Hostname could not be resolved — check the host.";
  if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "Connection timed out — check the host/port and network.";
  const detail = typeof err?.message === "string" ? err.message.slice(0, 160) : "Connection failed.";
  return `Connection failed${code ? ` (${code})` : ""}: ${detail}`;
}

// ─── Live disk reader (Phase 1: no restart required) ─────────────────
// The runtime resolves per-workspace URLs straight from the `.env` file on
// disk, so assigning/replacing a database takes effect immediately.

function parseDotenvValue(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  const comment = text.indexOf(" #");
  return (comment >= 0 ? text.slice(0, comment) : text).trim();
}

function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = body.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = body.slice(0, eqIdx).trim();
    if (!name || /\s/.test(name)) continue;
    values.set(name, parseDotenvValue(body.slice(eqIdx + 1)));
  }
  return values;
}

/**
 * Resolve the live per-workspace database URL. Explicit `process.env` wins
 * (operator override); otherwise the nearest `.env` is read from disk with
 * an mtime/size cache so hand-edits and portal saves apply without restart.
 * Returns `null` when the workspace has no database assigned. Never logs.
 */
export async function readWorkspaceDatabaseUrl(
  workspaceId: string,
  opts?: { envPath?: string },
): Promise<string | null> {
  const key = workspaceDatabaseEnvKey(workspaceId);
  const override = process.env[key]?.trim();
  if (override) return override;
  const envPath = opts?.envPath ?? (await resolveWorkspaceEnvFilePath());
  try {
    // ponytail: tiny file, always re-read; mtime+size misses same-size rotations
    const text = await fs.readFile(envPath, "utf8");
    return parseDotenv(text).get(key) ?? null;
  } catch {
    return null;
  }
}

/** Drop the cached `.env` path (tests, or forced refresh after external edits). */
export function clearWorkspaceEnvCache(_envPath?: string): void {
  envPathCache.clear();
}

// ─── Schema provisioning (Phase 3) ────────────────────────────────────
// Applies the standard Crowd OS drizzle migrations to a user-supplied
// database so a fresh BYODB instance can actually serve workspace content.
// Migrations only — global seed data (agents, modules, default channel) is
// deliberately NEVER written to workspace databases.

export interface WorkspaceDatabaseProvisionResult {
  migrationsApplied: number;
  message: string;
}

function resolveMigrationsFolder(): string {
  // Mirrors db/bootstrap.ts resolution without importing it (that module runs
  // global migrations on import as a side effect). From src/workspace/ and
  // dist/workspace/ alike, ../db/migrations is the migrations folder.
  // ponytail: the old existsSync probe returned the same candidate either way — dropped.
  const candidate = fileURLToPath(new URL("../db/migrations", import.meta.url));
  return candidate;
}

function mapProvisionError(err: any): string {
  const raw = typeof err?.message === "string" ? err.message : String(err ?? "Migration failed.");
  const code = err?.code as string | undefined;
  if (/permission denied|must be (owner|superuser)|CREATE EXTENSION/i.test(raw)) {
    return "Migration needs elevated privileges (e.g. CREATE EXTENSION for pg_trgm/vector). Grant them or ask the database owner to run the Crowd OS migrations first.";
  }
  if (code === "3D000") return "Connected, but the database does not exist.";
  if (code === "28P01" || code === "28P04" || code === "28000") {
    return "Authentication failed — check the username and password.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Hostname could not be resolved — check the host.";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "PROVISION_TIMEOUT") {
    return "Provisioning timed out or was refused — check the host/port and that Postgres accepts connections.";
  }
  return `Schema provisioning failed${code ? ` (${code})` : ""}: ${raw.slice(0, 200)}`;
}

/**
 * Apply Crowd OS migrations to the given database URL over a short-lived
 * connection. Idempotent (drizzle journal) — safe to retry. Rejects with a
 * redacted, user-facing message. Never echoes the URL or credentials.
 */
export async function provisionWorkspaceDatabase(
  databaseUrl: string,
  timeoutMs = 120000,
): Promise<WorkspaceDatabaseProvisionResult> {
  const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(parsed.url, {
      max: 1,
      prepare: false,
      connect_timeout: 15,
      idle_timeout: 10,
      max_lifetime: 120,
      onnotice: () => {},
    });
    const run = (async () => {
      await migrate(drizzle(sql!), { migrationsFolder: resolveMigrationsFolder() });
      // Best-effort applied-migration count for UI feedback.
      try {
        const rows = (await sql!`select count(*)::int as n from __drizzle_migrations`) as unknown as Array<{ n: number }>;
        const n = rows[0]?.n;
        return typeof n === "number" ? n : 0;
      } catch {
        return 0;
      }
    })();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("timed out"), { code: "PROVISION_TIMEOUT" }));
      }, timeoutMs);
      timer.unref?.();
    });
    controller.signal.addEventListener("abort", () => {
      void sql?.end({ timeout: 5 }).catch(() => {});
    }, { once: true });
    let migrationsApplied: number;
    try {
      migrationsApplied = await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      migrationsApplied,
      message: `Schema ready — ${migrationsApplied} migration${migrationsApplied === 1 ? "" : "s"} recorded.`,
    };
  } catch (err: any) {
    throw new Error(mapProvisionError(err));
  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 5 });
      } catch {
        /* ignore close errors */
      }
    }
  }
}

import * as schema from "../db/schema.js";

// ponytail: in-process per-database mutex. Concurrent Launches targeting the
// same PostgreSQL database queue instead of driving competing migrate() runs
// into each other's DDL locks (both time out, both abort partial, retries
// poison forever). Multi-instance fleets would need a pg advisory lock.
const provisionLocks = new Map<string, Promise<unknown>>();

function provisionLockKey(databaseUrl: string): string {
  try {
    const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
    return `${parsed.host.toLowerCase()}:${parsed.port ?? "default"}/${parsed.database.toLowerCase()}`;
  } catch {
    return `raw:${databaseUrl.length}`;
  }
}

/** Serialize fn per target database; concurrent callers queue behind the in-flight run. */
export function withProvisionLock<T>(databaseUrl: string, fn: () => Promise<T>): Promise<T> {
  const key = provisionLockKey(databaseUrl);
  const prev = provisionLocks.get(key) ?? Promise.resolve();
  let tail: Promise<unknown>;
  const next = prev.catch(() => {}).then(fn);
  tail = next.then(
    () => {
      if (provisionLocks.get(key) === tail) provisionLocks.delete(key);
    },
    () => {
      if (provisionLocks.get(key) === tail) provisionLocks.delete(key);
    },
  );
  provisionLocks.set(key, tail);
  return next;
}

/**
 * Seeds the minimal standard preset configuration for a freshly provisioned workspace database.
 * Presets:
 * - Category: General
 * - Channels: #general, #crowd-os (with guide message)
 * - Agents: Raven (L0 Assistant) and Owl (L2 Indexer)
 * - WorkspaceSettings row (id: default)
 */
export async function seedWorkspacePresets(
  db: any,
  workspaceId: string = "default",
): Promise<void> {
  const now = new Date();

  // 1. Instruction Module (required by agents foreign keys). No model module
  // is seeded: fresh workspaces start with zero model providers by contract.
  try {
    const existingInst = await db.query.instructionModules.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "mod-inst-default"),
    });
    if (!existingInst) {
      await db.insert(schema.instructionModules).values({
        id: "mod-inst-default",
        label: "Default Executive Instructions",
        base: ["You are an intelligent AI coordinator operating inside CrowdOS."],
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {}

  // 2. Category: General (replaces old [ADMIN])
  try {
    const existingCat = await db.query.categories.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "cat-general"),
    });
    if (!existingCat) {
      await db.insert(schema.categories).values({
        id: "cat-general",
        name: "General",
        createdBy: "system",
        workspaceId,
        position: 0,
        createdAt: now,
      });
    }
  } catch {}

  // 3. Channels: #general and #crowd-os
  try {
    const existingGenChan = await db.query.channels.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "ch-general"),
    });
    if (!existingGenChan) {
      await db.insert(schema.channels).values({
        id: "ch-general",
        categoryId: "cat-general",
        name: "general",
        type: "standard",
        createdBy: "system",
        workspaceId,
        position: 0,
        createdAt: now,
      });
    }
  } catch {}

  try {
    const existingCrowdChan = await db.query.channels.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "ch-crowd-os"),
    });
    if (!existingCrowdChan) {
      await db.insert(schema.channels).values({
        id: "ch-crowd-os",
        categoryId: "cat-general",
        name: "crowd-os",
        type: "standard",
        createdBy: "system",
        workspaceId,
        position: 1,
        createdAt: now,
      });

      // Welcome guide in #crowd-os
      await db.insert(schema.messages).values({
        id: "msg-crowdos-welcome",
        channelId: "ch-crowd-os",
        authorId: "system",
        authorName: "CrowdOS System",
        authorLevel: "0",
        authorType: "system",
        content: "# Welcome to CrowdOS\n\nCrowdOS provides autonomous multi-agent coordination with dedicated workspace sandboxes and isolated database storage.\n\n### Getting Started\n- **General Chat**: Use `#general` to communicate with the swarm and initiate tasks.\n- **Agents**: Raven (L0 Assistant) coordinates requests, and Owl indexes information.\n- **Filesystem**: Check the File Explorer in the center panel to inspect sandboxed files.",
        sequenceNumber: 1,
        timestamp: now,
      });
    }
  } catch {}

  // 4. Agents: Raven (L0 Assistant) and Owl (L2 Indexer)
  try {
    const existingRaven = await db.query.agents.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "agent-raven"),
    });
    if (!existingRaven) {
      await db.insert(schema.agents).values({
        id: "agent-raven",
        name: "Raven",
        title: "Executive Assistant",
        species: "Raven",
        authorityLevel: 0,
        avatar: "🦅",
        modelModuleId: null,
        instructionModuleId: "mod-inst-default",
        memorySharingPolicy: "none",
        isOmniscient: true,
        status: "idle",
        isTemplate: false,
        permissions: { spawnAgents: true, patchRuntime: true, accessAllChannels: true },
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {}

  try {
    const existingOwl = await db.query.agents.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "agent-owl"),
    });
    if (!existingOwl) {
      await db.insert(schema.agents).values({
        id: "agent-owl",
        name: "Owl",
        title: "Librarian & Indexer",
        species: "Owl",
        authorityLevel: 2,
        avatar: "🦉",
        modelModuleId: null,
        instructionModuleId: "mod-inst-default",
        memorySharingPolicy: "none",
        isOmniscient: false,
        status: "idle",
        isTemplate: false,
        permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: true },
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {}

  // 5. Default workspaceSettings row
  try {
    const existingSettings = await db.query.workspaceSettings.findFirst({
      where: (table: any, { eq }: any) => eq(table.id, "default"),
    });
    if (!existingSettings) {
      await db.insert(schema.workspaceSettings).values({
        id: "default",
        globalSoftCap: 1000000,
        perProviderBudget: {},
        updatedAt: now,
      });
    }
  } catch {}
}

/**
 * Tables `resetWorkspaceDatabase` drops (WS-003). Versioned list — the coverage
 * test in workspace-database.test.ts diffs it against every CREATE TABLE in
 * db/migrations so a new migration cannot silently outlive a flush (which made
 * re-provision fail with "relation already exists" and left memory rows behind).
 * `__drizzle_migrations` is dropped last so the next provision re-runs 0000.
 */
export const WORKSPACE_RESET_DROP_TABLES: readonly string[] = [
  "workspace_safety_settings",
  "channel_settings",
  "thread_sequences",
  "threads",
  "approval_grants",
  "approval_requests",
  "artifacts",
  "workspace_agents",
  "workspace_events",
  "workspace_nodes",
  "workspaces",
  "workspace_settings",
  "messages",
  "channels",
  "categories",
  "agents",
  "toolkit_modules",
  "instruction_modules",
  "model_modules",
  "constraints_modules",
  "capabilities_modules",
  "runs",
  "runs_compensation",
  "channel_sequences",
  "agent_memory_notes",
  "memory_update_log",
  "skills",
  "agent_skills",
  "agent_instruction_stacks",
  "swarm_tasks",
  "delegations",
  "token_usage_log",
  "channel_index",
  "compressed_summaries",
  "mcp_servers",
  "api_keys",
  // WS-003: tables the earlier hardcoded list missed entirely (agent/tool,
  // durable events, model profiles, runtime, scheduler, spawn/task files).
  "agent_tools",
  "durable_events",
  "embedding_model_profiles",
  "generation_model_profiles",
  "indexing_model_profiles",
  "runtime_overrides",
  "runtime_states",
  "scheduled_tasks",
  "spawn_requests",
  "task_files",
  "tools",
  "__drizzle_migrations",
];

/**
 * Drops CrowdOS-managed tables from the given PostgreSQL database to allow clean reuse.
 */
export async function resetWorkspaceDatabase(databaseUrl: string): Promise<void> {
  const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
  const sql = postgres(parsed.url, { max: 1, prepare: false, connect_timeout: 15 });
  try {
    // WS-003: built from the versioned list above; coverage asserted by test.
    await sql.unsafe(
      WORKSPACE_RESET_DROP_TABLES.map((table) => `DROP TABLE IF EXISTS "${table}" CASCADE;`).join("\n"),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

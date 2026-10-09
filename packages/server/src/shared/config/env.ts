import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// dotenv loads exactly one file: <cwd>/.env. Record which (if any) it was so
// boot can name its source — the classic trap is editing root .env while the
// server (CWD=packages/server) reads packages/server/.env, or vice versa.
const dotenvResult = loadDotenv({ quiet: true });
const loadedDotenvPath: string | null =
  dotenvResult && typeof dotenvResult === "object" && (dotenvResult as { parsed?: unknown }).parsed
    ? resolve(process.cwd(), ".env")
    : null;

/** Presence-only check (never reads values — secrets stay out of logs). */
function dotenvDefinesDbUrl(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    return /^\s*DATABASE_URL\s*=/m.test(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Warn when a sibling .env defines DATABASE_URL but the loaded file does not
 * (or vice versa). The global URL configures unscoped getDb and global database
 * setup; workspace routing requires a workspace record or matching keyed URL.
 * A copy in the wrong dotenv file is invisible to this server process.
 */
export function dotenvDbUrlMismatchWarning(): string | null {
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, ".env"),
    resolve(cwd, "..", ".env"),
    resolve(cwd, "..", "..", ".env"),
  ].filter((p, i, arr) => arr.indexOf(p) === i && existsSync(p));
  if (candidates.length < 2) return null;
  const states = candidates.map((p) => ({ path: p, defines: dotenvDefinesDbUrl(p) }));
  const first = states[0].defines;
  if (states.every((s) => s.defines === first)) return null;
  const withUrl = states.filter((s) => s.defines).map((s) => s.path);
  return (
    `[config] DATABASE_URL is defined in ${withUrl.join(", ")} but not in the loaded dotenv source ` +
    `(${loadedDotenvPath ?? "none — environment only"}). The global getDb pool reads the loaded source; tenant routing ` +
    `needs a workspace record or matching CROWDOS_WS_<ID>_DATABASE_URL. Move or remove the unused copy.`
  );
}

export function dotenvSourcePath(): string | null {
  return loadedDotenvPath;
}

const ENV_TRUE = "true";
const ENV_FALSE = "false";

function lowerTrimToUndefined(v: unknown): string | undefined {
  const s = trimToUndefined(v);
  return s === undefined ? undefined : s.toLowerCase();
}

function boolSchema(defaultValue: boolean) {
  return z
    .preprocess(
      lowerTrimToUndefined,
      z.enum([ENV_TRUE, ENV_FALSE]).transform((v) => v === ENV_TRUE),
    )
    .default(defaultValue);
}

function enumSchema<T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
  description: string,
) {
  return z
    .preprocess(lowerTrimToUndefined, z.enum(values))
    .default(defaultValue)
    .describe(description);
}

function optionalTextSchema(description: string) {
  return z
    .preprocess(trimToUndefined, z.string().min(1))
    .optional()
    .describe(description);
}

function optionalUrlSchema(description: string) {
  return z
    .preprocess(trimToUndefined, z.url())
    .optional()
    .describe(description);
}

function trimToUndefined(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function intSchema(min: number, max: number | null, defaultValue: number, description: string) {
  let base = z.coerce.number().int().min(min);
  if (max != null) base = base.max(max);
  return z
    .preprocess(trimToUndefined, base)
    .default(defaultValue)
    .describe(description);
}

function numSchema(min: number, defaultValue: number, description: string) {
  return z
    .preprocess(trimToUndefined, z.coerce.number().min(min))
    .default(defaultValue)
    .describe(description);
}

export const envSchema = z.object({
  NODE_ENV: enumSchema(["development", "production", "test"] as const, "development",
    "Runtime mode."),
  CONFIG_STRICT: boolSchema(true)
    .describe("Rollback switch for CFG-1 fail-fast boot: false downgrades unknown project-prefixed env vars from boot-blocking errors to warnings."),
  PORT: intSchema(1, 65535, 12077, "HTTP listen port for the Fastify server."),
  HOST: optionalTextSchema("Optional bind host for the HTTP listener (reserved; listener currently binds default host)."),
  CLIENT_ORIGIN: z
    .string()
    .min(1)
    .default("http://localhost:22077")
    .describe("Comma-separated list of allowed browser origins for CORS and socket.io."),
  CORS_ORIGIN: optionalTextSchema("Alias considered for CORS origin configuration (reserved; CLIENT_ORIGIN is the consumed var)."),
  DATABASE_URL: optionalUrlSchema("Global Postgres connection string for unscoped getDb() and global migration/seed setup. Never used as a per-workspace database fallback."),
  REDIS_URL: optionalUrlSchema("Redis connection string for BullMQ-backed job queues (Phase-5 QUE reserved flag)."),
  SYSTEM_ACTOR_ID: z
    .string()
    .min(1)
    .default("system")
    .describe("Actor id attributed to system-generated messages and fallback ownership."),
  WORKSPACE_DIR: optionalTextSchema(
    "Zone A base directory: where each workspace's own state lives (config, roster, skills, " +
      "instructions, channel history, runtime state). A workspace with a registry `rootPath` " +
      "uses that instead; otherwise the root is <WORKSPACE_DIR>/<workspaceId>. Defaults to " +
      "<cwd>/sandbox. This is NOT the repository root — a mounted repository is Zone B, set " +
      "per channel/category/workspace from the Repo panel."
  ),

  WORKSPACE_ADMIN_TOKEN: optionalTextSchema("Admin bearer token gating privileged admin routes (/metrics hardening, DB config mutations)."),

  CREDENTIALS_ENCRYPTION_KEY: optionalTextSchema("SEC-4 encrypt-at-rest key for provider credentials. Accepts 32-byte hex, 32-byte base64, or any passphrase (scrypt-derived). Unset = encryption disabled."),

  RATE_LIMIT_ENABLED: boolSchema(true)
    .describe("SEC-5 HTTP rate limiting master switch; false disables all HTTP limiting (rollback)."),
  RATE_LIMIT_MAX: intSchema(1, null, 300, "Max requests per time window in the global per-key/per-IP HTTP bucket."),
  RATE_LIMIT_WINDOW_MS: intSchema(1, null, 60_000, "Global HTTP rate-limit window size in milliseconds."),

  SOCKET_MSG_RATE_CAPACITY: numSchema(0.000001, 15, "Per-socket token-bucket capacity for throttled user-content socket events (float allowed)."),
  SOCKET_MSG_RATE_REFILL: numSchema(0.000001, 5, "Token-bucket refill rate in tokens per second for socket event throttling."),
  MAX_PARALLEL_AGENTS: intSchema(1, null, 4, "Deprecated: ignored — multi-mention is always serial per CrowdOS §10."),
  DURABLE_EVENTS: boolSchema(false)
    .describe("Deprecated (D6): durable_events retired, always off. Kept so old env files still parse."),

  PROVIDER_CONNECT_TIMEOUT_MS: numSchema(0, 10_000, "Max wait in ms for provider response headers; 0 disables the watchdog."),
  PROVIDER_IDLE_TIMEOUT_MS: numSchema(0, 120_000, "Max gap in ms between provider stream chunks (or full non-streaming body); 0 disables."),
  PROVIDER_KEEP_ALIVE_TIMEOUT_MS: intSchema(1, 600_000, 10_000, "Undici Agent keep-alive socket timeout in ms (attached as fetch dispatcher when undici resolves; global fetch pooling applies otherwise)."),
  PROVIDER_KEEP_ALIVE_MAX_TIMEOUT_MS: intSchema(1, 3_600_000, 60_000, "Undici Agent max keep-alive timeout cap in ms."),
  PROVIDER_PIPELINING: intSchema(1, 4, 4, "Undici Agent pipelining factor per origin (1..4)."),
  PROVIDER_MAX_CONNECTIONS: intSchema(1, 256, 8, "Undici Agent connections per origin cap."),

  STREAM_BATCH_MS: numSchema(0, 50, "PERF-6: stream chunk coalescing window in ms; 0 disables batching (immediate per-chunk flush)."),
  PIPELINE_PARALLEL: boolSchema(true)
    .describe("Context pipeline parallelism; true (default) runs pipeline middlewares in parallel where safe, false forces serial execution (rollback)."),
  ORPHAN_AFTER_MS: intSchema(10_000, null, 60_000, "Heartbeat orphan threshold in ms; agents still 'working' with lastHeartbeat older than this are paused as orphaned (minimum 10000)."),
  PER_ITERATION_BUDGET: boolSchema(true)
    .describe("PERF-3: enforce per-iteration context budget in agentic runtime; false restores assembly-time-only capping."),

  MEM_SUPPRESS_SWEEP_MS: numSchema(0.000001, 600_000, "Interval in ms between memory suppression sweeps flipping expired suppressions back to active."),
  MEM_NOTE_CAP: intSchema(1, null, 500, "Maximum active memory notes retained per agent before cap-archive."),
  MEM_DISCARD_TTL_MS: numSchema(0.000001, 1_800_000, "Soft-discard TTL in ms: how long a session-discarded note stays suppressed."),
  MEM_REFLECT_THROTTLE: boolSchema(true)
    .describe("Memory reflection throttle master switch; false allows every reflection write (dedupe off)."),
  MEM_REFLECT_MIN_INTERVAL_MS: numSchema(0.000001, 60_000, "Minimum interval in ms between accepted reflection writes per agent."),
  MEM_REFLECT_SIMILARITY_PCT: intSchema(1, 100, 80, "Jaccard similarity percentage threshold (1-100) above which a reflection hook is treated as duplicate."),
  MEM_RETRIEVAL_WINDOW: intSchema(1, null, 60, "SQL-side candidate window size (top-N active notes) for memory retrieval scoring."),

  RETENTION_SWEEP_MS: numSchema(0, 21_600_000, "RETIRED (no reader — use RETENTION_DAYS; sweep cadence is fixed in queue/repeatables.ts + maintenance-worker.ts): formerly interval in ms between spawn-artifact retention sweeps (archived agents/channels/task_files purge)."),
  RETENTION_DAYS: numSchema(0, 30, "Retention window in days for archived spawn artifacts; 0 purges everything already archived."),

  BUDGET_RECONCILE_MS: numSchema(0, 86_400_000, "PERF-4: interval in ms for the daily budget-ledger reconcile job recomputing consumption from token_usage_log."),

  TOOL_RWP: boolSchema(true)
    .describe("PERF-8 tool read/write parallelization; false restores legacy all-or-nothing batch scheduling."),
  TOOL_RWP_MAX_READ_CONCURRENCY: intSchema(1, null, 4, "Bounded pool width for concurrently executing read-classified tool calls in a batch."),
  LEGACY_GUARD: boolSchema(false)
    .describe("Tool safety legacy-guard switch; true enables the conservative legacy tool guard rules."),

  MODEL_ROUTE: enumSchema(["routed", "static"] as const, "routed",
    "MODEL-1: 'routed' enables task-class tier routing; 'static' bypasses the routing table (legacy per-agent module selection)."),
  DELTA_INDEX: boolSchema(true)
    .describe("PERF-4 librarian delta indexing; false rolls back to full-reload summarization windows."),

  RUNS_ENABLED: boolSchema(true)
    .describe("Runs ledger persistence; false makes createRun a no-op (rollback switch)."),
  METRICS_ENABLED: boolSchema(true)
    .describe("OBS-1 /metrics route exposure; false removes the route entirely."),

  LEGACY_BOOTSTRAP: boolSchema(false)
    .describe("DB bootstrap legacy path switch; true forces the pre-migration bootstrap sequence."),
  ENABLE_DB_CONFIG_MUTATION: boolSchema(false)
    .describe("Workspace route escape hatch allowing live DATABASE_URL mutation via API; requires WORKSPACE_ADMIN_TOKEN."),

  QUEUE_MODE: enumSchema(["inline", "bullmq"] as const, "inline",
    "Job execution backend (Phase-5 QUE reserved): 'inline' runs jobs in-process; 'bullmq' delegates to Redis-backed BullMQ."),
  APPROVALS_ENABLED: boolSchema(false)
    .describe("APR-1: true enables ASK→WAITING_FOR_APPROVAL pause flow (approval.requested/decided events, TTL default-deny, reusable grants). False restores legacy ASK-as-DENY (rollback)."),
  APPROVAL_TTL_MS: numSchema(1000, 300000, "APR-1: TTL in ms for pending approval_requests before auto-expire (default-deny). Minimum 1000ms, default 300000 (5 minutes)."),
  APPROVAL_REUSABLE_TTL_MS: numSchema(1000, 3600000, "APR-1: TTL in ms for reusable-grant cache (tool+scope-hash) before re-asking. Minimum 1000ms, default 3600000 (1 hour)."),
  SWARM_V1: boolSchema(false)
    .describe("SW-1 Swarm v1: false (default) routes L2→agentic rollback; true enables supervisor LLM → swarm_tasks DAG → leaf workers (BullMQ/leases via heartbeats) → aggregator → verifier gates COMPLETED."),
  SWARM_MAX_DEPTH: intSchema(0, 99, 2, "SW-2 delegation depth guard: max delegation depth before rejection; 99 disables depth guard (rollback, dev). Default 2."),
  DEMO_FALLBACK: boolSchema(false)
    .describe("Demo-mode degraded-provider fallback responses (Phase-5 reserved, not yet consumed)."),

  UNTRUSTED_WRAP: boolSchema(true)
    .describe("CTX-2 rollback: false disables <untrusted> wrapping (legacy formatting)."),

  QUERY_DATABASE_ENABLED: boolSchema(true)
    .describe("TOOL-1 rollback: false unregisters query_database tool entirely (honest fallback); true enables real read-only SQL over pooled postgres with statement_timeout 5s, allowlist, row cap 100."),

  SYSTEM_SCHEDULER_ENABLED: boolSchema(true)
    .describe("TOOL-1 rollback: false unregisters system_scheduler tool entirely; true enables honest BullMQ delayed/repeatable jobs firing real mentions/events via EventBroker (delayed or cron)."),

  BRAVE_API_KEY: optionalTextSchema("SearchProviders BRAVE_API_KEY for Brave Search adapter (RT-1)."),
  TAVILY_API_KEY: optionalTextSchema("SearchProviders TAVILY_API_KEY for Tavily adapter (RT-1)."),
  SERPER_API_KEY: optionalTextSchema("SearchProviders SERPER_API_KEY for Serper adapter (RT-1)."),
  SEARCH_PROVIDER_PRIORITY: optionalTextSchema("Comma-separated provider priority order for SearchProviders gate (e.g. brave,tavily,serper)."),

  RESEARCH_V1: boolSchema(false)
    .describe("RT-1 rollback: true enables real ResearchRuntime (isolated sub-runs, evidence bundle, cited synthesis); false pins research->agentic alias."),

  // SCL-3: OTel + cost ledger
  OTEL_ENABLED: boolSchema(false)
    .describe("SCL-3: true enables OTel SDK initialization."),

  // SCL-2: Semantic memory
  EMBEDDING_ENABLED: boolSchema(false)
    .describe("SCL-2: true enables pgvector hybrid scoring (requires EMBEDDING_MODEL or embeddingModelProfiles row)."),
  EMBEDDING_MODEL: optionalTextSchema("Default embedding model name (overrides embeddingModelProfiles when set)."),
  EMBEDDING_DIMENSIONS: intSchema(1, 4096, 1536, "Embedding vector dimensions (must match pgvector column; default 1536)."),
  EMBEDDING_HYBRID_WEIGHT: numSchema(0, 0.5, "SCL-2: weight 0..1 of semantic similarity in hybrid lane score (0=heuristic only, 1=vector only)."),
});

export type Env = z.infer<typeof envSchema>;
export type EffectiveConfig = Env;

export const PROJECT_ENV_PREFIXES = [
  "AUTH_", "QUEUE_", "REDIS_", "SOCKET_", "PROVIDER_", "MEM_", "RETENTION_",
  "BUDGET_", "RATE_LIMIT_", "METRICS_", "MAX_PARALLEL", "STREAM_BATCH",
  "TOOL_RWP", "MODEL_ROUTE", "DELTA_INDEX", "PER_ITERATION", "RUNS_ENABLED",
  "DURABLE_EVENTS", "DEMO_FALLBACK", "SWARM_", "APPROVALS_", "APPROVAL_", "LEGACY_", "HONEST_", "COMPACTION_", "CUSTOM_", "CROWDOS_",
  "CREDENTIALS_", "PIPELINE_", "ORPHAN_", "UNTRUSTED_", "QUERY_", "SYSTEM_", "TOOL_", "SCHEDULER_",
  "BRAVE_", "TAVILY_", "SERPER_", "SEARCH_", "RESEARCH_",
  "OTEL_", "EMBEDDING_", "ORPHAN_SWEEP_", "SWARM_MAX_CONCURRENCY", "SWARM_TASK_TIMEOUT_MS", "SWARM_GUARD_DISABLED", "APPROVAL_PENDING_TTL_MS",
] as const;

export const PROJECT_ENV_EXACT = [
  "DATABASE_URL", "WORKSPACE_ADMIN_TOKEN", "PORT", "HOST", "CORS_ORIGIN",
] as const;

const OS_JUNK_ENV_ALLOWLIST = new Set(["HOSTNAME"]);

// Desktop-shell flags (packages/desktop main + dev-electron): read directly off
// process.env by the Electron shell and inherited by the embedded backend via
// process.env passthrough - never consumed by the server config schema. Exempt
// them from the broad CROWDOS_ project prefix so packaged-desktop boot is not blocked.
const DESKTOP_ENV_ALLOWLIST = new Set(["CROWDOS_DEV", "CROWDOS_DEVTOOLS"]);

export class ConfigError extends Error {
  readonly issues: ConfigIssues;
  constructor(message: string, issues: ConfigIssues) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface CoercedVarIssue {
  var: string;
  from: string;
  to: string;
}

export interface ConfigIssues {
  unknownProjectVars: string[];
  coerced: CoercedVarIssue[];
}

export interface EffectiveConfigResult {
  config: Env;
  issues: ConfigIssues;
}

const SCHEMA_KEYS = new Set(Object.keys(envSchema.shape));

function isProjectNamespaceVar(key: string): boolean {
  if (OS_JUNK_ENV_ALLOWLIST.has(key)) return false;
  if (DESKTOP_ENV_ALLOWLIST.has(key)) return false;
  if ((PROJECT_ENV_EXACT as readonly string[]).includes(key)) return true;
  return (PROJECT_ENV_PREFIXES as readonly string[]).some((p) => key.startsWith(p));
}

function parseStrictFlag(source: Record<string, string | undefined>): boolean {
  const raw = source.CONFIG_STRICT;
  if (raw == null) return true;
  return raw.trim().toLowerCase() !== ENV_FALSE;
}

function formatReceived(raw: string | undefined): string {
  return raw === undefined ? "<unset>" : JSON.stringify(raw);
}

export function loadEffectiveConfig(
  source: Record<string, string | undefined> = process.env,
): EffectiveConfigResult {
  const strict = parseStrictFlag(source);

  const parsed = envSchema.safeParse(source);
  const malformed = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const varName = issue.path.join(".");
        return `- ${varName}: ${issue.message} (received ${formatReceived(source[varName])})`;
      });

  const unknownProjectVars = Object.keys(source).filter(
    (key) =>
      !SCHEMA_KEYS.has(key) &&
      !(key === "CONFIG_STRICT") &&
      isProjectNamespaceVar(key),
  );

  const issues: ConfigIssues = { unknownProjectVars, coerced: [] };

  if (!parsed.success || malformed.length > 0) {
    throw new ConfigError(
      `[config] Invalid environment configuration — fix these before boot:\n${malformed.join("\n")}`,
      issues,
    );
  }

  if (unknownProjectVars.length > 0 && strict) {
    throw new ConfigError(
      [
        "[config] Unknown project-prefixed environment variable(s) — refusing to boot:",
        ...unknownProjectVars.map((v) => `- ${v}=${formatReceived(source[v])}`),
        "Fix: correct the spelling, remove the variable, extend Shared/config/env.ts if it is a new setting, or boot with CONFIG_STRICT=false to downgrade this to a warning.",
      ].join("\n"),
      issues,
    );
  }

  const config = parsed.data as Env;
  for (const key of SCHEMA_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    const value = (config as Record<string, unknown>)[key];
    const normalized = typeof value === "string" ? value : String(value);
    if (normalized !== raw) {
      issues.coerced.push({ var: key, from: raw, to: normalized });
    }
  }

  return { config, issues };
}

const SECRETISH_KEY_RE = /(KEY|TOKEN|PASSWORD|SECRET)/i;

function urlOrigin(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "[unparsable-url]";
  }
}

export type RedactedConfigReport = Record<string, string | number | boolean | null>;

export function redactedConfigReport(config: Env): RedactedConfigReport {
  const report: RedactedConfigReport = {};
  for (const key of Object.keys(envSchema.shape).sort()) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      report[key] = null;
    } else if (SECRETISH_KEY_RE.test(key)) {
      report[key] = "[redacted]";
    } else if (key.endsWith("_URL")) {
      report[key] = urlOrigin(String(value));
    } else {
      report[key] = value as string | number | boolean;
    }
  }
  return report;
}

export function formatConfigReport(report: RedactedConfigReport): string {
  const keys = Object.keys(report);
  const width = keys.reduce((w, k) => Math.max(w, k.length), 0);
  return keys.map((k) => `${k.padEnd(width)} = ${String(report[k])}`).join("\n");
}

let cachedResult: EffectiveConfigResult | null = null;

export interface InitConfigOptions {
  log?: boolean | ((line: string) => void);
}

export function initConfig(options: InitConfigOptions = {}): EffectiveConfigResult {
  const result = loadEffectiveConfig();
  cachedResult = result;

  const logOption = options.log ?? true;
  if (logOption !== false) {
    const emit = typeof logOption === "function" ? logOption : (line: string) => console.log(line);
    const warn = typeof logOption === "function" ? logOption : (line: string) => console.warn(line);
    emit(`[config] dotenv source: ${loadedDotenvPath ?? "(none — environment only)"} (runtime DB credentials come from workspace.json, never .env)`);
    const mismatch = dotenvDbUrlMismatchWarning();
    if (mismatch) warn(`[config][warn] ${mismatch}`);
    emit("[config] effective configuration (secrets redacted):");
    for (const line of formatConfigReport(redactedConfigReport(result.config)).split("\n")) {
      emit(line);
    }
    if (result.issues.unknownProjectVars.length > 0) {
      warn(`[config][warn] CONFIG_STRICT=false: unknown project variables ignored: ${result.issues.unknownProjectVars.join(", ")}`);
    }
    for (const c of result.issues.coerced) {
      warn(`[config][warn] coerced ${c.var}: ${JSON.stringify(c.from)} -> ${c.to}`);
    }
  }

  return result;
}

export const appConfig: Env = new Proxy({} as Env, {
  get(_target, prop) {
    if (!cachedResult) {
      throw new Error(
        "[config] appConfig accessed before initConfig() — call initConfig({ log: true }) during boot before reading configuration.",
      );
    }
    return Reflect.get(cachedResult.config as object, prop);
  },
  has(_target, prop) {
    if (!cachedResult) {
      throw new Error(
        "[config] appConfig accessed before initConfig() — call initConfig({ log: true }) during boot before reading configuration.",
      );
    }
    return Reflect.has(cachedResult.config as object, prop);
  },
  ownKeys() {
    if (!cachedResult) {
      throw new Error(
        "[config] appConfig accessed before initConfig() — call initConfig({ log: true }) during boot before reading configuration.",
      );
    }
    return Reflect.ownKeys(cachedResult.config as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (!cachedResult) return undefined;
    return Reflect.getOwnPropertyDescriptor(cachedResult.config as object, prop);
  },
});

export const env: Env = loadEffectiveConfig().config;

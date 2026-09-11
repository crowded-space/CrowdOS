# SPEC 2 — Local-First Config Migration

## 1. Goal & Non-Goals

### 1.1 Goal
Move the two mutable configuration surfaces local-first into versionable, file-backed stores with identical fail-fast safety to today, without regressing secrets or the hot budget counter:

1. **Env-mutable flags** — the ~65-key zod-validated set in `packages/server/src/Shared/config/env.ts:70-205` (loaded via `loadEffectiveConfig()` at `env.ts:269-321`, cached via `initConfig()` at `env.ts:365-387`, read via `appConfig` proxy at `env.ts:389-418` and eager `env` singleton at `env.ts:420`) becomes a file that can be read at boot and mutated at runtime without process-env surgery.
2. **Budget singleton** — the `workspace_settings(id=default)` row (`packages/server/src/db/schema.ts:444-454`, seeded at `packages/server/src/db/seed.ts:215-226`, legacy DDL at `packages/server/src/db/bootstrap.ts:62-67`) read/written only with `id=default` in `packages/server/src/routes/workspace.ts` and `packages/server/src/Shared/core/tokenTracker.ts` becomes a file for caps, with a concurrency-safe story for the hot `__global.used` counter currently bumped by atomic `jsonb_set` at `tokenTracker.ts:199-216` and reconciled by daily `SUM` at `tokenTracker.ts:229-253`.
3. Preserve today's three invariants verbatim in the file loader: **fail-fast on malformed known keys** (`env.ts:291-296`), **fail-fast on unknown project-prefixed keys when strict** (`env.ts:298-307`, `CONFIG_STRICT` default `true` at `env.ts:73-74`), **secrets never logged** (`redactedConfigReport()` at `env.ts:336-351`, `formatConfigReport()` at `env.ts:353-357`, Fastify serializer redaction at `packages/server/src/index.ts:33-50`, `Shared/core/redact.ts:1-91`).

### 1.2 Non-goals
- No change to the relational ledger of record: `token_usage_log` stays in Postgres (see §8). No change to `api_keys` hash auth, `model_modules` / profile `api_key` envelopes, or `mcp_servers.env_vars` envelopes except where the loader must read the decryption key.
- No new queue, auth, or routing semantics. `QUEUE_MODE`, `AUTH_STRICT`, approval/swarm/research flags keep current defaults and rollback meanings; only their *source* changes.
- No multi-workspace budgets. Singleton `id=default` scope is preserved; per-workspace budgets are out of scope.
- No plaintext secret persistence, no `.env` auto-rewrite, no removal of `CONFIG_STRICT=false` escape hatch.
- No change to VFS/sandbox roots beyond making `WORKSPACE_DIR` file-configurable.

---

## 2. Current State (verified, with file:line)

### 2.1 `Shared/config/env.ts` — schema groups (~65 vars)

File: `packages/server/src/Shared/config/env.ts` (420 lines). Helpers: `lowerTrimToUndefined()` `:9-12`, `boolSchema()` `:14-21`, `enumSchema()` `:23-32`, `optionalTextSchema()` `:34-39`, `optionalUrlSchema()` `:41-46`, `trimToUndefined()` `:48-52`, `intSchema()` `:54-61`, `numSchema()` `:63-68`.

| Group | Lines | Keys (current defaults) |
|---|---|---|
| Core / server | `70-90` | `NODE_ENV=development` (`71`), `CONFIG_STRICT=true` (`73-74`), `PORT=3001` (`75`), `HOST?` (`76`), `CLIENT_ORIGIN=http://localhost:5173` (`77-81`), `CORS_ORIGIN?` (`82`), `DATABASE_URL?` (`83`), `REDIS_URL?` (`84`), `SYSTEM_ACTOR_ID=system` (`85-89`), `WORKSPACE_DIR?` (`90`) |
| Auth + at-rest key | `92-98` | `AUTH_STRICT=true` (`92-93`), `AUTH_TOKEN?` (`94`), `API_KEY?` (`95`), `WORKSPACE_ADMIN_TOKEN?` (`96`), `CREDENTIALS_ENCRYPTION_KEY?` (`98`) |
| Rate / socket / parallel / durable | `100-111` | `RATE_LIMIT_ENABLED=true` (`100-101`), `RATE_LIMIT_MAX=300` (`102`), `RATE_LIMIT_WINDOW_MS=60000` (`103`), `SOCKET_OPEN=false` (`105-106`), `SOCKET_MSG_RATE_CAPACITY=15` (`107`), `SOCKET_MSG_RATE_REFILL=5` (`108`), `MAX_PARALLEL_AGENTS=4` (`109`), `DURABLE_EVENTS=true` (`110-111`) |
| Provider / stream / pipeline / orphan / iteration | `113-125` | `PROVIDER_CONNECT_TIMEOUT_MS=10000` (`113`), `PROVIDER_IDLE_TIMEOUT_MS=120000` (`114`), `PROVIDER_KEEP_ALIVE_TIMEOUT_MS=10000` (`115`), `PROVIDER_KEEP_ALIVE_MAX_TIMEOUT_MS=60000` (`116`), `PROVIDER_PIPELINING=4` (`117`), `PROVIDER_MAX_CONNECTIONS=8` (`118`), `STREAM_BATCH_MS=50` (`120`), `PIPELINE_PARALLEL=true` (`121-122`), `ORPHAN_AFTER_MS=60000` (`123`), `PER_ITERATION_BUDGET=true` (`124-125`) |
| Memory | `127-134` | `MEM_SUPPRESS_SWEEP_MS=600000` (`127`), `MEM_NOTE_CAP=500` (`128`), `MEM_DISCARD_TTL_MS=1800000` (`129`), `MEM_REFLECT_THROTTLE=true` (`130-131`), `MEM_REFLECT_MIN_INTERVAL_MS=60000` (`132`), `MEM_REFLECT_SIMILARITY_PCT=80` (`133`), `MEM_RETRIEVAL_WINDOW=60` (`134`) |
| Retention + reconcile | `136-139` | `RETENTION_SWEEP_MS=21600000` (`136`), `RETENTION_DAYS=30` (`137`), `BUDGET_RECONCILE_MS=86400000` (`139`) |
| Tool / model / delta | `141-150` | `TOOL_RWP=true` (`141-142`), `TOOL_RWP_MAX_READ_CONCURRENCY=4` (`143`), `LEGACY_GUARD=false` (`144-145`), `MODEL_ROUTE=routed` (`147-148`), `DELTA_INDEX=true` (`149-150`) |
| Runs / metrics / bootstrap / mutation | `152-160` | `RUNS_ENABLED=true` (`152-153`), `METRICS_ENABLED=true` (`154-155`), `LEGACY_BOOTSTRAP=false` (`157-158`), `ENABLE_DB_CONFIG_MUTATION=false` (`159-160`) |
| Queue / approvals / swarm / demo | `162-174` | `QUEUE_MODE=inline` (`162-163`), `APPROVALS_ENABLED=false` (`164-165`), `APPROVAL_TTL_MS=300000` (`166`), `APPROVAL_REUSABLE_TTL_MS=3600000` (`167`), `SWARM_V1=false` (`168-169`), `SWARM_LEGACY=false` (`170-171`), `SWARM_MAX_DEPTH=2` (`172`), `DEMO_FALLBACK=false` (`173-174`) |
| Trust / honest tools | `176-183` | `UNTRUSTED_WRAP=true` (`176-177`), `QUERY_DATABASE_ENABLED=true` (`179-180`), `SYSTEM_SCHEDULER_ENABLED=true` (`182-183`) |
| Search / research | `185-191` | `BRAVE_API_KEY?` (`185`), `TAVILY_API_KEY?` (`186`), `SERPER_API_KEY?` (`187`), `SEARCH_PROVIDER_PRIORITY?` (`188`), `RESEARCH_V1=false` (`190-191`) |
| OTel (SCL-3) | `193-197` | `OTEL_ENABLED=false` (`194-195`), `OTEL_EXPORTER_OTLP_ENDPOINT?` (`196`), `OTEL_SERVICE_NAME?` (`197`) |
| Embeddings (SCL-2) | `199-204` | `EMBEDDING_ENABLED=false` (`200-201`), `EMBEDDING_MODEL?` (`202`), `EMBEDDING_DIMENSIONS=1536` (`203`), `EMBEDDING_HYBRID_WEIGHT=0.5` (`204`) |

Strict-namespace machinery:

- `PROJECT_ENV_PREFIXES` at `env.ts:210-218` (26 prefixes: `AUTH_`, `QUEUE_`, `REDIS_`, `SOCKET_`, `PROVIDER_`, `MEM_`, `RETENTION_`, `BUDGET_`, `RATE_LIMIT_`, `METRICS_`, `MAX_PARALLEL`, `STREAM_BATCH`, `TOOL_RWP`, `MODEL_ROUTE`, `DELTA_INDEX`, `PER_ITERATION`, `RUNS_ENABLED`, `DURABLE_EVENTS`, `DEMO_FALLBACK`, `SWARM_`, `APPROVALS_`, `APPROVAL_`, `LEGACY_`, `CREDENTIALS_`, `PIPELINE_`, `ORPHAN_`, `UNTRUSTED_`, `QUERY_`, `SYSTEM_`, `TOOL_`, `SCHEDULER_`, `BRAVE_`, `TAVILY_`, `SERPER_`, `SEARCH_`, `RESEARCH_`, `OTEL_`, `EMBEDDING_`).
- `PROJECT_ENV_EXACT` at `env.ts:220-222` (`DATABASE_URL`, `WORKSPACE_ADMIN_TOKEN`, `PORT`, `HOST`, `CORS_ORIGIN`).
- `OS_JUNK_ENV_ALLOWLIST` at `env.ts:224` (`HOSTNAME`).
- `isProjectNamespaceVar()` at `env.ts:253-257`, `parseStrictFlag()` at `env.ts:259-263`, `formatReceived()` at `env.ts:265-267`.
- `ConfigError` class at `env.ts:226-233`, `ConfigIssues`/`CoercedVarIssue`/`EffectiveConfigResult` at `env.ts:235-249`, `SCHEMA_KEYS` at `env.ts:251`.
- Coercion tracking loop at `env.ts:310-318` (reports `issues.coerced` when `String(parsed) !== raw`; tested at `env.test.ts:286-292`).

### 2.2 `initConfig` / `appConfig` / `env` boot contract

- `loadEffectiveConfig(source=process.env)` at `env.ts:269-321`: `envSchema.safeParse(source)` → malformed block (`291-296`, message format `- VAR: msg (received <raw>)`); unknown-project-var scan (`282-287`) → strict throw with fix hint (`298-307`, mentions `extend Shared/config/env.ts` or `CONFIG_STRICT=false`); else returns `{config, issues}`.
- `redactedConfigReport()` at `env.ts:336-351`: `SECRETISH_KEY_RE=/(KEY|TOKEN|PASSWORD|SECRET)/i` (`323`) → `[redacted]`; `*_URL` → `urlOrigin()` (`325-331`, origin-only); else raw. `formatConfigReport()` at `env.ts:353-357` aligns `key = value`.
- `initConfig(options)` at `env.ts:365-387`: calls `loadEffectiveConfig()` with real `process.env`, caches in module `cachedResult` (`359`), prints redacted report via `console.log` (or custom fn), prints `CONFIG_STRICT=false` unknowns + `coerced` via `console.warn` (`376-383`). No file I/O today.
- `appConfig` proxy at `env.ts:389-418`: `get`/`has`/`ownKeys`/`getOwnPropertyDescriptor` all throw `appConfig accessed before initConfig()` if `cachedResult==null` (`391-394`, `399-402`, `407-410`).
- Eager `env` singleton at `env.ts:420`: `export const env = loadEffectiveConfig().config` — evaluated at import time, **before** `initConfig()`. Any file-overlay loader must run before first `env` import or replace this line, otherwise two sources of truth exist.
- Boot call: `packages/server/src/index.ts:23-28` (`try{initConfig()}catch{process.exit(1)}`). `index.ts:66-68` consumes `env.CLIENT_ORIGIN`; `index.ts:211` consumes `env.PORT`; `index.ts:113-124` branches timers on raw `process.env.QUEUE_MODE` (not `env`); `index.ts:116-117` starts `startSpawnRetentionSweeper()` + `startBudgetReconciler()` in inline mode only; `index.ts:202-207` calls `seedBootstrapAdminKey()`.
- `packages/server/src/worker.ts:7-28` **never calls `initConfig()`**; reads `process.env.QUEUE_MODE` (`8`) and `getDb()` (`11`) directly. File loader must be invoked in worker boot too or worker/API diverge.
- Tests pinning behavior: `packages/server/src/Shared/config/env.test.ts` (305 lines) — defaults (`32-63`), reserved flags (`65-76`), malformed blocks boot (`78-119`), unknown-prefix strict block + `PORT_TYPO` exempt (`121-144`), lenient rollback (`146-157`), OS junk never flagged incl. `OPENAI/ANTHROPIC/GEMINI_API_KEY` (`159-181`), redaction (`183-216`), `initConfig` logging (`218-267`), proxy (`269-276`), `describe()` coverage (`278-284`), coercion (`286-292`), prefix/exact coverage (`294-304`).

### 2.3 `workspace_settings` readers / writers (all `id=default`)

Schema: `packages/server/src/db/schema.ts:444-454`:

```ts
workspaceSettings = pgTable("workspace_settings", {
  id: text("id").primaryKey(),                                     // :445
  globalSoftCap: integer("global_soft_cap").notNull().default(1000000), // :446
  perProviderBudget: jsonb("per_provider_budget").$type<Record<string,{
    softCap:number; used:number; resetPeriod:"daily"|"weekly"|"monthly"|"never"; lastResetAt:string;
  }>>().notNull().default(sql`'{}'::jsonb`),                      // :447-452
  updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(), // :453
});
```

Mirrored legacy DDL at `packages/server/src/db/bootstrap.ts:62-67` and type at `packages/server/src/types/index.ts:38-46` (`TokenBudget`).

Readers/writers (every query filters `eq(workspaceSettings.id,"default")`):

- `packages/server/src/routes/workspace.ts:33-39` — `GET /api/workspace/settings`: `select().from(workspaceSettings).where(id=default).limit(1)` (`34`); 404 if missing (`35-37`); returns full row (`38`).
- `workspace.ts:42-59` — `PUT /api/workspace/settings`: zod `updateSettingsSchema` (`10-12`, only `globalSoftCap?`); `update().set({...body,updatedAt}).where(id=default).returning()` (`46-53`); 404 if missing (`54-56`).
- `workspace.ts:62-71` — `GET /api/workspace/budget`: same select (`63`); returns `{globalSoftCap, perProviderBudget}` (`67-70`).
- `workspace.ts:74-116` — `PUT /api/workspace/budget`: zod `budgetUpdateSchema` (`14-25`, per-provider `{softCap, used?, resetPeriod, lastResetAt?}`); re-selects (`78`); builds `updatedSettings={updatedAt}` (`83-85`); overwrites `globalSoftCap` if present (`87-89`); **merges** `perProviderBudget` provider-by-provider preserving `used`/`lastResetAt` when omitted (`91-106`); `update().set(updatedSettings).where(id=default).returning()` (`108-112`).
- `workspace.ts:119-146` — `POST /api/workspace/budget/reset`: re-selects (`120`); clones budget (`125-126`); zeroes every provider `used=0` + fresh `lastResetAt` (`128-134`); writes back (`136-142`). Note: does **not** touch `perProviderBudget.__global.used` explicitly — the hot ledger key used by `tokenTracker.ts:206` survives a "reset" unless a `__global` provider entry exists. This is a live bug the migration must close (see §7).
- Seed: `packages/server/src/db/seed.ts:215-226` inserts `{id:"default", globalSoftCap:1000000, perProviderBudget:{}}` if absent.

### 2.4 `tokenTracker.ts` — hot ledger + daily reconcile

File: `packages/server/src/Shared/core/tokenTracker.ts` (276 lines).

- `numEnv()` at `:24-29` reads `BUDGET_RECONCILE_MS` raw from `process.env` (bypasses zod — must move to loader).
- `TokenTracker.trackUsage()` at `:44-171`: resolves workspace for event scope (`56-63`); computes analytics-only USD via `computeCostUsd()` (`68`, `:174-192`, `TtlCache(30s,200)` at `:22`, `cost_per_1k` lookup, `rate*(prompt+completion)/1000` at `:191`); inserts `token_usage_log` row `tok-<ms>-<rand>` (`80-91`); calls `incrementBudgetLedger(totalTokens)` (`94`); no-row → legacy no-op + `workspace:sync` (`95-99`); logs `Consumed x / cap` (`103`); emits `workspace:sync` (`106`); `consumed>=cap` → `EscalationChain.escalate(BUDGET_EXCEEDED)` + `return true` (`109-122`); `consumed>=0.8*cap` → edge-triggered `budget:warning` (`125-164`, `budgetWarningState` at `:32`, `allocateSequence` + `messages` insert in `withTransaction` at `:142-163`); else re-arms (`165-168`).
- `incrementBudgetLedger()` at `:199-216` — **the contended primitive**: single-statement `UPDATE workspace_settings SET perProviderBudget=jsonb_set(...'{__global,used}', to_jsonb(COALESCE((...#>>'{__global,used}')::numeric,0)+delta::numeric)), updatedAt=now() WHERE id='default' RETURNING used,cap` (`203-213`); returns `{consumedTokens:Number(used), globalSoftCap:Number(cap)}` (`215`); `null` if row missing (`214`). No `SUM` on hot path (comment `:38-42`, `:194-198`).
- `reconcileBudgetUsage()` at `:229-253`: `SELECT sum(totalTokens) FROM token_usage_log` (`232`); `UPDATE ... jsonb_set(... to_jsonb(truth::numeric)) WHERE id=default RETURNING used` (`235-244`); `logMetric(budget.reconcile)` (`246-250`); returns `{consumedTokens, reconciled:Boolean(row)}` (`252`).
- `startBudgetReconciler()` at `:263-276`: once-guard `started` (`255`, reset at `:258-260`); `setInterval(reconcile, numEnv(BUDGET_RECONCILE_MS, 24h))` (`267-272`); `timer.unref()` (`273`).
- Fake for tests: `packages/server/src/Shared/core/tokenTrackerTestDb.ts:1-157` — `budgetFixture{settings:[{globalSoftCap:1000}],used,consumedSum,moduleCosts,selectCalls,ledgerUpdates}` (`16-23`); `parseLedgerPatch()` distinguishes `increment` (has `+`) vs `set` (`53-71`); `applyLedgerPatch()` (`73-89`); `fakeBudgetDb` (`91-134`); `fakeWithTransaction` (`136-138`). Tests at `tokenTracker.test.ts:48-227` assert zero `selectCalls` on hot path (`135`), reconcile convergence (`138-152`), no-row no-op (`154-164`), warning edge-trigger (`54-113`), cost logging (`167-206`), single timer (`208-227`).

### 2.5 `POST /api/workspace/database` semantics

`packages/server/src/routes/workspace.ts:148-209`:

- Disabled-by-default comment (`148-150`). Gate at `:155-168`: `allowMutation = process.env.ENABLE_DB_CONFIG_MUTATION==="true"` (`155`), `adminToken = process.env.WORKSPACE_ADMIN_TOKEN` (`156`), `providedToken = x-admin-token || Authorization:Bearer` (`157`); `!allowMutation||!adminToken` → `403` (`159-165`); mismatch → `401` (`166-168`). Note: reads raw `process.env`, not `env`/`appConfig`.
- Validation at `:172-180`: `new URL(newUrl)`; protocol must be `postgres:`/`postgresql:` else `400` (`175-177`); unparsable → `400` (`178-180`).
- Hot-reload at `:182-197`: `oldUrl=env.DATABASE_URL` (`182`); `await closeDatabaseConnection()` (`184`); audit `request.log.warn([SECURITY] ... testing connection only, not persisting)` (`186`); **mutates in-memory only** `env.DATABASE_URL=newUrl; process.env.DATABASE_URL=newUrl` (`187-188`, works only because `env.ts:420` exports a mutable object — `appConfig` proxy would throw on set); probes `db.select().from(workspaceSettings).limit(1)` (`191`); returns `{success:true, message:"... verified (NOT persisted). Manually update .env and restart to persist."}` (`194-197`); comment at `:193` forbids filesystem write (TO_DO 5.1).
- Rollback at `:198-207`: `closeDatabaseConnection()`, restore `env`+`process.env` to `oldUrl` (`200-201`), `400` with `verification failed` (`202-207`).
- DB layer: `packages/server/src/Shared/config/database.ts:10-16` `requireDatabaseUrl()` throws `DATABASE_URL is not set...` on first `getDb()`/`getSqlClient()` use (schema marks it optional at `env.ts:83`); pool at `:18-31` (`max:20,idle:20s,connect:10s,lifetime:30m,prepare:false`); `getDb()` memoizes drizzle (`33-41`); `withTransaction()` (`55-57`); `closeDatabaseConnection()` nulls both (`78-84`); `ensurePgVectorExtension()` (`59-76`). `bootstrap.ts:14-25` separate single-connection migrator; `bootstrap.ts:496-507` branches `LEGACY_BOOTSTRAP=true` → hand-rolled `ensureSchema()` else `migrate()+ensurePgVector()+seed()`.
- Reporting via `redactLogPayload()` (`104`, `109-114`, `116`); dry-run default message (`108-114`), apply summary (`116`).

### 2.6 Secret handling reference

- `backfill-encrypt-secrets.ts` (127 lines; `db:encrypt-secrets` script): dry-run default, `--apply` writes; covers `model_modules`, `generation/embedding/indexing_model_profiles`, `mcp_servers.env_vars`; redacted logging.
- Envelope: `Shared/core/secretBox.ts` — `ENVELOPE_PREFIX=enc:v1:`, `aes-256-gcm`; key from `CREDENTIALS_ENCRYPTION_KEY` (hex64 / b64-32 / scrypt-passphrase, cached after first read — rotation requires restart); `encrypt()` no-op on empty/already-encrypted, warns once + returns plaintext if no key; `decrypt()` returns plaintext as-is with once-warn, returns envelope as-is if no key, throws on malformed/wrong-key.
- Writers encrypt: `Modules/moduleService.ts:205` (create), `:214` (update), `routes/providers.ts` (all profile/module create/update paths), `routes/mcp.ts:17`. Readers decrypt at single choke points: `ContextPipelineManager.ts:106-108`, `moduleService.ts:231`, `routes/providers.ts:155`, `librarianRuntime.ts:265`, `mcpClientManager.ts:77-79`.
- `CREDENTIALS_ENCRYPTION_KEY` itself is optional text, redacted, empty in `.env.example`. Rotation = decrypt-all + re-encrypt (no key id in v1).

---

## 3. Target Design

### 3.1 File layout proposal (exact paths, relative to `packages/server/`)

All paths resolved from `process.cwd()` (server package root in dev, container workdir in prod). Override root via `CONFIG_DIR` (default `./data`). Files are `0600` on creation; directory `0700`.

| File | Purpose | Created by |
|---|---|---|
| `data/config.json` | All **mutable, non-secret flags** (bools/ints/enums/URLs-that-aren't-secrets). Replaces `process.env` + `.env` for everything except bootstrap secrets + `DATABASE_URL` pointer. | Boot ensures + `PUT /api/workspace/settings` extensions |
| `data/budget.json` | Budget **caps** (`globalSoftCap`, `perProviderBudget` without `__global.used`). Human-editable. | Boot ensures + `PUT /api/workspace/budget` + `POST /api/workspace/budget/reset` |
| `data/secrets.json` | **Secret values** (`CREDENTIALS_ENCRYPTION_KEY` never stored here; stores `BRAVE/TAVILY/SERPER_API_KEY`, `AUTH_TOKEN` legacy, `WORKSPACE_ADMIN_TOKEN` hash-or-envelope, `DATABASE_URL` envelope). `0600`, envelopes only. | `POST /api/workspace/database`, secret-rotation endpoints, manual import |
| `data/config.meta.json` | Ephemeral: `{version, updatedAt, updatedBy, lastKnownGoodSha}` for rollback/audit. Written alongside every mutation. Not hand-edited. | Loader |

Rationale: three concerns, three files. Flags (`config.json`) change rarely and want readable diffs; caps (`budget.json`) change via UI sliders; counters/secrets change at machine speed and must not dirty human diffs or leak into logs.

#### 3.1.1 `data/config.json` schema (zod, superset-checked against `envSchema`)

Covers the full flag set from §2.1 with identical bounds/defaults: `NODE_ENV`, `PORT`, `HOST?`, `CLIENT_ORIGIN`, `CORS_ORIGIN?`, `REDIS_URL?`, `SYSTEM_ACTOR_ID`, `WORKSPACE_DIR?`, `AUTH_STRICT`, rate/socket/parallel/durable flags, provider timeouts, `STREAM_BATCH_MS`, `PIPELINE_PARALLEL`, `ORPHAN_AFTER_MS`, `PER_ITERATION_BUDGET`, all `MEM_*`, `RETENTION_*`, `BUDGET_RECONCILE_MS`, `TOOL_RWP*`, `LEGACY_GUARD`, `MODEL_ROUTE`, `DELTA_INDEX`, `RUNS_ENABLED`, `METRICS_ENABLED`, `LEGACY_BOOTSTRAP`, `ENABLE_DB_CONFIG_MUTATION`, `QUEUE_MODE`, `APPROVALS_*`, `SWARM_*`, `DEMO_FALLBACK`, `UNTRUSTED_WRAP`, `QUERY_DATABASE_ENABLED`, `SYSTEM_SCHEDULER_ENABLED`, `SEARCH_PROVIDER_PRIORITY?`, `RESEARCH_V1`, `OTEL_*`, `EMBEDDING_*`, `CONFIG_STRICT` — all with the same defaults as `env.ts:70-205`, `.strict()` (unknown file keys → boot error, mirrors `env.ts:298-307`).

Excluded from `config.json` by design (stay in env or `secrets.json`): `DATABASE_URL`, `AUTH_TOKEN`, `API_KEY`, `WORKSPACE_ADMIN_TOKEN`, `CREDENTIALS_ENCRYPTION_KEY`, `BRAVE/TAVILY/SERPER_API_KEY`. They are secrets / bootstrap pointers (§3.3).

#### 3.1.2 `data/budget.json` schema

```ts
const providerBudgetSchema = z.object({
  softCap: z.number().int().min(0),
  resetPeriod: z.enum(["daily","weekly","monthly","never"]),
  lastResetAt: z.string().datetime().optional(), // ISO; server fills on write
  // NOTE: no `used` here — per-provider `used` besides __global is advisory;
  // ground truth is token_usage_log. Kept for UI compat but ignored by enforcement.
  used: z.number().int().min(0).optional(),
});
const budgetFileSchema = z.object({
  version: z.literal(1).default(1),
  globalSoftCap: z.number().int().min(0).default(1000000),
  perProviderBudget: z.record(z.string(), providerBudgetSchema).default({}),
  updatedAt: z.string().datetime().optional(),
}).strict();
// Forbidden key: "__global" may not appear in perProviderBudget (reserved for counter).
```

Enforcement reads `globalSoftCap` from this file; `perProviderBudget[*].softCap` is advisory/UI-only in v1 (today's enforcement only checks the global cap at `tokenTracker.ts:109`).

#### 3.1.3 `data/secrets.json` schema (envelopes only, never plaintext)

```ts
const secretsFileSchema = z.object({
  version: z.literal(1).default(1),
  DATABASE_URL: z.string().min(1).optional(),      // enc:v1:... envelope OR plaintext only if no CEK (with warn)
  BRAVE_API_KEY: z.string().min(1).optional(),     // envelope
  TAVILY_API_KEY: z.string().min(1).optional(),    // envelope
  SERPER_API_KEY: z.string().min(1).optional(),    // envelope
  WORKSPACE_ADMIN_TOKEN: z.string().min(1).optional(), // scrypt hash (api_keys-style) or envelope; never plaintext compare
  AUTH_TOKEN: z.string().min(1).optional(),        // legacy only; envelope; rejected when AUTH_STRICT=true
  updatedAt: z.string().datetime().optional(),
}).strict();
```

`CREDENTIALS_ENCRYPTION_KEY` is **never** stored in any file. It remains an env-only bootstrap secret (or OS keychain in future). Rationale: storing the data-encryption key next to the ciphertexts it protects collapses the threat model to filesystem ACLs alone.

### 3.2 Loader replacing `initConfig` (keep fail-fast + strict-unknown-key)

New module `packages/server/src/Shared/config/fileConfig.ts` (gate-exempt shared code):

```
loadLayeredConfig(opts?: { configDir?: string; env?: NodeJS.ProcessEnv }): EffectiveConfigResult
initFileConfig(opts?: { log?: boolean|((l:string)=>void); configDir?: string }): EffectiveConfigResult
getFileConfig(): Env  // replaces appConfig/env reads after boot
```

Precedence (lowest → highest): `config.json` file → `budget.json` (caps only) + `secrets.json` (secrets only) → `process.env` overrides → defaults. Env wins so containers/CI keep working and `CONFIG_STRICT` typos still fail even if the file is clean. Document this order in `docs/environment.md` and `.env.example` header.

Required behavior (port of `env.ts:269-387`):

1. **Parse file first**: read `config.json` (if missing → create from defaults with `0600`, log `created data/config.json from defaults`), `JSON.parse` errors → `ConfigError` naming file+offset (`Unexpected token ... in data/config.json`), never boot with half-parsed config.
2. **Merge**: `{...fileLayer, ...envLayer}` where `envLayer` drops `undefined`/empty-trimmed values (reuse `trimToUndefined` semantics at `env.ts:48-52`). Type-coerce file layer strictly (file already holds numbers/booleans; string `"3001"` in file is malformed → `ConfigError`, unlike env where `"3001"` is valid and reported in `issues.coerced`).
3. **Validate once** through existing `envSchema` (`env.ts:70-205`) — do not fork a second schema for validation; the file schema above is a view, `envSchema` remains the validator so bounds/descriptions stay single-sourced.
4. **Strict unknown keys on both layers**: union of `Object.keys(fileJson)` + project-namespace `Object.keys(env)` minus `SCHEMA_KEYS` minus `CONFIG_STRICT` → `unknownProjectVars`. File unknown keys are prefixed in the error (`data/config.json: unknown key AUTH_TYPO — ...`). `CONFIG_STRICT=false` downgrades both to `console.warn` (same message shape as `env.ts:376-379`).
5. **Redacted boot report**: reuse `redactedConfigReport()`/`formatConfigReport()` unchanged; add two lines: `config source = file+env (file: data/config.json, overrides: N env vars)` and `budget source = data/budget.json (cap=...)`. Never print secret values, file paths with credentials, or envelope contents beyond `[redacted]`.
6. **Replace singletons**: `initConfig()` becomes a thin wrapper calling `initFileConfig()` (keep export for compat, mark deprecated); `appConfig` proxy and `env` const delegate to the same `cachedResult` so existing `env.PORT` (`index.ts:211`) / `env.CLIENT_ORIGIN` (`index.ts:66`) reads keep working. Delete the eager `loadEffectiveConfig()` at `env.ts:420` in favor of lazy delegation — otherwise import order reintroduces the split-brain.
7. **Migrate raw `process.env` readers** to the loader (else the file is a lie): `authGate.ts:18-19` (`AUTH_STRICT`/`AUTH_TOKEN` module consts — must become per-request `getFileConfig()` reads or they freeze at import time), `workspace.ts:155-156` (`ENABLE_DB_CONFIG_MUTATION`, `WORKSPACE_ADMIN_TOKEN`), `tokenTracker.ts:24-29` (`BUDGET_RECONCILE_MS`), `ContextPipelineManager.ts:100-104` + `searchProviderGate.ts` + provider files (search keys), `RuntimeRouter.ts` / `RuntimeExecutor.ts` (`RESEARCH_V1`), `index.ts:113` (`QUEUE_MODE`), `secretBox.ts` (`CREDENTIALS_ENCRYPTION_KEY` — stays env-only but must be read through one helper so tests can reset `cachedKey`).
8. **Atomic writes**: every mutation writes `tmp.<rand>` + `fsync` + `rename` + `fsync(dir)`; preserves `0600`; bumps `config.meta.json:{version,updatedAt,updatedBy,sha}`; keeps `config.json.bak` (last-known-good) for rollback. Malformed write candidates are validated with `envSchema.safeParse` before rename; on failure return `400` and leave the file untouched.

### 3.3 Secret handling (never plaintext regressions)

- `CREDENTIALS_ENCRYPTION_KEY` stays **env-only**. `secretBox.loadKey()` unchanged except extracted to `getCredentialsKeySource()` so the file loader and `secretBox` share one reader; cached-key reset hook for tests must be exported (today tests rely on `vitest.resetModules` + `process.env` mutation).
- `BRAVE/TAVILY/SERPER_API_KEY`, `DATABASE_URL`, `AUTH_TOKEN`, `WORKSPACE_ADMIN_TOKEN` move to `data/secrets.json` **as `enc:v1:` envelopes** (same `secretBox.encrypt()`). Write path: API receives plaintext over TLS → `encrypt()` immediately in handler → persist envelope → zero the plaintext variable (no logging; `redactLogPayload` at every `console.log` in the path). Read path: `decrypt()` only at existing choke points (`ContextPipelineManager.ts:106-108`, `mcpClientManager.ts:77-79`); search providers read decrypted values from the loader, never raw `process.env`.
- `WORKSPACE_ADMIN_TOKEN` upgrade: store scrypt hash (reuse `hashApiKey`/`verifyHashMatch`) rather than reversible envelope; compare with `timingSafeEqual`. Legacy plaintext env value, if present, is accepted once at boot (warn `plaintext admin token from env — migrate to secrets.json`), never written back to disk as plaintext.
- `API keys` (`api_keys` table) and provider `api_key` columns / `mcp_servers.env_vars` **stay in Postgres** (§8). `backfill-encrypt-secrets.ts` gains a `--source=file` mode that also seals any plaintext values found in `secrets.json` (idempotent via `isEncrypted()`); dry-run remains default.
- Boot validation gaps closed: if `secrets.json` contains plaintext values while `CREDENTIALS_ENCRYPTION_KEY` is set → `ConfigError` (`plaintext secret in data/secrets.json: BRAVE_API_KEY — run db:encrypt-secrets --apply`); if envelopes present while key unset → boot warns and continues with envelopes opaque (search returns `[]`, provider decrypt deferred).
- File permissions enforced: loader `stat`s `secrets.json` mode; `0o777/0o644` → `ConfigError` suggesting `chmod 600` (bypass with `CONFIG_STRICT=false` → warn). Never `console.log` envelope contents; redaction tests extended to `secrets.json` loader output.

### 3.4 Hot budget counter design

#### Option A — Keep counter in Postgres, caps in file (RECOMMENDED)

- `data/budget.json` holds `{globalSoftCap, perProviderBudget}` (caps). The hot `__global.used` counter **stays** in `workspace_settings.perProviderBudget.__global.used` bumped by the existing atomic `UPDATE...jsonb_set...+RETURNING` at `tokenTracker.ts:203-213`.
- `incrementBudgetLedger()` unchanged except `globalSoftCap` comes from `getFileConfig()/budget.json` while `consumedTokens` comes from `RETURNING`. `reconcileBudgetUsage()` unchanged (still `SUM(token_usage_log)` → `jsonb_set`), still the convergence mechanism for drift.
- `PUT /api/workspace/budget` / `reset` write caps to `budget.json` (atomic rename) **and** mirror `global_soft_cap` into the Postgres row; `GET /api/workspace/budget` merges `{fileCaps, dbUsed}` so UI keeps working.
- Pros: keeps the only proven linearizable increment in the system; no torn writes; no cross-process lock protocol; survives crashes (Postgres WAL); parallel runs and multi-replica deploys remain correct. Cons: `workspace_settings` table retained (one row) — acceptable, see §8.
- Migration: one-time copy `SELECT global_soft_cap, per_provider_budget FROM workspace_settings WHERE id=default` → `budget.json` (strip `__global.used` from caps, preserve other providers).

#### Option B — File lock / atomic-counter file (NOT recommended)

- Counter lives in `data/budget.counter.json` updated by read-modify-write under an OS lock or optimistic-concurrency retry. Pros: zero Postgres dependency, works offline. Cons: read-modify-write races lose increments (both read `used=100`, both write `120` → 20 tokens lost → **double-spend**); `flock` fails over NFS/mounts, is advisory, blocks the event loop, has no WAL; multi-process (API + `worker.ts` + BullMQ) and multi-replica deploys cannot share the lock.
- Verdict: **adopt Option A**. If a future fully-embedded mode drops Postgres entirely, replace the counter with SQLite-WAL behind the same `incrementBudgetLedger` interface — never a bare JSON file.

### 3.5 Endpoint behavior changes

All workspace routes keep paths/status shapes; only persistence + validation source changes. All mutations require existing auth and validate with the same zod schemas; file validation failures return `400` with `ConfigError.issues`, never partial writes.

| Endpoint | Today | After (Option A) |
|---|---|---|
| `GET /api/workspace/settings` | `SELECT ... id=default`, 404 if missing | Read `data/config.json`; **redact secrets** (strip `*_KEY/*_TOKEN/DATABASE_URL` or return `_configured` booleans). Never 404 (file ensured at boot). |
| `PUT /api/workspace/settings` | `UPDATE ... id=default RETURNING`, 404 if missing | Validate body → `envSchema.safeParse` → atomic `config.json` rewrite + `meta.json` bump → return new effective config (redacted). Unknown keys → `400` when strict. |
| `GET /api/workspace/budget` | `SELECT ... id=default` → `{cap, perProvider}` | Merge `{globalSoftCap, perProviderBudget}` from `budget.json` + live `__global.used` from Postgres. Shape unchanged. |
| `PUT /api/workspace/budget` | Merge providers in JS, `UPDATE ... RETURNING` | Same merge, but persist caps to `budget.json` (strip `__global`), mirror `global_soft_cap` into Postgres row, `fsync`. Preserve-`used` semantics unchanged. |
| `POST /api/workspace/budget/reset` | Zeroes every provider `used` **except `__global`** (live bug) | Zeroes every provider `used` **including `__global.used`** in Postgres **and** resets advisory `used` in `budget.json`; bumps `lastResetAt`; emits `workspace:sync`. Fixes the silent-no-reset. |
| `POST /api/workspace/database` | In-memory only, `NOT persisted` message, raw `process.env` gate | Gate reads loader; on success: `encrypt(DATABASE_URL)` → `secrets.json` (atomic) → `closeDatabaseConnection()` → point in-memory `env` at new URL → probe → return `{success:true, message:"persisted to secrets.json; restart recommended"}`. Failure restores old URL **and** restores `secrets.json.bak`. |

---

## 4. Expected Files Touched (explicit list)

**New (3–4 files):**

1. `packages/server/src/Shared/config/fileConfig.ts` — layered loader, atomic writers, `initFileConfig`/`getFileConfig`, strict checks, redacted report extras.
2. `packages/server/src/Shared/config/fileConfig.test.ts` — loader unit tests (see §6).
3. `packages/server/data/.gitkeep` + `packages/server/scripts/ensure-data-dir.mjs` (or inline in loader) — dir/files bootstrap with `0700/0600`.
4. Optional: `packages/server/scripts/migrate-config-to-files.mjs` — one-shot `workspace_settings` + env → files importer (or fold into `db:push`).

**Modified (in order of blast radius, smallest first):**

5. `packages/server/src/Shared/config/env.ts` — `initConfig()` delegates to `initFileConfig`; `env` becomes lazy delegate; export `SCHEMA_KEYS`/`isProjectNamespaceVar`; no schema value changes.
6. `packages/server/src/Shared/config/database.ts` — `requireDatabaseUrl()` reads loader instead of `env.DATABASE_URL`; add `setDatabaseUrlInMemory()`; `closeDatabaseConnection()` unchanged.
7. `packages/server/src/Shared/core/secretBox.ts` — extract `getCredentialsKey()` shared with loader; export test reset for `cachedKey`; no algorithm change.
8. `packages/server/src/Shared/auth/authGate.ts` — `AUTH_STRICT`/`AUTH_TOKEN` consts → per-request loader reads; `requireAdmin()` accepts secrets.json hash + `api_keys` admin role.
9. `packages/server/src/routes/workspace.ts` — all six handlers → file persistence per §3.5; gate → loader; remove `env.DATABASE_URL=` direct mutation in favor of `setDatabaseUrlInMemory()`.
10. `packages/server/src/Shared/core/tokenTracker.ts` — `numEnv()` → loader `BUDGET_RECONCILE_MS`; `incrementBudgetLedger()` reads cap from `budget.json`; `trackUsage()` unchanged otherwise.
11. `packages/server/src/index.ts` — boot `initFileConfig()` before `Fastify()`; `QUEUE_MODE` + `CLIENT_ORIGIN` + `PORT` via loader; pass `configDir` from `CONFIG_DIR`.
12. `packages/server/src/worker.ts` — add `initFileConfig()` at top; `QUEUE_MODE` via loader.
13. `searchProviderGate.ts`, provider files, `RuntimeRouter.ts`, `RuntimeExecutor.ts`, `ContextPipelineManager.ts`, `routes/metrics.ts`, `routes/observability.ts` — raw `process.env` → loader reads.
14. `packages/server/src/db/seed.ts`, `db/bootstrap.ts` — seed ensures `budget.json` + minimal `workspace_settings` counter row (Option A); legacy DDL keeps counter table.
15. `packages/server/src/db/backfill-encrypt-secrets.ts` — add `secrets.json` sealing pass.
16. `tokenTrackerTestDb.ts`, `env.test.ts`, `tokenTracker.test.ts` — fakes + assertions for file caps/counter split.
17. `generate-env-doc.mjs`, `check-gates.mjs`, `check-redaction.mjs` — teach new file keys + redaction of `secrets.json`.
18. Docs/config: `.env.example`, `docs/environment.md`, `docs/implemented-backend/05-types-config.md`.

**Not touched:** `token_usage_log`, `costLedger.ts`, `apiKeyService.ts`, module/provider/MCP envelope call sites (only key source moves).

---

## 5. Ordered Implementation Steps

1. **Freeze the contract.** Copy `env.test.ts` expectations into `fileConfig.test.ts` skeleton (defaults, strict throw, lenient warn, OS-junk exempt, redaction, coercion). No prod code yet; confirm suite fails on missing module.
2. **Add `fileConfig.ts` loader (read-only).** Implement `loadLayeredConfig()` with file→env→default precedence, `envSchema` validation, dual-layer strict check, redacted report. Wire `initConfig()` as delegating wrapper; make `env`/`appConfig` delegate to shared cache. Boot both `index.ts` and `worker.ts` through it. Verify: existing `env.test.ts` green unmodified.
3. **Migrate raw `process.env` readers.** Replace the eleven bypass sites one by one, each with a targeted test run. Keep `CREDENTIALS_ENCRYPTION_KEY` env-only but behind the shared helper.
4. **Extract budget caps.** Add `budget.json` read path; `incrementBudgetLedger` reads cap from file, counter from Postgres. Add one-shot importer + `ensure-data-dir` with `0700/0600`. Fix the `__global` reset bug behind the same change.
5. **Move endpoints to files.** Convert the six `workspace.ts` handlers per §3.5 with atomic-write helper. Keep response shapes; add secret redaction to `GET settings`. Gate `POST database` on loader values.
6. **Move secrets.** Add `secrets.json` (envelopes only) + write paths for `POST database` and search-key rotation; extend `backfill-encrypt-secrets.ts` with `--source=file` sealing; enforce `0600` + plaintext-while-key-set boot error.
7. **Seed/bootstrap alignment.** `seed.ts`/`bootstrap.ts` ensure files + counter row; `DATABASE_URL` resolution order: `secrets.json` envelope → `process.env` → `config.json` pointer → `requireDatabaseUrl()` throw.
8. **Docs + scripts.** Update `.env.example`, `docs/environment.md`, `generate-env-doc.mjs`, `check-gates/redaction/events` scripts; add `DB-keeps-what` matrix to backend docs.
9. **Soak + reconcile.** Run `reconcileBudgetUsage()` before/after importer; assert `SUM(token_usage_log)` equals file+DB counter; leave daily timer unchanged.

---

## 6. Verification (tests + commands)

**Unit (must stay green, extend — do not weaken):**

- `npx vitest run src/Shared/config/env.test.ts` — all 14 cases must pass unmodified after Step 2.
- New `npx vitest run src/Shared/config/fileConfig.test.ts` — file-missing creates defaults; malformed JSON → `ConfigError` with filename; unknown file key strict-throws / lenient-warns; env overrides file; `0600` enforced; `secrets.json` plaintext-while-key-set throws; atomic-write failure leaves `.bak` intact; `__global` in `budget.json` rejected.
- `npx vitest run src/Shared/core/tokenTracker.test.ts` — hot-path `selectCalls==0`, reconcile convergence, no-row no-op, warning edge/re-arm/cap-change, cost null-safety, single timer, all green with file caps.
- `npx vitest run src/Shared/core/secretBox.test.ts src/SearchProviders/searchProviderGate.test.ts src/runtime/runtimeLifecycle.test.ts`.

**Integration / manual:**

- `npm run typecheck` and `npm run lint:gates` — gates must not flag the new `Shared/config/fileConfig.ts` imports (shared code is exempt per domain-facade rule).
- `npm run db:encrypt-secrets` (dry-run) then `--apply` — zero `plaintextFound` before/after; envelopes start with `enc:v1:`.
- Parallel-budget soak (Option A proof): 20 concurrent `trackUsage` callers → `SELECT used FROM workspace_settings WHERE id='default'` equals `SUM(total_tokens)` after reconcile; no lost increments. Repeat with `MAX_PARALLEL_AGENTS=4` mention storm.
- Endpoint matrix with `curl`: `GET/PUT settings`, `GET/PUT budget`, `POST budget/reset` (assert `__global.used==0` after), `POST database` with bad protocol (`400`), bad token (`401`), disabled flag (`403`), good URL (probe + envelope + `meta.json` bump), then failed probe (restores `.bak`).
- Boot matrix: missing `data/` (auto-create), malformed `config.json` (exit 1 with file-named error), unknown `AUTH_TYPO` strict (exit 1) / lenient (warn + boot), `CONFIG_STRICT=false` still rejects malformed `PORT`, `0600` violation (error/warn per strictness).

---

## 7. Risks & Rollback

| Risk | Impact | Mitigation / Rollback |
|---|---|---|
| **Budget double-spend (hot counter under parallel runs)** — file read-modify-write loses increments; cap enforcement passes late; agents overspend. | **P0 — money/quotas.** | **Adopt Option A**: counter stays in Postgres atomic `jsonb_set+RETURNING`. File holds caps only. Daily `SUM` reconcile remains convergence net. Rollback: revert `budget.json` cap read to `workspaceSettings.globalSoftCap`; counter never left Postgres. Load-test before merge. |
| **Torn writes / half-JSON** — crash mid-write leaves `config.json` unparseable → boot loop. | P0 boot. | Atomic `tmp+fsync+rename+fsync(dir)` + pre-rename `safeParse` + `.bak` last-known-good + `meta.json` sha. Loader falls back to `.bak` with loud warn only when `CONFIG_STRICT=false`; strict refuses with recovery command. |
| **Boot validation gaps** — file keys bypass strictness; typo ships silently; eager `env` shadows file. | P1 silent misconfig. | Single validator (`envSchema`) for both layers; `.strict()` file schemas; union unknown-key check; delete eager singleton; `worker.ts` bootstraps identically. `env.test.ts` + `fileConfig.test.ts` pin both. |
| **Secret leaks (plaintext regression)** — plaintext keys land in files, logs, or `meta.json`; CEK copied next to ciphertexts. | **P0 security.** | Envelopes-only `secrets.json` (`0600`, `stat` check); CEK env-only; write-path `encrypt()`-immediate + `redactLogPayload`; boot `ConfigError` on plaintext-while-key-set; `check-redaction.mjs` extended; `GET settings` redacted; rotation = decrypt-all/re-encrypt. Rollback: restore `secrets.json.bak`, restart. |
| **`POST database` persistence flip** — today explicitly NOT persisted; persisting changes disaster-recovery posture. | P1 availability. | Persist only after probe succeeds; keep `.bak`; return `restart recommended`; document manual restore. Rollback: `cp secrets.json.bak secrets.json && closeDatabaseConnection()`. |
| **`PUT budget` merge vs `__global` reset skew** — file split can double the skew. | P1 UX/quota. | Fix in same PR: reset zeroes both stores atomically (DB first, file second; reconcile confirms). Regression test asserting `used==0` in both. |
| **Auth freeze** — `authGate` consts evaluated at import; file change never takes effect until restart. | P1 lockout. | Per-request loader reads; `requireAdmin` re-checks hash; document restart requirement for `AUTH_STRICT`/`WORKSPACE_ADMIN_TOKEN`. |
| **Multi-replica divergence** — two API replicas each cache files; caps differ. | P2. | Single-writer guidance (mutate via API); `updatedAt`/`sha` in `meta.json` surfaced in `GET` for drift detection. Out of scope for v1 — document. |
| **Rollback overall** | — | Feature-flagged by presence of `data/`: if `CONFIG_DIR` absent, loader falls back to pure-env + `workspace_settings` row (today's code paths kept, not deleted, for one release). `git checkout` + `rm -rf data/*.bak` + restart restores. No migration drops tables/columns. |

---

## 8. Dependencies — DB-Keeps-What Matrix (JSON-store spec alignment)

The JSON-store program moves *mutable singleton config* out of Postgres; the relational ledger, identity, and content stay. `workspace_settings` is the **only** table whose contents migrate to files (caps; counter stays per Option A). No `DROP TABLE` / `DROP COLUMN` in this spec.

| Table (`db/schema.ts`) | Rows | Verdict | Rationale |
|---|---|---|---|
| `workspace_settings` | 1 (`id=default`) | **Move caps → `budget.json`; keep `__global.used` counter row (Option A)** | Singleton config is the migration target. Counter needs Postgres atomicity. Long-term: drop table only after SQLite-WAL or equivalent lands. |
| `token_usage_log` | append-only, indexed | **Keep (ground truth)** | Reconcile source, cost ledger joins, audit. Never file-backed (unbounded growth). |
| `api_keys` | few, scrypt hashes | **Keep** | Auth identity; hashes must stay server-side in Postgres. File stores no API keys. |
| `model_modules` + profiles (envelopes) | per-model | **Keep** | Provider credentials per-resource, encrypted at rest, resolved at pipeline. File holds only global search keys. |
| `mcp_servers` (envelopes) | per-server | **Keep** | Same as above. |
| `agents`, `channels`, `messages`, `channel_sequences` | core content | **Keep** | Product data, FK targets of `token_usage_log`. |
| Cost rollups, queues, RAG, skills, approvals, swarms, workspaces, VFS, artifacts | various | **Keep** | Runtime/ledger/content; cost rollups and queues depend on them. |
| `workspaces` sandbox roots / `LocalVFS` | per-workspace | **Keep** | `WORKSPACE_DIR` override becomes file-configurable, but workspace rows stay relational. |
| `.env` / `process.env` bootstrap | — | **Keep as override layer** | Containers/CI, `CREDENTIALS_ENCRYPTION_KEY`, initial `DATABASE_URL` pointer. Precedence documented. |
| `data/config.json`, `data/budget.json`, `data/secrets.json`, `data/config.meta.json` | 1 each | **New (this spec)** | File surfaces per §3.1. |

**Ordering vs other specs:** land JSON-store spec's `DATA_DIR`/`CONFIG_DIR` + atomic-write helper first (this spec reuses it); then this spec's loader; then any future spec that retires the `workspace_settings` counter row.

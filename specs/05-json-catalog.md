# SPEC 5 — Agents / Rosters / Modules as Local JSON (Full Replacement)

## 0. Metadata

- **Status:** Draft spec (research only, no code changed).
- **Scope root:** `packages/server/src`
- **Decision (fixed):** FULL replacement. Postgres tables are deleted; local `.json` files are the store. All writes go to files.
- **Roster rule (fixed):** Roster = per-workspace JSON file, replacing `workspace_agents`.
- **Facade rule (repo `AGENTS.md`):** `*Gate.ts` exported shapes stay stable. All refactors happen behind `agentGate`, `moduleGate`, `skillsGate`, `workspaceGate`, `runtimeGate`.

---

## 1. Goal & Non-Goals

### 1.1 Goal

Replace the Postgres-backed catalog for **agents, 5 module tables, skills + links, instruction stacks, and rosters** with local JSON files, with zero change to public gate signatures:

| Gate | File | Current ports (must not break) |
|---|---|---|
| `agentGate` | `Agents/agentGate.ts:50-58` | `list, getById, create, update, delete, dispatch, escalate` |
| `moduleGate` | `Modules/moduleGate.ts:139-179` | `findReferencingAgent, testConnection, listAll, model.{list,get,create,update,remove,test}, instruction.{...}, toolkit.{...}, constraints.{...}, capabilities.{...}` |
| `skillsGate` | `Skills/skillsGate.ts:28-39` | `list, getById, create, update, delete, getAgentSkills, assignSkill, removeSkill, getResolvedToolsForAgent, invalidateAgentCaches` |
| `workspaceGate` | `Workspace/workspaceGate.ts:63-70` | `requireId, assertMatch, assertExists, getMountedAgentIds, resolveHttpWorkspaceId, requireHttpWorkspace` (+ `WorkspaceManager` class) |
| `runtimeGate.invalidateModelModuleCache` | `runtime/runtimeGate.ts:127` | `(moduleId?) => void` |

After the flip:

- `AgentRegistry`, `moduleService.*`, `SkillService.*`, `WorkspaceManager.mount/unmount/getAgentSessions`, `workspaceContext.getMountedAgentIds` read/write JSON, not `getDb()`.
- Every reader keeps compiling and passing because it goes through gates or through a gate-compatible loader shim.
- Postgres tables listed in §3.8 are dropped in a forward-only migration after a DB-dump export.

### 1.2 Non-goals

- No change to `messages, channels, categories, channel_index, compressed_summaries, token_usage_log, runs, runtime_states, runtime_overrides, channel_sequences, durable_events, workspaces, workspace_nodes, workspace_events, artifacts, approvals, api_keys`.
- No change to `mcp_servers` table itself (stays in Postgres). Only its secret-handling pattern (`secretBox` envelopes) is reused for JSON secrets.
- No change to legacy `generation_model_profiles / embedding_model_profiles / indexing_model_profiles` except they remain covered by the old backfill script until retired; they are not migrated to JSON.
- No new auth model, no new queue backend, no pgvector change (see §8 Dependencies).
- No multi-writer clustering. Single Node process is the writer; multi-process is out of scope and must fail loudly (see §3.4).

---

## 2. Current State (with `file:line`)

### 2.1 Service CRUD shapes

#### Agents — `Agents/agentService.ts`

- `mapAgentProfile(row)` (`:32-47`). Null→`undefined` coercion for `species, avatar, l3Subtype, toolkit/constraints/capabilitiesModuleId, fallbackAgentId`; `categoryPermissions ?? []`; `contextTokenCap` derived fallback.
- `normalizePermissions` (`:49-58`). Defaults `{spawnAgents:false, patchRuntime:false, accessAllChannels:false}`.
- `class AgentRegistry` (`:60-295`; singleton `:297`).
  - `list(filters)` (`:61-66`). Delegates to `getCachedRoster("roster:"+JSON(filters), loadRoster)` — cache key is the serialized filter object.
  - `loadRoster(filters)` (`:68-101`). Guards `isNull(agents.archivedAt)`; optional `authorityLevel/status/isTemplate`; `limit` clamped 1–200 default 200; `cursor` = numeric offset; ordered `asc(authorityLevel), asc(name)`.
  - `getById(id)` (`:103-110`). No archived guard (single fetch can return archived).
  - `create(input)` (`:112-159`). Validates refs; `randomUUID()` id; inserts row with `status ?? "offline"`, `isTemplate ?? false`; inserts `runtimeStates` row; re-reads; `invalidateRosterCache()`.
  - `update(id, input)` (`:161-233`). Loads existing; builds merged input handling `null`-clears; revalidates; updates; `skillsGate.invalidateAgentCaches(id)` on toolkit/permissions change (`:218-220`); updates `runtimeStates`; `invalidateRosterCache()`; returns `getById`.
  - `delete(id)` (`:235-240`). Hard delete + invalidate. Note: spawn path uses archive (`archivedAt/archivedReason`), not this hard delete.
  - `ensureValidReferences(input, currentAgentId?)` (`:242-294`): `l3Subtype` only if `authorityLevel===3`; `fallbackAgentId !== currentAgentId`; parallel existence checks (model/instruction required; toolkit/constraints/capabilities/fallback optional); throws `... not found` strings.
- Types `agentTypes.ts` (`AgentProfile`, `CreateAgentProfileInput`, `UpdateAgentProfileInput`, `AgentRegistryFilters`); validators `agentValidators.ts` (create/update/list/params schemas); gate `agentGate.ts:50-58` (must stay identical).

#### Modules — `Modules/moduleService.ts` (all 5 tables)

- `findReferencingAgent(moduleType, moduleId)` (`:31-46`). One lookup per type. Used as pre-delete guard by routes.
- `testConnectionHelper(provider, modelName, apiKey?, endpointUrl?)` (`:48-170`); offline/timeout → `{success:true, Offline Mode Active}`.
- `listAllModules()` (`:173-190`). Parallel selects ×5.
- Model modules (`:193-232`): list/get/create (`randomUUID`, `apiKey: encrypt or null`, `enableCompression ?? true`)/update (re-encrypts, `runtimeGate.invalidateModelModuleCache`)/delete/test (decrypts before test).
- Instruction (`:235-262`), Toolkit (`:265-295`, + `skillsGate.invalidateAgentCaches()`), Constraints (`:298-325`), Capabilities (`:328-355`). No other invalidations.
- Types `moduleTypes.ts`, validators `moduleValidators.ts` (all update schemas `.partial()`), gate `moduleGate.ts:139-179` (must stay identical).

#### Skills — `Skills/skillService.ts`

- Caches (`:29-30`): `agentSkillsCache` + `resolvedToolsCache`, each `TtlCache(30_000, 500)`.
- `invalidateAgentCaches(agentId?)` (`:32-40`): single-id `delete` vs full `clear`.
- `list` / `getById` / `create` (id `skill_<8hex>`) / `update` / `delete` (`:42-123`), all self-invalidating.
- `getAgentSkills(agentId)` (`:125-146`): cache → `agentSkills where agentId+isEnabled` → `inArray(skills.id)` → cache.
- `assignSkill` (upsert `isEnabled:true`) / `removeSkill` (`:148-169`) + invalidate.
- `getResolvedToolsForAgent(agentId)` (`:171-207`): toolkit `tools` + agent-skill `requiredToolIds` + universal memory tools + universal context tools → cache.
- Gate `Skills/skillsGate.ts:28-39` (must stay identical); types `skillTypes.ts`.

### 2.2 Cache + invalidation chains

| Cache | File:line | TTL / cap | Invalidated by |
|---|---|---|---|
| Roster `TtlCache<Promise<AgentProfile[]>>` | `Agents/agentRosterCache.ts:15-18` (30 s / 50 keys; single-flight; loader failure evicts; disabled under `VITEST` unless opted in) | `AgentRegistry.list` | `create`, `update`, `delete` via `invalidateRosterCache()` |
| Skill `agentSkillsCache` + `resolvedToolsCache` | `Skills/skillService.ts:29-30` (30 s / 500 each) | `getAgentSkills`, `getResolvedToolsForAgent` | 5 self-invalidations + 3 cross-domain (`agentService.update`, `moduleService` toolkit ×3, `studio PUT manifest`) |
| Model-module cache | `runtime/kernel/ContextPipelineManager.ts:24` (30 s / 200) | pipeline assemble on miss | `moduleService.update/deleteModelModule` → `runtimeGate.invalidateModelModuleCache` + `studio PUT` full clear |
| Routing cache | `Shared/core/modelRouting.ts:157` (30 s / 1 key) | `loadRoutingModules()` | TTL expiry only. Preserve or replace with file-mtime check. |
| Cost cache | `Shared/core/tokenTracker.ts:22` (30 s / 200) | `computeCostUsd` | TTL expiry only. |

### 2.3 FK rules in schema + `ensureValidReferences`

Drizzle schema `db/schema.ts`:

- `modelModules :72-89`, `instructionModules :91-98`, `toolkitModules :100-106`, `constraintsModules :108-115`, `capabilitiesModules :117-124`.
- `agents :209-235`: `modelModuleId NOT NULL → CASCADE` (`:217`); `instructionModuleId NOT NULL → CASCADE` (`:218`); `toolkit/constraints/capabilities → SET NULL` (`:219-221`); `fallbackAgentId → SET NULL` (`:224`); `agents_name_idx UNIQUE(name)` (`:233-234`).
- Relations (`:564-583`, `:607-644`); `skills :838-858`, `agentSkills :860-866` (pk + dual CASCADE), `agentInstructionStacks :883-891`, `workspaceAgents :502-509`, `mcpServers :868-881`.

Cascade/set-null semantics to replicate:
- Deleting a **model/instruction** module today cascades to agents. Spec decision: **block** instead (safer for files) — require `findReferencingAgent` non-null → throw `409`. Rationale in §7.1; routes already have the hook point.
- Deleting **toolkit/constraints/capabilities** today nulls the agent FK. Replicate by nulling the field in `agents/<id>.json` on delete.
- Deleting an **agent** today cascades to `agent_skills, agent_tools, agent_instruction_stacks, runtimeStates, workspace_agents, tokenUsageLog`. Replicate by deleting join rows in JSON (`agent_skills.json`, stacks file) and removing the id from every `sandbox/*/roster.json`. Leave ledger/analytics rows with dangling `agentId` (append-only).
- Deleting a **skill** cascades to `agent_skills`. Replicate by pruning `agent_skills.json`.

### 2.4 Seed idempotency

`db/seed.ts:20-327` — every block is find-first-then-insert: Default Gemini model, Default + Librarian instruction modules, Default toolkit (`tools:[]`), `default-assistant` (L1), `Librarian` (fixed id `agent-librarian`, L2, omniscient), workspace `default`, `workspaceSettings default`, `#general` + categories/channels, roster mounts (`mountAgent("default-assistant")`, `mountAgent("Librarian")`).

Idempotency key = label/name. JSON seed must keep the same keys (§3.8).

### 2.5 Secret handling

- `Shared/core/secretBox.ts`: `ENVELOPE_PREFIX=enc:v1:`, `aes-256-gcm`; key from `CREDENTIALS_ENCRYPTION_KEY` (hex64 / b64-32 / scrypt-passphrase, cached); `encrypt` (no-key → warn-once + plaintext passthrough); `decrypt` (plaintext passthrough + warn, no-key envelope passthrough, malformed/wrong-key throws); record helpers.
- `Modules/moduleService.ts:205` create encrypts `apiKey`; `:214` update re-encrypts; `:231` decrypts before test. `ContextPipelineManager.ts:100-113`: env override wins, else `decrypt(row.apiKey)` — decrypt only here. `librarianRuntime.ts:261-266`, `mcpClientManager.ts:77-79` same pattern.
- `db/backfill-encrypt-secrets.ts`: dry-run default, `--apply` writes; covers `model_modules`, three profile tables, `mcp_servers.env_vars`; redacted logging.
- Studio redaction: `routes/studio.ts:42,211`.

JSON must store the **envelope string verbatim** (never plaintext) and keep decrypt-at-last-moment. No new crypto.

### 2.6 MCP `envVars` note

`mcp_servers.env_vars` stays in Postgres. Listed only because the backfill script and `secretBox` record helpers are reused. Do **not** migrate `mcp_servers` to JSON in this spec. File replacement covers `modelModules.apiKey` only.

### 2.7 Every reader group (verified sites)

**A. Roster / agent catalog (5):** `mentionParser.ts:43` (`AgentRegistry.list` per parse, hot path); `registerSocketServer.ts:175-193` + `:687` (mount check + scoped filter); `agentMemoryStore.ts:162-192` `resolveAgentId` + `:212-220` existence; `agentErrors.ts:116-119` escalation target lookup; `MemoryBuilder.ts:247-296` (L1/L2/L3 lookups).

**B. Modules (7):** `MemoryBuilder.ts:50-78` (+ params `:212-216`); `ContextPipelineManager.ts:91-139`; `modelRouting.ts:159-184`; `tokenTracker.ts:174-192`; `costLedger.ts:89-134,247,286-289`; `librarianRuntime.ts:248-259`; `InstructionStackMiddleware.ts:23-53` (+ override sweep `:112-118`); `ConstraintSafetyMiddleware.ts:21-31`.

**C. Skills / tools authz (4):** `skillService.ts:179-185`; `ToolExecutor.ts:153-168`; `ToolSchemaMiddleware.ts:24`; `SkillContextMiddleware.ts:10`.

**D. Workspace roster mounts (4):** `workspaceManager.ts:184-240` (mount/unmount/sessions); `workspaceContext.ts:81-86` `getMountedAgentIds`; `agentSpawnManager.ts` (fallback templates, pair inserts, ephemeral mounts, archive patch); `RuntimeKernel.ts:247-288` (`setAgentStatus` + mounts fan-out) and `persistMessage` channel→workspace lookup.

**E. Ops / jobs (4):** `agentHeartbeat.ts` (touch + orphan sweep + mounts fan-out); `indexBuilder.ts:75-77` (librarian lookup); `librarianRuntime.ts:97,179` (status flips); `toolRegistry.ts:703-794` (`dispatch_agent`).

**F. HTTP / studio / diagnostics (5):** `routes/studio.ts` (manifest GET/PUT, inspect-prompt — direct DB reads); `routes/agents.ts` (gate-only, safe); `routes/modules.ts`, `routes/skills.ts`, `routes/providers.ts`, `routes/runs.ts` (gate-only, safe); `db/check.ts` roundtrip inserts; `backfill-encrypt-secrets.ts`.

**G. Tests that pin current behavior:** `agentRosterCache.test.ts` (TTL hit, invalidation, archived-guard); `spawnArchive.test.ts` (archive lifecycle, retention, librarian honesty, delta indexing). No dedicated `moduleService`/`skillService` unit suite exists (gap → new tests in §6.3).

---

## 3. Target Design

### 3.1 File layout (exact paths)

All paths relative to `packages/server/`. Root overridable via `CATALOG_DIR` (default `packages/server/data/catalog`). Workspace rosters live **inside the workspace root** so `rm -rf sandbox/<ws>` removes its roster.

```
data/catalog/
  schema-version.json            # { "version": 1 }
  agents/
    <agentId>.json               # one file per agent (NOT bundled)
    .tmp.<agentId>.<pid>.<rand>.json   # write-tmp only, never committed
  modules/
    model/<moduleId>.json        # one file per module
    instruction/<moduleId>.json
    toolkit/<moduleId>.json
    constraints/<moduleId>.json
    capabilities/<moduleId>.json
  skills/
    skills.json                  # bundled map {id: SkillDefinition} — skills are small & few
    agent-skills.json            # bundled links: Array<{agentId, skillId, isEnabled}>
  stacks/
    agent-instruction-stacks.json  # bundled: Array<{id, agentId, instructionModuleId, priorityOrder, isEnabled}>
  export/
    pg-dump-catalog-YYYYMMDD-HHmm.sql  # pre-flip dump (§7.2), read-only

sandbox/<workspaceId>/
  roster.json                    # per-workspace roster, REPLACES workspace_agents rows
```

Why this split:

- **One file per agent/module:** matches access pattern (point `getById` + filtered `list`); avoids write-amplification and merge conflicts of a single `agents.json`; keeps `findReferencingAgent` a directory scan bounded by module count. Bundling agents would reintroduce the torn-write window for the hottest entity.
- **Bundled skills/links/stacks:** low count, tiny join rows, studio-only; bundling keeps file count sane and matches today's full-scan reads. If skills grow >1k, split to `skills/<id>.json` without gate change.
- **Roster per workspace file:** `sandbox/<ws>/roster.json` shape `{ workspaceId, updatedAt, mounts: Array<{id, workspaceId, agentId, scope, permissions, createdAt}> }` mirroring `WorkspaceAgentSession`. `getMountedAgentIds` becomes `read roster.json → map(agentId)`.

Catalog root resolution order: `CATALOG_DIR` env → `packages/server/data/catalog`. Workspace root resolution stays `WORKSPACE_DIR`.

### 3.2 JSON schemas (all dates ISO-8601 strings; parsed to `Date` on load)

`schema-version.json`:
```json
{ "version": 1, "minReaderVersion": 1 }
```
Startup refuses to boot if `version > minReaderVersion` the code understands (fail-fast, same philosophy as `CONFIG_STRICT` strict boot).

`agents/<id>.json` = `AgentProfile` + file envelope: `id, name, title, species?, avatar?, authorityLevel, l3Subtype?, module ids, memorySharingPolicy, isOmniscient, fallbackAgentId?, categoryPermissions[], permissions{}, status, isTemplate, contextTokenCap?, archivedAt?, archivedReason?, createdAt, updatedAt`. Notes: `archivedAt/archivedReason` are new vs `agentTypes.ts` (today only DB columns) — required for the spawn-archive lifecycle. Nullable fields use `null` on disk, mapped to `undefined` by the loader (same as `mapAgentProfile`).

`modules/model/<id>.json`: `id, label, provider, modelName, apiKey (enc:v1:...|null), endpointUrl?, temperature, topP, maxOutputTokens, stopSequences[], maxRecentMessages, enableCompression, compressionThreshold, costPer1k?, createdAt, updatedAt`. `apiKey` stores the **envelope verbatim** (see §3.7). Other module files mirror `moduleTypes.ts` + timestamps.

`skills/skills.json`: `{ "<skillId>": SkillDefinition }`. `skills/agent-skills.json`: `[{agentId, skillId, isEnabled}]`. `stacks/agent-instruction-stacks.json`: `[{id, agentId, instructionModuleId, priorityOrder, isEnabled}]`. `sandbox/<ws>/roster.json`: `{ workspaceId, updatedAt, mounts: [WorkspaceAgentSession...] }`.

Validation: keep existing zod schemas (`agentValidators.ts`, `moduleValidators.ts`, `skillValidators.ts`) as the file validators on write. Add a `catalogSchemaVersion` integer-compare guard.

### 3.3 Atomic write protocol (write-tmp + rename)

Every mutation (agent/module/skill/link/stack/roster) does:

1. Serialize with `JSON.stringify(value, null, 2)`.
2. `writeFile(tmpPath, data, "utf8")` where `tmpPath = <dir>/.tmp.<base>.<pid>.<random6>.json`, mode `0o600` when the payload may contain `apiKey` (model modules).
3. `fsync` the tmp file descriptor.
4. Validate: re-`readFile` + `JSON.parse` + zod parse. On failure, `unlink(tmp)` and throw (never rename corrupt data over good).
5. `rename(tmpPath, finalPath)` — atomic on POSIX and on Win32 for same-volume renames. Readers never see a half-written file.
6. `fsync` the containing directory (durability of the rename on crash).
7. Bump in-memory version / clear the relevant `TtlCache` key (see §3.5). Keep the existing `invalidate*` function names as shims so call sites don't change.

Bundled files follow the same protocol but serialize the whole bundle. Roster writes are per-workspace so two workspaces never contend on the same file.

Startup load: read `schema-version.json` → read all `agents/*.json` + `modules/*/*.json` + skills bundles + stacks → build in-memory indexes (by id, by name, by module-id reverse index) → validate references. On corrupt file: quarantine to `<file>.corrupt.<timestamp>.json`, log, continue if `CATALOG_STRICT=false`; refuse boot if `CATALOG_STRICT=true` (default, mirrors `CONFIG_STRICT`). Missing files = empty catalog (fresh boot → seed runs, §3.8).

### 3.4 Concurrency control — RECOMMENDATION: single-writer in-process mutex (no lockfile by default)

**Recommended: single-writer with an async mutex + atomic rename. No lockfile.**

- All catalog mutations funnel through one `CatalogStore` per domain (`AgentFileStore`, `ModuleFileStore`, `SkillFileStore`, `RosterFileStore`) each holding a per-file (or per-bundle) promise-chain mutex. Concurrent `update()` calls to the same agent serialize; concurrent updates to different agents run in parallel.
- `rename(2)` atomicity + re-read validation makes torn writes impossible for readers.
- Rationale: the server is a single Node process (BullMQ workers do not write the catalog). A lockfile adds a new failure mode for a problem we don't have. Cross-process catalog writers are explicitly unsupported in v1: second process fails fast on boot with `CatalogLockedError` unless `CATALOG_MULTI_WRITER=true` (not implemented — throws with a link to this spec).
- Upgrade path (comment in code): `// ponytail: single-process mutex; add fcntl/proper-lockfile only if multi-writer deploy appears`.
- Roster `mountAgent` maxAgents check becomes read-modify-write under the roster mutex — same race window as today's non-transactional check, no worse.

Alternative rejected: OS lockfile on every write (slower, stale-lock risk, harder to test hermetically).

### 3.5 Cache / invalidation replacement

Keep all `TtlCache` instances and all `invalidate*` signatures; change what they cache and what invalidation does:

| Today | After flip |
|---|---|
| `getCachedRoster(key, () => loadRoster DB)` | Same function, loader reads the in-memory agent index (built at startup, updated on every file write). TTL 30 s + 50 keys unchanged. `invalidateRosterCache()` still `clear()`s. No call-site change. |
| `SkillService` two caches | Unchanged TTL/cap. Loaders read `skills.json` index + `agent-skills.json`. All invalidations keep calling `invalidateAgentCaches([id])`. |
| `modelModuleCache` | Unchanged. Loader reads `modules/model/<id>.json` via index. `runtimeGate.invalidateModelModuleCache(id?)` still `delete/clear`. |
| `routingCache` + `costPer1kCache` | Keep TTL. Loader reads module index. Add opportunistic file-mtime check: if `catalogVersion !== cachedVersion`, drop cache. No new env flags. |
| `studio PUT` dual invalidation | Unchanged calls; they now drop file-derived caches. |

No invalidation call site is deleted — they become cheap cache drops, preserving the "blast radius stops at the gate" property.

### 3.6 Reference-integrity replacement for FKs

New `validateCatalogReferences()` (in `Agents/` + `Modules/` internals, called on every write and at startup):

- `create/update agent`: exact port of `ensureValidReferences` but against the file index: required `modelModuleId` + `instructionModuleId` exist; optional toolkit/constraints/capabilities exist if set; `fallbackAgentId` exists + ≠ self; `l3Subtype` ⇒ L3; `name` unique (replaces `agents_name_idx`) case-sensitive (today's DB unique is case-sensitive; keep it — `resolveAgentId` already handles fuzzy matching at read time).
- `delete module`:
  - model/instruction: `findReferencingAgent` non-null → throw `409 ModuleInUseError` (behavior change from CASCADE; safer for files, and routes already have the hook point).
  - toolkit/constraints/capabilities: null out the field in every referencing `agents/<id>.json` (mirrors `ON DELETE SET NULL`), bump `updatedAt`, invalidate roster + skill caches.
- `delete agent`: remove `agents/<id>.json`; prune `agent-skills.json` entries; prune stacks entries; remove id from every `sandbox/*/roster.json` (replaces FK CASCADE); leave ledger/analytics rows with dangling `agentId` (append-only).
- `delete skill`: prune `agent-skills.json` (mirrors CASCADE).
- `mountAgent`: verify `agents/<agentId>.json` exists + workspace `ACTIVE` + maxAgents + dup (same errors as today); append to `roster.json` under roster mutex.
- `assignSkill/removeSkill/studio PUT skills/stacks`: verify both sides exist before writing (today the DB FK would throw; now throw `NotFoundError` with the same message shape).

### 3.7 Secret encryption at rest replacement

- No new crypto. `secretBox.encrypt/decrypt/isEncrypted` used identically; `CREDENTIALS_ENCRYPTION_KEY` env unchanged.
- `modules/model/<id>.json:apiKey` stores the envelope (`enc:v1:...`) or `null`. Write path always `encrypt()`s (idempotent passthrough); read path returns envelope; decrypt happens only at `ContextPipelineManager`, `testModelModule`, `librarianRuntime` — unchanged call sites.
- File permissions: model-module files + any tmp file containing `apiKey` written `0o600`. Warn on boot if key unset + emit a `startup.secrets.plaintext` metric when any model file holds a non-envelope key.
- Migration: one-shot `scripts/migrate-catalog-secrets.ts` (file analogue of `backfill-encrypt-secrets.ts`): scans `modules/model/*.json`, `--dry-run` default, `--apply` encrypts + atomic rewrites. `mcp_servers.env_vars` keeps using the DB backfill; not touched.
- Studio redaction unchanged.

### 3.8 Delete-table migration

Order: **export → dual-write/dark-read (optional) → flip → drop**. Tables dropped (10):

```
agents, model_modules, instruction_modules, toolkit_modules,
constraints_modules, capabilities_modules, skills, agent_skills,
agent_instruction_stacks, workspace_agents
```

Kept: `mcp_servers`, all legacy `*_model_profiles`, everything in §1.2.

Migration steps (forward-only drizzle SQL, e.g. `0012_drop_catalog_tables.sql`):

1. Pre-flip export (runbook, §7.2): `pg_dump` the 10 tables → `data/catalog/export/` + `scripts/export-catalog-to-json.ts` (DB→JSON, idempotent, envelope-preserving: copies `api_key` strings verbatim without decrypting).
2. Seed-to-file: `scripts/seed-catalog-files.ts` replicates `db/seed.ts` against files (same labels/names/ids where fixed: `agent-librarian`, workspace `default`). Idempotent on the same keys (skip-if-exists by label/name, not row count).
3. Flip deploy: `CATALOG_BACKEND=json` (new flag, default `db` until flip, then default `json`; see §8). All gate internals branch on it; readers behind gates see no change.
4. Bake window (1 release): monitor `catalog.*` metrics; keep the DB tables but stop writing them.
5. Drop migration: `DROP TABLE IF EXISTS ... CASCADE` + remove drizzle relations from `schema.ts` + delete `bootstrap.ts` DDL for them. Keep `mcp_servers` DDL.

Rollback before step 5 = flip flag back (DB still has pre-flip data + export). After step 5 = restore from `export/*.sql` (see §7.2).

---

## 4. Expected Files Touched

### 4.1 Stores (the flip — 8 files)

- `Agents/agentService.ts` — replace `getDb()` + table queries with `AgentFileStore` (index + atomic writes + `ensureValidReferences`-on-files). Keep class/method names + `agentRegistry` singleton.
- `Agents/agentRosterCache.ts` — keep API; loader source becomes memory index. No signature change.
- `Modules/moduleService.ts` — replace all selects/inserts/updates/deletes with `ModuleFileStore` ×5. Keep `encrypt/decrypt` and invalidation calls.
- `Skills/skillService.ts` — replace table queries with `SkillFileStore` (two bundled JSONs + index). Keep caches + invalidation semantics.
- `Workspace/workspaceManager.ts` — `mountAgent/unmountAgent/getAgentSessions` → `RosterFileStore` (`sandbox/<ws>/roster.json`).
- `Workspace/workspaceContext.ts` — `getMountedAgentIds` → roster-file read.
- `Agents/agentSpawnManager.ts` — fallback templates, pair inserts, roster mounts, archive patch → file-store calls + roster-file appends. `dispatchAgent` signature unchanged.
- New (private to domains): `Agents/agentFileStore.ts`, `Modules/moduleFileStore.ts`, `Skills/skillFileStore.ts`, `Workspace/rosterFileStore.ts`, `Shared/core/catalogFs.ts` (atomic write + mutex + version), `Shared/core/catalogErrors.ts`. New `scripts/export-catalog-to-json.ts`, `scripts/seed-catalog-files.ts`, `scripts/migrate-catalog-secrets.ts`.

### 4.2 Readers (migrate behind gates FIRST — no logic change, only source swap; ~20 files)

- `core/MemoryBuilder.ts` → `agentGate`/`moduleGate` reads (remove direct table imports).
- `Memories/agentMemoryStore.ts` → `agentGate.getById/list` (remove `agents` import).
- `Shared/core/modelRouting.ts` → `moduleGate.model.list` projection (remove `modelModules` + raw `sql hasApiKey` → in-memory check).
- `Shared/core/tokenTracker.ts` → module-index `costPer1k` lookup.
- `Observability/costLedger.ts` → module-index meta (remove join).
- `Shared/core/librarianRuntime.ts` → `moduleGate.model.get` + `agentGate` status flips.
- `Shared/core/indexBuilder.ts` → `agentGate.getById("agent-librarian")`.
- `Shared/core/agentHeartbeat.ts` — status + mounts fan-out go through gates; `runtimeStates` stays DB.
- `Agents/agentErrors.ts` → `agentGate`-compatible status/message writes.
- `runtime/kernel/ContextPipelineManager.ts` → module-index fetch; keep decrypt + cache.
- `runtime/kernel/RuntimeKernel.ts` → `workspaceGate.getMountedAgentIds`; `agents.status` via gate-compatible path (decision: **move it**; file is source of truth).
- `InstructionStackMiddleware.ts` → stack port (new `moduleGate.instructionStack.*` or via `skillsGate`).
- `ConstraintSafetyMiddleware.ts` → `moduleGate.constraints.get`.
- `ToolSchemaMiddleware.ts` + `SkillContextMiddleware.ts` — no change (already gate-only; verify).
- `mentionParser.ts` — no change (already `AgentRegistry.list`).
- `tools/ToolExecutor.ts` → `agentGate.getById` + existing `skillsGate`.
- `tools/toolRegistry.ts` (`dispatch_agent`) → `agentGate` fallbacks; `query_database` allowlist: serve `agents` from the JSON index via the same read-only guard, never expose `apiKey` (project it out).
- `routes/studio.ts` → gate-only (remove all direct table reads).
- `Shared/sockets/registerSocketServer.ts` → `workspaceGate.getMountedAgentIds` + `agentGate.list`.

### 4.3 Seed / migrations / ops

- `db/seed.ts` → add file-seed twin (keep DB seed until drop; gate by `CATALOG_BACKEND`).
- `db/check.ts` → add `scripts/check-catalog-files.ts` twin (roundtrip against files).
- `db/backfill-encrypt-secrets.ts` → add `scripts/migrate-catalog-secrets.ts` (file twin for `modelModules.apiKey` only).
- `db/bootstrap.ts` → remove catalog DDL after drop.
- `db/schema.ts` → remove catalog tables/relations after drop.
- `db/migrations/0012_drop_catalog_tables.sql` (new) + `meta/_journal.json` entry.
- `Shared/config/env.ts` → add `CATALOG_DIR` (optional text), `CATALOG_BACKEND` (`db|json`, default `db` pre-flip), `CATALOG_STRICT` (bool default true). Register `CATALOG_` prefix.

### 4.4 Tests

- Keep + adapt: `agentRosterCache.test.ts`, `spawnArchive.test.ts`, `modelRouting.test.ts`, `secretBox.test.ts`, `tokenTracker.test.ts`, `contextPipeline.test.ts`, `contextAssembly.perf.test.ts`, `contextIntegrity.test.ts`, `toolExecutor.batch.test.ts`, `toolRegistry.honest.test.ts`, `registerSocketServer.test.ts`, `memories.test.ts`, `runtimeLifecycle.test.ts`, `MonologueE2E.test.ts`, `AgenticRuntime.test.ts`, `CodingRuntime.test.ts`.
- Rewrite fakes: `test-setup.ts` (`workspaceAgents` fake → roster-file fake); `spawnArchive.test.ts` table keys minus catalog tables + file-store hermetic fake; `agentRosterCache.test.ts` store → file index fake.
- New: `agentFileStore.concurrent.test.ts`, `catalogCorruption.test.ts`, `catalogReferences.test.ts` (§6.3).

---

## 5. Ordered Steps (gate shapes frozen throughout)

1. **Pin gates.** Add contract tests asserting `agentGate/moduleGate/skillsGate/workspaceGate/runtimeGate` export shapes (`Object.keys` snapshot). No behavior change. (Guards `AGENTS.md`.)
2. **Build file primitives (no callers).** `Shared/core/catalogFs.ts` (atomic write + per-file mutex + version), `catalogErrors.ts`, JSON schemas. Unit-test tmp+rename + mutex serialization in isolation.
3. **Export + seed twins (no flip).** `scripts/export-catalog-to-json.ts` (DB→files, envelope-preserving) + `scripts/seed-catalog-files.ts`. Run in CI against throwaway `CATALOG_DIR`; diff DB vs file reads.
4. **Migrate readers behind gates FIRST.** Convert §4.2 direct-DB reads to gate calls. Each PR must keep `CATALOG_BACKEND=db` green. This is the bulk of the diff and is safe to land incrementally.
5. **Implement file stores behind the same gates.** Gate bodies branch on `CATALOG_BACKEND`; default `db`. Add `catalog.*` metrics (read/write/error/corrupt counts).
6. **Dark-read + dual-compare (1 week).** `CATALOG_BACKEND=db` + `CATALOG_SHADOW=json`: every gate read also reads files, compares, logs mismatch (never serves files). Fix drift (usually seed-key or null-vs-undefined mismatches).
7. **Flip staging → prod.** `CATALOG_BACKEND=json`. Run `export` (§7.2) immediately before. Monitor roster-cache hit rate, `resolveTools` latency, `context.assemble` model-fetch path, librarian summarizer success.
8. **Drop tables.** Land `0012_drop_catalog_tables.sql` + `schema.ts`/`bootstrap.ts` cleanup + delete DB seed/check paths for catalog. Keep `export/*.sql` for one retention window (`RETENTION_DAYS`).

---

## 6. Verification

### 6.1 Existing suites (must stay green; adapt fakes, not assertions)

- `Agents/agentRosterCache.test.ts` — TTL hit, create/update/delete invalidation, archived-guard-through-cache. After flip the fake DB becomes a file-index fake; assertions unchanged.
- `Agents/spawnArchive.test.ts` — archive lifecycle, retention sweeper, librarian honesty, delta indexing. `archivedAt/archivedReason` now live in `agents/<id>.json`.
- Modules/skills: **no dedicated suite exists** — coverage comes via studio paths, middlewares, `toolExecutor.batch.test.ts`, `toolRegistry.honest.test.ts`, `contextPipeline.test.ts`, `modelRouting.test.ts`. Do not mistake their green for module-CRUD coverage (gap closed by §6.3).
- Studio: exercise GET/PUT manifest + inspect-prompt against file backend (add a `CATALOG_BACKEND=json` matrix job for: `studio`, `contextPipeline`, `contextAssembly.perf`, `modelRouting`, `secretBox`, `tokenTracker`, `registerSocketServer`, `memories`, `runtimeLifecycle`).

### 6.2 New tests (required for merge)

1. **Concurrent-write safety** (`agentFileStore.concurrent.test.ts`): 50 parallel `update()`s to one agent + 50 to distinct agents + parallel `mountAgent` ×10 against maxAgents; assert no lost updates, no torn JSON (`JSON.parse` always succeeds mid-storm), roster count correct.
2. **Corruption recovery** (`catalogCorruption.test.ts`): corrupt one `agents/<id>.json` (truncate), one `modules/model/<id>.json` (bad envelope), one `roster.json` (invalid JSON); assert: `CATALOG_STRICT=true` refuses boot with named file; `false` quarantines to `.corrupt.<ts>.json` and serves the rest; exporter re-creates the missing file on next seed.
3. **Reference validation** (`catalogReferences.test.ts`): create agent with bad module ids → throw; `l3Subtype` on L1 → throw; self-fallback → throw; duplicate `name` → throw; delete referenced model/instruction → `409`; delete toolkit → referencing agents nulled; delete agent → pruned from skills/stacks/every roster.

### 6.3 Acceptance checklist

- [ ] Gate-shape snapshot tests pass on both backends.
- [ ] Shadow-compare mismatch rate 0 for 7 days before flip.
- [ ] `export/*.sql` + JSON snapshot archived before flip (§7.2).
- [ ] Studio manifest roundtrip identical on both backends (modulo `createdAt` precision).
- [ ] Librarian index + delta-index perf fixture green on files.
- [ ] No `getDb().query.{agents,modelModules,instructionModules,toolkitModules,constraintsModules,capabilitiesModules,skills,agentSkills,agentInstructionStacks,workspaceAgents}` remains outside `scripts/export*` (grep gate).

---

## 7. Risks & Rollback

| Risk | Why | Mitigation |
|---|---|---|
| **Data loss on flip** | Files are new source of truth; a bad export drops agents/modules | §7.2 export (SQL dump + JSON snapshot) immediately before flip; flip is flag-gated; drop migration is a separate release |
| **Torn writes / partial bundles** | Crash mid-`skills.json` rewrite | Write-tmp+rename + re-read validation (§3.3); bundled writes hold the bundle mutex |
| **Plaintext secrets at rest** | JSON is easier to `cat` than Postgres | Keep envelopes (§3.7); `0o600` on model files; boot warns + metric on plaintext; `migrate-catalog-secrets --apply` parity with DB backfill |
| **Lost FK guarantees** | No CASCADE/SET NULL, no unique index | Application checks + `409` on in-use delete (intentional behavior change from CASCADE — deleting a model no longer deletes agents; call out in release notes) |
| **Startup with missing/corrupt files** | Disk edited by hand, partial deploy | `schema-version.json` gate + quarantine + `CATALOG_STRICT` (default refuse-to-boot) |
| **`agents.status` split-brain** | Heartbeat/escalation/kernel flip `agents.status` at high frequency — files add write contention | Status writes go through the agent mutex; roster `list` serves from cache (30 s) so read amplification is bounded; if write rate proves hot, move `status` to `runtimeStates` (DB) in a follow-up — do not reintroduce a second source of truth in v1 |
| **Roster maxAgents race** | Check-then-insert across processes | Single-writer mutex; cross-process mounts unsupported in v1 (fail fast) |
| **Unique-name drift** | `agents_name_idx` was DB-enforced | File store enforces on write + startup scan; shadow-compare catches pre-existing dupes before flip |

### 7.2 Rollback

- **Before drop (flag flip back):** set `CATALOG_BACKEND=db`. DB tables were untouched during bake (writes stopped but data intact) + `export/pg-dump-catalog-*.sql` restores any gap. Procedure: flip flag → restart → verify `agentRosterCache` + `spawnArchive` suites → delete stray JSON (or keep for forensics).
- **After drop:** restore `export/pg-dump-catalog-*.sql` (`pg_restore`), redeploy pre-drop build, set `CATALOG_BACKEND=db`. JSON files remain as the re-export source if the DB restore is older than the file writes.
- **Export step (mandatory, blocks flip):** `pg_dump` the 10 tables → `data/catalog/export/` + `export-catalog-to-json.ts` snapshot + `sha256sum` manifest. CI fails the flip job if the manifest is missing.

---

## 8. Dependencies (other specs)

- **pgvector spec matrix:** `EMBEDDING_*` flags and `ensurePgVectorExtension` are untouched. `agentMemoryNotes.embedding` stays in Postgres. `MEM_RETRIEVAL_WINDOW` still bounds memory SQL, not catalog reads.
- **Config spec (`MODEL_*` / module flags):** `MODEL_ROUTE`, `DELTA_INDEX`, `CREDENTIALS_ENCRYPTION_KEY`, `QUERY_DATABASE_ENABLED` / `SYSTEM_SCHEDULER_ENABLED`, `TOOL_RWP*`, `PIPELINE_PARALLEL`, `STREAM_BATCH_MS` are **not** changed here. New vars `CATALOG_DIR / CATALOG_BACKEND / CATALOG_STRICT` must be registered in `env.ts` by the config-spec owner to avoid `CONFIG_STRICT` boot failure.
- **Runs/Queue specs:** `tokenUsageLog.modelModuleId` becomes a nullable file-id reference after the drop (ledger keeps the id string; joins become index lookups). `query_database` allowlist change needs tools-spec owner sign-off.
- **Workspace spec:** roster-file location (`sandbox/<ws>/roster.json`) must match the workspace-lifecycle owner (`deleteWorkspace rm -rf`); workspace `default` seed stays DB-backed.

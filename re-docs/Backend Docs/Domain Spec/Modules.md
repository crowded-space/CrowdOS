# Modules

## Purpose
Versioned configuration library for agent cognition: CRUD plus live connection testing for the five reusable module kinds (model, instruction, toolkit, constraints, capabilities) that agent profiles reference instead of embedding.

## Feature Scope
In-scope:
- Per-kind list/get/create/update/delete over the five module tables.
- Aggregated `listAll` across all five tables with a short TTL cache.
- Provider connection testing: stored-module test plus ad-hoc provider/model/key/endpoint test.
- API-key encryption at rest (encrypt on write, decrypt only for tests).
- Referencing-agent lookup used as a delete guard (scoped first-only at the route, unscoped plural inside the PG service branches).
- Local-store corruption guard: verify-before-mutate so a broken JSON file is never overwritten.
Non-goals (other domains):
- Agent identity CRUD and FK ownership → Agents (Agents owns the `agents.*_module_id` columns and validates references through `moduleGate.validateReferences`; it no longer reads module tables directly).
- Prompt assembly, model calls, token accounting → Runtime (invalidates/reads module data via its own cache).
- Skill resolution and toolkit caching → Skills (this domain only invalidates those caches on toolkit writes).
- Secret redaction on reads and HTTP status mapping → Routes (`redactSecrets`, 404/409/201 mapping in `routes/modules.ts`).
- Embedding provider profiles → Memories reads `embedding_model_profiles`, which this domain does not own or serve.

## Expect
- [Observed] `get*`/`update*` return `null` and `delete*` returns `[]` when the id is missing (routes map `[]` to 404) (`module-service.ts:512-585` and per-kind mirrors).
- [Observed] All update schemas are `.partial()` plus a `nonEmptyUpdate` refine — any non-empty subset of fields is accepted, an empty body is rejected (`module-validators.ts:22`, `:29`, `:35`, `:42`, `:49`).
- [Observed] `apiKey` is stored encrypted; reads return ciphertext and only `testModelModule` decrypts (`module-service.ts:498-505`, `:586-607`).
- [Observed] `ollama` and `custom` providers need no API key; all others fail fast without one (`module-service.ts:228`).
- [Observed] Timeout/abort/offline (`fetch failed`, `ENOTFOUND`, `ECONNREFUSED`) returns `{ success: false, offline: true, message: "Provider unreachable (offline)…" }` on both the stored-test and ad-hoc paths and never throws (2026-09-25 audit fix; `module-service.ts:260-268`, `module-service.ts:341-345`); unknown providers return `{ success: false, message: 'Unknown provider …' }` with no network call (`module-service.ts:334`).
- [Observed] List pagination clamps to limit 1–500 (default 500), offset ≥ 0 (default 0); `""`/null/undefined limit falls back to the default 500 while an explicit `0` clamps to 1 (`module-service.ts:414-424`; `module-local-mode.test.ts` "empty limit").
- [Observed] Only `listAll` is cached (10s TTL); every create/update/delete calls `clearListAllCache()` first, so mutations never serve stale pages (`module-service.ts:358`, `module-service.ts:519` and mirrors).
  2026-09-25 audit fix: `listAllModules` applies the same limit/offset clamps on the local tier as on PG (previously the local tier ignored pagination and returned every row, so the same query could return different page shapes depending on the effective tier).
- [Observed] Model writes invalidate the runtime model-module cache via `invalidateRuntimeModelCache()` — a dynamic `import("../runtime/runtime-gate.js")` calling the now no-arg `runtimeGate.invalidateModelModuleCache()` (whole-cache clear; static import would close the eval-time cycle `middlewares → module-gate → module-service → runtime-gate → context-pipeline-manager`) (`module-service.ts:92-99`, `:561/:569/:578/:583`); toolkit writes invalidate all agent skill caches (`module-service.ts` toolkit create/update/delete).
- [Observed] Scope agreement (2026-10-09): a row created under a named scope stays readable/updatable/testable/deletable when a later call arrives unscoped (unscoped get searches every workspace scope, unscoped deletes target the owner folder, model updates write back via localModelModuleOwnerScope); named sibling scopes stay isolated. Runtime reads model rows with moduleGate.model.get(id, ctx.workspaceId) (context-pipeline-manager.ts:99).
- [Inferred] `listAll` cache key includes the workspace scope, DB scope, and limit/offset (`${ws}:${dbScopeKey()}:all:${limit}:${offset}`), so different workspaces and pages never share an entry; only the PG tier is cached — the local tier returns before the cache lookup (`module-service.ts:468-473`).

## Flow
1. Read one: `get*Module(id, workspaceId?)` resolves the tier (`moduleTier` → `tierContextFor` + `resolveTier`) and selects by id on PG or the local file store, returning row or `null` (`module-service.ts:492-497` and mirrors at `:618`, `:682`, `:748`, `:812`).
2. Read many: per-kind `list*Modules({ limit, offset, workspaceId? })` clamp via `clampListOpts` (`module-service.ts:414-424`) then select (`module-service.ts:483-491` and mirrors); `listAllModules` clamps, then either slices the local store (uncached) or fans out 5 parallel PG selects cached 10s under a workspace+DB+page key (`module-service.ts:446-480`).
3. Create: `create*Module(body, workspaceId?)` clears the `listAll` cache first, mints a UUID, applies per-kind defaults (`stopSequences []`, `enableCompression true`, `base []`, `runtimePatchable false`, `tools/rules/disallowedActions/skills/functionSchemas []`), encrypts model `apiKey`, and returns the row (`module-service.ts:498-518` and mirrors); toolkit creates invalidate agent skill caches.
4. Update: `update*Module(id, body, workspaceId?)` clears the `listAll` cache first, sets fields plus `updatedAt`, returning row or `null` (`module-service.ts:539-571` and mirrors). Model updates additionally apply the redacted-sentinel guard — a PUT-back of `"[REDACTED]"` or a `•`/`*` mask of length ≥ 4 is dropped (keep existing key) instead of being encrypted as the new key; `null` clears explicitly; any other string is encrypted (`module-service.ts:522-529`); both tiers then invalidate the runtime model cache. Toolkit updates invalidate agent skill caches.
5. Delete guard — two layers (2026-09-25/26 audit):
   - Route layer: `findReferencingAgent(kind, id, workspaceIdFrom(request))` — tier-aware (roster union via `agentRegistry.list`, so Local mode works instead of throwing on `getDb()`), first-only, tenant-scoped → 409 naming one agent before the delete (`module-service.ts:114-130`, `routes/modules.ts:144-152` and mirrors).
   - Service layer (PG branches only): `assertNoPgBlockers(kind, id)` runs an **unscoped** `findReferencingAgents` and throws `{ code: "MODULE_IN_USE", statusCode: 409 }` naming **every** blocker — a scoped route check alone let workspace A delete a module workspace B's agents still use (legacy shared rows carry no workspace). Local-tier rows live in per-workspace folders where the scoped route check suffices (`module-service.ts:140-155`, called at `:581/:668/:732/:798/:862`).
   - Deletes return rows, with `[]` mapped to 404 (`routes/modules.ts:153`); local-tier deletes return the full deleted row (2026-09-25).
6. Stored test: `testModelModule(id, workspaceId?)` loads the row (null → route 404), decrypts its key, and delegates to `testConnectionHelper` (`module-service.ts:566-585`, `routes/modules.ts`).
7. Ad-hoc test: `testConnectionHelper(provider, modelName, apiKey?, endpointUrl?)` pings google/openai/anthropic/ollama over 3s-timeout POSTs, maps HTTP errors to `{ success: false }`, maps timeout/abort/offline to `{ success: false, offline: true }` (2026-09-25 audit fix), and rejects unknown providers with `{ success: false }` and no network call (`module-service.ts:222-355`); also serves `POST /api/providers/test` (`routes/providers.ts`).
8. Route hygiene: reads redact secrets and support 304 (`routes/modules.ts`); every mutation emits `workspace:sync` via `globalBroker` (`routes/modules.ts` and mirrors).

## Current Implementation
- `modules/module-service.ts` → store owner (dual tier). Tier-aware CRUD: every read/write resolves the caller's workspace tier (`moduleTier`, `module-service.ts:65-78` — registry failure surfaces as 400 `INVALID_WORKSPACE`, connection errors rethrow) and serves the local file store when tier is `local`, PG otherwise. Exports `findReferencingAgents` (plural, roster fan-out through a dynamic `agent-gate` import), first-only `findReferencingAgent`, `validateModuleReferences` (local-store check when a scope is given, PG otherwise; all five FKs use `!= null` so `0` is not treated as a missing id), `testConnectionHelper`, `listAllModules`, `ensureDefaultModules` (local tier + scope only, instruction default only — zero model providers by contract), `DEFAULT_INSTRUCTION_MODULE_ID`, `clampListOpts`, `listAllCache` (TtlCache 10s, 200 keys, PG tier only, cleared by `clearListAllCache()` before all 15 mutations), `assertNoPgBlockers` (unscoped plural 409 for the 5 PG delete branches), `MODULE_LABELS`, `moduleTier`, `invalidateRuntimeModelCache()` (dynamic `runtime-gate` import, whole-cache clear — static import would close the eval-time middlewares cycle), and 5× (list/get/create/update/delete) + `testModelModule`; deterministic `orderBy(asc(<table>.id))` on every list; `serializeRow<T>` typed as mapped `SerializedRow<T>`.
- `modules/module-local-store.ts` → local file truth for the five catalogs when the workspace has no database (or is forced local): one JSON array file per kind under `<workspaceFolder>/vfs/.crowdos/{model,instruction,toolkit,constraints,capabilities}-modules.json`; rows serialized (ISO dates) and revived on read (invalid dates warn and coerce to epoch, `:62`); scoped by `x-workspace-id` threaded from routes; get-by-id reads: a named scope reads only its folder, an unscoped read searches every registered workspace via `searchableWorkspaceScopes` (registry ids, on-disk folders, default placeholder) because the id is the only key the caller has — mirrors the agent/channel/memory stores (`scopesFor`, `findInFile`); unscoped deletes remove the row from its owner folder; model updates write back via `localModelModuleOwnerScope` so no stranded second copy is left under the caller scope.
  Scope hygiene (2026-09-23): production upserts without a workspace scope throw instead of silently filing rows under the `default` folder; unscoped writes remain allowed under `VITEST` as the documented per-test fixture mechanism (`upsertScope`).
  Corruption guard (2026-09-26): every write path verifies the existing file first (`assertStoreWritable`, `:92-111`) — non-empty non-JSON or non-array content throws `{ code: "MODULE_STORE_CORRUPT", statusCode: 500 }` **before** any mutation, so a corrupt store is never overwritten; missing/empty files are created.
- `modules/module-types.ts` → shapes. `ModelModule` (provider/modelName/apiKey nullable/endpointUrl/temperature/topP/maxOutputTokens/stopSequences/maxRecentMessages/enableCompression/compressionThreshold/**costPer1k nullable**), `InstructionModule` (base/runtimePatchable), `ToolkitModule` (tools), `ConstraintsModule` (rules/disallowedActions), `CapabilitiesModule` (skills/functionSchemas), `ProviderEngine` (5), `ModuleType`, `ModuleUnion`.
- `modules/module-validators.ts` → zod. `providerEngineSchema` 5-value enum; `apiEndpointSchema`/`thinkingLevelSchema` 4/7-value enums (Great Group 23b); per-kind create schemas with optional-array defaults; `apiKey: z.string().min(1).nullable().optional()`; `maxOutputTokens` 1–1,000,000, `maxRecentMessages` 1–10,000; all update schemas `.partial()` (inherit bounds); `paramIdSchema`.
- `modules/module-gate.ts` → facade. Bare re-exports of every service port plus `moduleGate` object: `findReferencingAgent`, `findReferencingAgents`, `validateReferences`, `ensureDefaults`, and per-kind `{ list, get, create, update, remove }` namespaces (only `model` has `test`) — there is **no** `moduleGate.listAll`, `moduleGate.testConnection`, or `DEFAULT_MODEL_MODULE_ID` object entry (trimmed 2026-09-26; bare `listAllModules`/`testConnectionHelper` remain).

## Ports
- `ModelModule` — model module record type.
- `InstructionModule` — instruction module record type.
- `ToolkitModule` — toolkit module record type.
- `ConstraintsModule` — constraints module record type.
- `CapabilitiesModule` — capabilities module record type.
- `ProviderEngine` — `google | openai | anthropic | ollama | custom` type.
- `ApiEndpoint` — wire-protocol type: `google | anthropic | openai-completion | openai-responses` (unset = provider native). Honored at runtime only by the openai/custom providers choosing the OpenAI Responses wire protocol (see Runtime domain).
- `ThinkingLevel` — reasoning depth type: `none | minimal | low | medium | high | xhigh | max` (`none`/unset = provider default, no knob sent).
- `ModuleType` — `model | instruction | toolkit | constraints | capabilities` type.
- `ModuleUnion` — any module record type.
- `providerEngineSchema` — validator for provider engine.
- `apiEndpointSchema` — validator for the model module wire-protocol override (Great Group 23b).
- `thinkingLevelSchema` — validator for the model module reasoning depth.
- `modelModuleSchema` — validator for model module creation body.
- `updateModelModuleSchema` — validator for model module update body.
- `instructionModuleSchema` — validator for instruction module creation body.
- `updateInstructionModuleSchema` — validator for instruction module update body.
- `toolkitModuleSchema` — validator for toolkit module creation body.
- `updateToolkitModuleSchema` — validator for toolkit module update body.
- `constraintsModuleSchema` — validator for constraints module creation body.
- `updateConstraintsModuleSchema` — validator for constraints module update body.
- `capabilitiesModuleSchema` — validator for capabilities module creation body.
- `updateCapabilitiesModuleSchema` — validator for capabilities module update body.
- `paramIdSchema` — validator for id params.
- `CreateModelModuleBody` — model creation body type.
- `UpdateModelModuleBody` — model update body type.
- `CreateInstructionModuleBody` — instruction creation body type.
- `UpdateInstructionModuleBody` — instruction update body type.
- `CreateToolkitModuleBody` — toolkit creation body type.
- `UpdateToolkitModuleBody` — toolkit update body type.
- `CreateConstraintsModuleBody` — constraints creation body type.
- `UpdateConstraintsModuleBody` — constraints update body type.
- `CreateCapabilitiesModuleBody` — capabilities creation body type.
- `UpdateCapabilitiesModuleBody` — capabilities update body type.
- `ModuleParams` — id param type.
- `findReferencingAgent` — finds the first agent referencing a module (optional workspace scope narrows the roster searched; null/undefined keeps the legacy cross-workspace search). First-only shape kept for route compat only.
- `findReferencingAgents` — plural: **every** agent referencing a module, via `agentRegistry.list` fan-out (`module-service.ts:114-120`); preferred by new callers and by the PG delete guard.
- `validateModuleReferences` — single choke point for the five module FKs; throws on any missing id (Agents calls this via `moduleGate.validateReferences`, dynamic import).
- `DEFAULT_INSTRUCTION_MODULE_ID` — canon `"instr-default"` id (Agents seeds it on local-tier create).
- `ensureDefaultModules` — seeds the canon local-tier instruction default (`instr-default`) idempotently per workspace (also as `moduleGate.ensureDefaults`). No model default is seeded: fresh workspaces start with zero model providers (2026-09-26).
  2026-09-25 audit fix: a scope-less call is a documented no-op instead of throwing the store's module tenant-guard error (an unscoped local-mode agent create used to surface "workspaceId is required when creating a module" before the agent store's own, clearer refusal; the canon defaults are per-workspace rows, so with no scope there is nothing to seed).
- `testConnectionHelper` — tests a provider connection (bare export only; no `moduleGate.testConnection` object entry since 2026-09-26).
- `listAllModules` — lists all module kinds with workspace+page-keyed TTL cache, cleared before every mutation (bare export only; no `moduleGate.listAll` object entry since 2026-09-26).
- `listModelModules` — lists model modules.
- `getModelModule` — gets one model module by id.
- `createModelModule` — creates a model module.
- `updateModelModule` — updates a model module by id.
- `deleteModelModule` — deletes a model module by id.
- `testModelModule` — tests a stored model module connection.
- `listInstructionModules` — lists instruction modules.
- `getInstructionModule` — gets one instruction module by id.
- `createInstructionModule` — creates an instruction module.
- `updateInstructionModule` — updates an instruction module by id.
- `deleteInstructionModule` — deletes an instruction module by id.
- `listToolkitModules` — lists toolkit modules.
- `getToolkitModule` — gets one toolkit module by id.
- `createToolkitModule` — creates a toolkit module.
- `updateToolkitModule` — updates a toolkit module by id.
- `deleteToolkitModule` — deletes a toolkit module by id.
- `listConstraintsModules` — lists constraints modules.
- `getConstraintsModule` — gets one constraints module by id.
- `createConstraintsModule` — creates a constraints module.
- `updateConstraintsModule` — updates a constraints module by id.
- `deleteConstraintsModule` — deletes a constraints module by id.
- `listCapabilitiesModules` — lists capabilities modules.
- `getCapabilitiesModule` — gets one capabilities module by id.
- `createCapabilitiesModule` — creates a capabilities module.
- `updateCapabilitiesModule` — updates a capabilities module by id.
- `deleteCapabilitiesModule` — deletes a capabilities module by id.
- `moduleGate.findReferencingAgent` / `moduleGate.findReferencingAgents` — first-only and plural delete-guard lookups.
- `moduleGate.validateReferences` — validates the five module FKs, throws on missing (single choke point; Agents calls this, dynamic import).
- `moduleGate.ensureDefaults` — seeds the canon local-tier instruction default per workspace; never seeds a model provider (bare `ensureDefaultModules` too).
- `moduleGate.model.list` — lists model modules.
- `moduleGate.model.get` — gets one model module by id.
- `moduleGate.model.create` — creates a model module.
- `moduleGate.model.update` — updates a model module by id.
- `moduleGate.model.remove` — deletes a model module by id.
- `moduleGate.model.test` — tests a stored model module connection.
- `moduleGate.instruction.list` — lists instruction modules.
- `moduleGate.instruction.get` — gets one instruction module by id.
- `moduleGate.instruction.create` — creates an instruction module.
- `moduleGate.instruction.update` — updates an instruction module by id.
- `moduleGate.instruction.remove` — deletes an instruction module by id.
- `moduleGate.toolkit.list` — lists toolkit modules.
- `moduleGate.toolkit.get` — gets one toolkit module by id.
- `moduleGate.toolkit.create` — creates a toolkit module.
- `moduleGate.toolkit.update` — updates a toolkit module by id.
- `moduleGate.toolkit.remove` — deletes a toolkit module by id.
- `moduleGate.constraints.list` — lists constraints modules.
- `moduleGate.constraints.get` — gets one constraints module by id.
- `moduleGate.constraints.create` — creates a constraints module.
- `moduleGate.constraints.update` — updates a constraints module by id.
- `moduleGate.constraints.remove` — deletes a constraints module by id.
- `moduleGate.capabilities.list` — lists capabilities modules.
- `moduleGate.capabilities.get` — gets one capabilities module by id.
- `moduleGate.capabilities.create` — creates a capabilities module.
- `moduleGate.capabilities.update` — updates a capabilities module by id.
- `moduleGate.capabilities.remove` — deletes a capabilities module by id.

## Relations
Gates this domain calls:
- `runtime-gate.ts` — `runtimeGate.invalidateModelModuleCache()` (no-arg whole-cache clear) on model create/update/delete, reached through a **dynamic** `import()` inside `invalidateRuntimeModelCache()` — a static import closes the eval-time cycle `middlewares → module-gate → module-service → runtime-gate → context-pipeline-manager` (`module-service.ts:92-99`). The runtime port now supports per-id prefix invalidation across workspace cache keys, but this service still chooses whole-cache clearing.
- `skills-gate.ts` — `invalidateAgentCaches()` (global) on toolkit create/update/delete (static import; six call sites `module-service.ts:677-714`).
- `workspace-gate.ts` — `tierContextFor(workspaceId)` for `moduleTier` (static import).
- `agents/agent-gate.ts` — `agentRegistry.list` inside `findReferencingAgents` (dynamic import, cycle-safe).
- Non-gate internals used: `shared/config/database.ts` (`getDb`, `dbScopeKey`, `resolveTier`, `isConnectionError`), `shared/core/ttl-cache.ts` (`listAllCache`), `shared/core/google-model-helpers.ts` (`compileGoogleEndpoint`), `shared/core/secret-box.ts` (`encrypt`/`decrypt`), `db/schema.ts` (table defs).
Known outside callers (all gate-routed, 2026-09-26):
- Routes: `routes/modules.ts` (full CRUD + scoped first-only 409 pre-check + redaction + `workspace:sync` emits); `routes/providers.ts` (ad-hoc `testConnectionHelper` + `providerEngineSchema`); `routes/studio.ts` (manifest batch: `moduleGate.model/constraints/toolkit.get(id, agent.workspaceId)`).
- Agents: `agent-service.ts` — `moduleGate.validateReferences` (dynamic import) + `DEFAULT_INSTRUCTION_MODULE_ID` + `ensureDefaults` seeding (`:312-320`, `:717-718`).
- Runtime: `runtime/kernel/middlewares/constraint-safety-middleware.ts` (`moduleGate.constraints.get(id, ctx.workspaceId)`); `runtime/kernel/context-pipeline-manager.ts` (`moduleGate.instruction.get` stack joins — line 99 unscoped, see Gaps).
- `shared/core/librarian-runtime.ts` (`moduleGate.model.get(routedModuleId)` unscoped), `observability/cost-ledger.ts` (`moduleGate.model.list()` for dashboard meta). (`core/memory-builder.ts` model/instruction/toolkit reads deleted 2026-10-07 — dead legacy surface, zero importers.)
- Boundary note: Agents validates module references via `moduleGate.validateReferences`; the 409 guards here and the create/update validation there share this gate.
- Excluded direct reads (blocked, see Gaps): `skills/skill-service.ts`, `shared/core/model-routing.ts`, `shared/core/token-tracker.ts`, `runtime/kernel/middlewares/instruction-stack-middleware.ts` (fallback query).
Tables shared with other domains (FK readers, owned here):
- `agents.model_module_id/instruction_module_id/toolkit_module_id/constraints_module_id/capabilities_module_id` (Agents owns the FK columns; this domain never writes them).

## Emits-Listens
- None in-domain — `workspace:sync` on mutations is emitted by Routes (`routes/modules.ts`), not here.

## Owns
- `<workspaceFolder>/vfs/.crowdos/{model,instruction,toolkit,constraints,capabilities}-modules.json` (local tier truth; PG `model_modules`-family tables remain the dual-tier replica)
- `model_modules` (writes: insert, update, delete)
- `instruction_modules` (writes: insert, update, delete)
- `toolkit_modules` (writes: insert, update, delete)
- `constraints_modules` (writes: insert, update, delete)
- `capabilities_modules` (writes: insert, update, delete)

## Flags
- None — this domain reads no environment variables.

## Decisions
- [Observed] Local tier seeds the canon instruction default on first agent create — why: a fresh local workspace has an empty catalog, so the agent-creation form's built-in placeholder ("Default directives") referenced a row that never existed; Agents now seeds `instr-default` straight into this domain's local store (well-known id, idempotent) so "Launch Assembly" works offline (see Agents doc, `ensureLocalDefaultModules`). No model default is seeded (2026-09-26): fresh workspaces start with zero model providers; dangling model references clear to null.
- [Observed] Local tier stores module rows as JSON arrays in the workspace `.crowdos` folder instead of failing with LOCAL_MODE_DEGRADED — why: the local-mode guard previously hard-blocked module CRUD, so Model Modules settings were unusable on local-file workspaces; local truth parity with agents/channels lets module registration work offline and sync to PG later.
- [Observed] API keys encrypted before insert and decrypted only inside `testModelModule` — why: stored credentials must never leave the DB in plaintext, and only a live test justifies decryption (`module-service.ts:498-505`, `:586-607`).
- [Observed] Redaction happens at the route layer (`redactSecrets`), not in the service — why: the service returns full rows and trusts the boundary to scrub (`routes/modules.ts` reads); `redactSecrets` masks string values only under sensitive keys, so numeric model fields like `maxOutputTokens` are never masked. The update path additionally treats a PUT-back of the masked form (`[REDACTED]` or ≥4 `•`/`*`) as "keep existing" so a round-tripped placeholder can never be encrypted as the new key (`module-service.ts:522-529`).
- [Observed] `listAll` is TTL-cached 10s and every mutation clears the cache first — why: hot client polling dedupes the 5-table fan-out, and pre-write invalidation keeps post-mutation reads fresh without ~30 extra call sites; a failed mutation only costs one wasted re-fetch (`module-service.ts:358-365`).
- [Observed] Delete blocked by live reference (route 409 naming one agent + service-level unscoped plural 409 on the PG branches) instead of DB cascade — why: deleting cognition out from under an agent must be an explicit reassign-first flow, and legacy shared module rows have no workspace of their own so a scoped-only check let one tenant delete another's dependency (`module-service.ts:140-155`).
- [Observed] Offline/timeout connection tests fail with `{ success: false, offline: true }` — why: air-gapped and CI environments still get an explicit "shape validated, connectivity not confirmed" verdict instead of a false positive (`module-service.ts:260-268`, `:341-345`).
- [Observed] Cache invalidation fans out on write (whole runtime model cache via dynamic gate import, agent skill caches) — why: module edits must take effect without restart for the next execution, and the dynamic import is the only shape that avoids the middlewares eval-time cycle.
- [Observed] Unknown providers validate nothing and report `{ success: false }` — why: `custom` engines have no probe endpoint, so claiming success without a network call was a false positive (`module-service.ts:334`).
- [Observed] Unscoped local reads/deletes touch only the default folder — why: the old fan-out leaked cross-tenant rows into unscoped reads and could wipe same-id rows in workspaces the caller never named (`module-local-store.ts:74-83`, `:114-119`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Satisfied 2026-09-26: write invalidation on `listAll`, plural guard (`findReferencingAgents` + unscoped PG assert), Agents validation through the gate, `costPer1k` typing, offline/unknown failure verdicts, 200-key cache. Remaining: `ListModulesOpts` port, runtimePatchable enforcement, per-id cache invalidation.
Model apiKey is stored encrypted and decrypted only inside testModelModule. Plaintext key reads outside the live test path are forbidden.
Redaction stays at the route layer but MUST have a checklist: every read path redacts. Service returns full rows only under that boundary; the update path MUST keep treating PUT-back masks as "keep existing".
listAll 10s TTL MUST have write invalidation or a documented staleness contract. (Satisfied: cleared before every mutation.)
TtlCache capacity MUST match its key space. (Satisfied: 200 keys for workspace×DB×page keys.)
Delete guards MUST surface every blocker: the PG service path throws naming all agents; a first-only scoped route pre-check alone is forbidden as the sole guard.
Agents reference validation MUST go through moduleGate.validateReferences single choke point. Direct module-table reads from Agents are forbidden. (Satisfied for Agents; four other excluded readers remain — Gaps.)
costPer1k typing MUST match schema. (Satisfied: in `ModelModule`.)
ListModulesOpts MUST be a gate port or removed. Limit and offset typing without a ported contract is forbidden.
runtimePatchable MUST be enforced somewhere or labeled advisory. Stored-but-unenforced flags are forbidden as control semantics.
Offline, timeout, unknown-provider, and HTTP-error verdicts are always `{ success: false … }`; any success claim MUST mean a live connection succeeded.
## Failure + Resume
- Missing id: `get*/update*` → `null` (routes map to 404), `delete*` → `[]` (routes map empty to 404) (`module-service.ts` per-kind CRUD; `routes/modules.ts`).
- Missing key (non-ollama/custom) or HTTP error status → `{ success: false, message }`, never throws.
- Network timeout/abort/offline → `{ success: false, offline: true, message: "Provider unreachable (offline)…" }` — the caller sees a config-shape verdict, never a false live-success (`module-service.ts:260-268`, `:341-345`).
- Unknown provider → `{ success: false, message: 'Unknown provider …' }`, no network call (`module-service.ts:334`).
- Referenced-by-agent delete → route 409 naming one agent (scoped), then the PG service branch re-checks unscoped and throws 409 `MODULE_IN_USE` naming **every** blocker; operator resumes by reassigning/deleting the named agents first (`routes/modules.ts` deletes, `module-service.ts:147-155`).
- Corrupt local store on write → 500 `MODULE_STORE_CORRUPT` before any mutation; operator repairs or removes the JSON file, then retries (`module-local-store.ts:92-112`).
- Registry failure while resolving tier → connection errors rethrow (route 5xx); non-connection failures → 400 `INVALID_WORKSPACE` (branch currently near-unreachable, see Gaps) (`module-service.ts:65-78`).
- Stale reads: `listAll` is cleared before every mutation; the 10s TTL only backstops a failed mutation or cross-process write; the local tier is never cached.

## Gaps
- Excluded direct module-table readers (blocked, 2026-09-26 — probe-verified, converting them breaks tests outside the allowed list whose `vi.doMock` database mocks omit `isConnectionError`/`resolveTier`, and local-tier gate reads then miss the db fixtures the tests seed): `skills/skill-service.ts:241`, `shared/core/model-routing.ts:159-185`, `shared/core/token-tracker.ts:191-193` (its mock pins `resolveTier` to `tier: "local"` → file store would serve `[]` instead of the fixture rows), and the legacy fallback query in `runtime/kernel/middlewares/instruction-stack-middleware.ts` (`context-integrity.test.ts` asserts `toContain("BASE")` from its db fixture). Fix = extend those tests' mocks (`resolveTier` dual + `isConnectionError` + seeded rows), then convert.
- Exact per-id runtime model-cache invalidation: the runtime port supports prefix invalidation, but `invalidateRuntimeModelCache()` still clears the whole cache on every model mutation; passing the changed module id would narrow invalidation without changing the gate shape.
- `moduleTier`'s 400 `INVALID_WORKSPACE` is effectively unreachable: registry failures are swallowed at `workspace/workspace-registry.ts:289` (`.catch(() => null)` → benign `{workspaceId}` fallback) instead of rethrowing, so only an exotic non-connection error reaches the throw (`module-service.ts:65-78`).
- `workspace/workspace-database.ts:~521` seeds the instruction row through a per-workspace raw `db` with its own explicit id (`mod-inst-default`) — unfit for gate create (the Zod validator strips client-supplied ids), so it stays a direct writer; note only. No model row is seeded (zero providers by contract, 2026-09-26).
- `module-local-mode.test.ts` imports `../agents/agent-local-store.js` (`localUpsertAgent`) for fixtures — check-gates TEST-ONLY finding; `agentGate.create` mints its own UUID so the fixture cannot swap without rewriting the test's id assertions.
- `ListModulesOpts` is exported from `module-service.ts:409-412` but not via the gate — limit/offset typing has no ported contract.
- Whether `runtimePatchable` on instruction modules is enforced anywhere (vs advisory) was not traced beyond storage.
- `testConnectionHelper` accepts `endpointUrl` per call but stored custom-provider endpoint semantics (override vs fallback) are unverified beyond pass-through.
- No observed writer/owner for `embedding_model_profiles` in this domain — embedding provider config lives outside the module CRUD surface (see Memories Gaps).

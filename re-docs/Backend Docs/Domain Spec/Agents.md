# Agents

## Purpose
Agent identity registry for CrowdOS: CRUD plus roster listing for identity-only profiles whose cognition lives in referenced modules. Also owns the error escalation chain. (Legacy L3 dispatch + spawn retention deleted 2026-09-14; Swarm gate only.)

## Feature Scope
In-scope:
- Agent profile CRUD and filtered roster listing with reference validation
- Runtime-state row lifecycle alongside profiles (create/update/escalate cleanup)
- Error escalation chain (pause, notify, reassign up authority levels)

Non-goals (other domains):
- Real task execution — Swarm gate (`SWARM_V1`), not `AgentSpawnManager`
- Skill/toolkit resolution and caching — Skills (this domain only invalidates)
- Message/channel ownership — Messages / Workspace (this domain writes them as side effects)
- Queueing, scheduling, approvals — Queue / Approvals
- Enforcement of stored permission blobs — no in-domain enforcement observed

## Expect
- `[Observed]` Every gate CRUD op accepts an optional `db` override and falls back to ambient `getDb()` (`agent-gate.ts:54-69`, `agent-service.ts:114,186,225,356,513`).
- `[Observed]` `list()` never returns archived rows; `getById()` can return an archived row (`agent-service.ts:148` vs `agent-service.ts:186-223`).
- `[Observed]` On PG/dual legs `create()` always inserts a `runtimeStates` row and `update()` always rewrites runtime-state status/heartbeat (`agent-service.ts:283-294,339-348`, `agent-service.ts:455-475,491-504`); local-tier exception — there is no `runtime_states` ledger locally, so presence lives in `agents.status` only.
- `[Observed]` `update()`/`delete()` on a missing id return `null`/`false`, never throw (`agent-service.ts:363-366`, `agent-service.ts:532-533`).
- `[Observed]` `escalate()` pauses the failing agent before resolving any target (`agent-errors.ts:52-67,101-102`).
- `[Observed]` `list()` limit clamps to 1–200 (default 200); cursor is a numeric offset, silently 0 when unparseable (`agent-service.ts:91-93,169-174`).
- `[Observed]` 2026-10-08 roster degradation (IMPL-AGENTLIST500-001): the explicit-handle path (`list(filters, dbOverride)` — `routes/agents.ts` passing `request.db`) serves the workspace-scoped local tier when the tenant PG leg fails (schema-mismatch/outage, 42P01 class), exactly like the bound (ALS) path; unscoped filters (`workspaceId` undefined) stay PG-only. Regression: `agent-list-degrade.test.ts`.
- `[Inferred]` `create()` is not idempotent — each call mints a new UUID, so caller retries duplicate.
- `[Inferred]` `list()` may serve 30s-stale rosters; only registry mutations invalidate the cache, never outside writes.
- `[Observed]` Isolation (CrowdOS §1): `agents.workspace_id` (nullable FK, 0018) scopes the roster per workspace; `list`/`create`/`update` carry `workspaceId`, `list` returns scoped + legacy-global (null) rows, same name is a separate instance per workspace (`agents_workspace_name_idx`). 2026-09-23 tenant guard: creating an agent without a workspace scope is refused in production (the POST /api/agents route now forwards the tenant header resolution) instead of silently filing the file under the default workspace folder; unit-test fixtures are exempt.
- `[Observed]` 2026-09-23 tenant scoping on single-row reads and updates: `PUT /api/agents/:id` threads the tenant resolution into `agentGate.update(id, body-with-workspaceId, db, workspaceId)`; `getById(id, db, workspaceId)` resolves the local row inside the caller workspace folder first (PG only fills the gap when local has nothing), so duplicate agent ids across workspace folders can no longer cross-write another workspace copy (`routes/agents.ts`, `agent-service.ts`, `agent-gate.ts`).
- `[Observed]` 2026-09-26 cross-tenant fallback fix: when a scope is named, `getById` never falls back to the unscoped local fan-out read (`scopesFor(undefined)` probes every workspace folder) — that fallback is how a foreign workspace's agent could be read and then deleted. Unscoped resolution stays only for explicit legacy/global callers (`workspaceId` undefined/null). Same rule on the update re-read and the delete resolve (`agent-service.ts:198-223,363,475,510,532`).
- `[Observed]` 2026-09-26 `list({ workspaceId: null })` is an explicit `IS NULL` filter on BOTH legs (PG `agent-service.ts:153-155`, local `agent-local-store.ts:164-166`) — a roster without the tenant header no longer serves every tenant's agents; `undefined` keeps the legacy fan-out.
- `[Observed]` Socket dispatch + mention resolution scope the roster to the message workspace (`register-socket-server.ts`, `mention-parser.ts` with optional `workspaceId`; AGT-003 fixed) — foreign-workspace agents no longer leak into mention/auto-trigger dispatch.
- `[Observed]` Socket dispatch + mention resolution scope the roster to the message workspace (`register-socket-server.ts`, `mention-parser.ts` with optional `workspaceId`; AGT-003 fixed) — foreign-workspace agents no longer leak into mention/auto-trigger dispatch. Profile updates no longer flip runtime presence unless `status` was explicitly provided (AGT-014 fixed); explicit `null` clears nullable module links (AGT-009 fixed).
- `[Observed]` Socket dispatch + mention resolution scope the roster to the message workspace (`register-socket-server.ts`, `mention-parser.ts` with optional `workspaceId`; AGT-003 fixed) — foreign-workspace agents no longer leak into mention/auto-trigger dispatch. Profile updates no longer flip runtime presence unless `status` was explicitly provided (AGT-014 fixed); explicit `null` clears nullable module links (AGT-009 fixed). Cascade failures propagate out of the delete transaction (AGT-005 fixed); sync/replay invalidates the roster via a gate port (AGT-007 fixed); `contextTokenCap` persists via migration 0027 (AGT-008 fixed). 2026-10-07 db-audit note: 0027 was missing from `meta/_journal.json` (drizzle applies only journal-listed tags), so the column existed solely in `schema.ts` on migrated DBs; journal entry added.

## Flow
CRUD:
0. Local-tier create resolves module references first (2026-09-23): the canon instruction default (`instr-default`) is seeded idempotently into the Modules local store (`<workspaceFolder>/vfs/.crowdos/*-modules.json`) via `moduleGate.ensureDefaults` when missing, a missing instruction reference falls back to `instr-default`, and a dangling model reference is dropped to null — no model default is seeded, so "Launch Assembly" works on a fresh local workspace with zero model providers (2026-09-26) (`agent-service.ts` create).
1. `list` — `agentGate.list` delegates to the registry (`agent-gate.ts:54`); with a `db` override it runs the same degraded `loadBoundRoster` loader as the bound path (handle threaded through, PG leg under `pgCatchNull`, workspace-scoped local merge), otherwise it serves a scope-keyed cached roster (`agent-service.ts:126-141`); loader filters `archivedAt IS NULL` plus optional authority/status/template filters, clamps limit, maps cursor to offset, orders by authority then name (`agent-service.ts:144-184`); the union path clamps the merged PG+local roster to the requested limit (`agent-service.ts:140`).
2. `getById` — scoped local read first (`agent-local-store.ts:188-194`), PG gap-fill with the same tenant filter, mapped profile or `null` with no archived-filter (`agent-service.ts:186-223`).
3. `create` — validate module/fallback references (`agent-service.ts:281-330`); insert `agents` row with new UUID (`agent-service.ts:228-249`); insert `runtimeStates` row keyed `session-{agentId}`, offline stays offline else idle, both writes inside one transaction (`agent-service.ts:283-294,339-348`); re-read, invalidate roster cache, return (`agent-service.ts:295-296,351-353`).
4. `update` — return `null` when missing (`agent-service.ts:363-366`, tenant-scoped resolve); merge input over existing with explicit-null clearing (`agent-service.ts:371-394`); cross-field/invariant checks (l3Subtype level, self-fallback) run on EVERY update regardless of tier (`agent-service.ts:452,698-705`) while reference-existence checks stay dual/db-override tier-gated (`agent-service.ts:455-458,480-485`); the `db`-override write and its re-read are workspace-scoped (`agent-service.ts:456-475`); dual-write merged row in one transaction (`agent-service.ts:486-504`); invalidate Skills caches when toolkit/permissions changed (`agent-service.ts:471-473,506-508`); invalidate roster cache and re-read scoped (`agent-service.ts:474-475,509-510`).
5. `delete` — hard-delete by id, cascade `runtime_states`, invalidate cache, return whether a row existed (`agent-service.ts:513-558`); both the `db`-override and dual PG writes run inside one transaction (`agent-service.ts:516-527,544-553`).
   2026-09-25 audit fix: the tier context is resolved from the row's own `workspaceId` (outbox entries are attributed to the owning workspace instead of the global scope a drain cannot route), the local delete is scoped to the owning workspace folder so duplicate ids across folders cannot cross-delete, and the REST delete route 404s up front when the id does not resolve inside the caller's workspace (`routes/agents.ts`).

Escalate:
11. Callers (loop-arbiter, token-tracker) invoke the static `EscalationChain.escalate` exported via the gate — there is no `agentGate.escalate` port. It is a never-rejecting wrapper (`try/catch`, failure logged, chain stops where it broke — callers reach it from bare async timers) around the private `run()` (`agent-errors.ts:44-67`). `run()` emits `escalation:created` with a random-suffix id, typed `loop_detected` only for `LOOP_DETECTED` (`agent-errors.ts:79-86`); loop errors additionally emit `strike:initiated` with fixed strike 1/3 (`agent-errors.ts:89-98`); pauses the failing agent via `agentRegistry.setStatus` plus the `agent:paused` emit (`agent-errors.ts:101-102`).
12. Target resolution L3→L2→L1→user (`agent-errors.ts:104-117`), roster search tenant-scoped to the failing agent's workspace (`agent-errors.ts:123-126`); live non-offline/non-paused target gets an `[ESCALATION]` system message with escalation mention plus `message:new` (`agent-errors.ts:130-143`), target set working/thinking (`agent-errors.ts:146-147`), then a tracked per-target (supersede, `unref`'d) 1.2s-delayed takeover reply whose every step is guarded and whose `finally` always resets the target to idle (`agent-errors.ts:32-41,152-183`); otherwise an `[EMERGENCY NOTIFICATION]` user message plus `budget:exceeded` (`agent-errors.ts:189-203`).
    2026-09-25 audit fixes: target resolution is tenant-scoped (the roster lookup filters `workspaceId` when the failing agent carries one; unscoped legacy agents keep the cross-workspace search), the delayed takeover reply is fully guarded (a failed `messageGate.append` is logged and the target is still reset to idle in `finally`, so it can no longer stick on `working`), and `escalation:created` ids carry a random suffix so same-millisecond escalations cannot collide (`agent-errors.ts`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `agent-gate.ts` | Thin facade: re-exports internals and exposes `agentGate` ports only |
| `agent-service.ts` | `AgentRegistry` CRUD, roster query, reference validation, runtime-state writes |
| `agent-errors.ts` | `AgentErrorType` union plus `EscalationChain` (never-rejecting `escalate` wrapper, private `run`) |
| `agent-validators.ts` | Zod schemas for create/update bodies, list query, id params; `queryBooleanSchema` string coercion |
| `agent-roster-cache.ts` | 30s TTL single-flight roster cache with fail-evict and test override |
| `agent-local-store.ts` | File-tier JSON store: workspace-scoped read/list/seed (row helpers exported only as gate ports) |
| `agent-instruction-stack-local-store.ts` | File-tier JSON store for per-agent instruction stacks (`instruction-stacks.json`): workspace-scoped list/replace, same id/priority shape as the PG rows |
| `agent-types.ts` | Identity-only profile/input/filter types; cognition lives in module refs |

Key types/functions: `AgentRegistry` (list/getById/create/update/delete/setStatus/touchHeartbeat/sweepOrphans, private `loadRoster`/`assertInvariants`/`ensureValidReferences`); `mapAgentProfile` (row → profile incl. nullable normalisation); `normalizePermissions` (partial permissions over deny-by-default); `EscalationChain.escalate` → private `run`; `getCachedRoster` / `invalidateRosterCache` / `enableRosterCacheForTests`.

## Ports
- `AgentRegistry` (`agent-gate.ts`) — registry class (kept exported for existing callers; new code must use `agentGate` ports — migrating mention-parser/socket-server/module-service is a follow-up).
- `agentRegistry` (`agent-gate.ts`) — shared registry instance backing `agentGate` CRUD (same deprecation note as above).
- `EscalationChain` (`agent-gate.ts`) — error escalation across authority levels (static, never-rejecting).
- `createAgentSchema` (`agent-gate.ts`) — validates agent creation bodies.
- `updateAgentSchema` (`agent-gate.ts`) — validates agent update bodies.
- `listAgentsQuerySchema` (`agent-gate.ts`) — validates roster list queries.
- `agentParamsSchema` (`agent-gate.ts`) — validates agent id params.
- `AgentProfile` (`agent-gate.ts`) — identity-only agent record type (now incl. `workspaceId`, null = legacy global; `contextTokenCap` is local-tier-only — no PG column, migration follow-up).
- `AuthorityLevel` (`agent-gate.ts`) — `0 | 1 | 2 | 3` authority tier type.
- `AgentStatus` (`agent-gate.ts`) — runtime status type (`idle | working | paused | offline`).
- `MemorySharingPolicy` (`agent-gate.ts`) — `none | horizontal | vertical | full` type.
- `L3Subtype` (`agent-gate.ts`) — `worker | supervisor` type.
- `AgentAuthorityPermissions` (`agent-gate.ts`) — spawn/patch/access permission blob type.
- `CreateAgentProfileInput` (`agent-gate.ts`) — service-level creation input type.
- `UpdateAgentProfileInput` (`agent-gate.ts`) — service-level update input type.
- `AgentRegistryFilters` (`agent-gate.ts`) — service-level roster filter type (now incl. optional `workspaceId`).
- `ListAgentsQuery` (`agent-gate.ts`) — validated list-query type.
- `AgentParams` (`agent-gate.ts`) — validated id-param type.
- `CreateAgentBody` (`agent-gate.ts`) — validated creation-body type.
- `UpdateAgentBody` (`agent-gate.ts`) — validated update-body type.
- `agentGate.list` (`agent-gate.ts`) — lists non-archived profiles by filter. `workspaceId: null` is an explicit legacy-global (`IS NULL`) filter on both legs; `undefined` keeps the cross-workspace fan-out (2026-09-26 isolation fix).
- `agentGate.getById` (`agent-gate.ts`) — returns one profile by id or `null`; optional third `workspaceId` argument scopes the local-folder resolution before PG gap-fill, and a named scope never falls back to the unscoped fan-out read (2026-09-26; `routes/agents.ts` GET/DELETE pass the tenant header resolution).
- `agentGate.create` (`agent-gate.ts`) — creates profile plus runtime state.
- `agentGate.update` (`agent-gate.ts`) — updates profile and runtime state, `null` when missing. Nullable clears (update schema `.nullable()`) flow through: only `undefined` keeps existing; `null` persists the clear in both tiers (2026-09-25 audit fix).
- `agentGate.delete` (`agent-gate.ts`) — hard-deletes profile, `true` when a row existed. Optional third `workspaceId` scopes the resolve (duplicate ids must not cross-delete); deletes cascade to `runtime_states` in the service (no FK in schema — follow-up). `routes/agents.ts` DELETE passes the tenant header (2026-09-25 audit fix).
- `EscalationChain.escalate` (via `EscalationChain` export) — escalates an agent error up the chain; not an `agentGate` port (2026-09-26: the `agentGate.escalate` port was removed as dead). Never-rejecting wrapper; target is random among eligible (was alphabetical first-match); takeover replies are tracked per target (supersede on re-escalation, `unref`'d — `cancelPendingTakeovers` drain helper removed as unused) (2026-09-25/26 audit fixes).
- `agentGate.setStatus` (`agent-gate.ts`) — sole `agents.status` + `runtime_states` flip: atomic write plus heartbeat, lease mark, and `agent:status` emit. Accepts `opts.workspaceId` for the local flip; invalidates the roster cache so flips show immediately (2026-09-25 audit fix).
 2026-09-25: `setStatus` resolves the tier context from the agent row's own workspace (local-first read, PG gap-fill) so the PG leg and outbox fallback are attributed to the owning workspace rather than the global scope. localSetAgentStatus returns boolean (warns on miss); localUpsertAgent throws on filename collision and requires workspaceId for creates (update path exempt); module-reference validation threads workspaceId for the local tier (2026-09-25 audit fixes).
- `agentGate.touchHeartbeat` (`agent-gate.ts`) — refreshes `lastHeartbeat` for live agents across workspace DBs.
- `agentGate.sweepOrphans` (`agent-gate.ts`) — pauses stale `working` rows whose heartbeat expired, returns paused count; the heartbeat-cleared check is re-verified inside the UPDATE where-clause so a concurrent touch can no longer be clobbered into a stuck pause (2026-09-26 race fix).
- `agentGate.listLocalAgents` (`agent-gate.ts`) — file-tier roster read (socket-server runtime snapshot).
- `agentGate.listLocalAgentRows` (`agent-gate.ts`) — raw file-tier row read (workspace sync diffing).
- `agentGate.seedDefaultAgent` (`agent-gate.ts`) — idempotent default-agent seed for a new workspace folder (workspace boot).
- `agentGate.getInstructionStack` (`agent-gate.ts`) — reads one agent's instruction-stack links with the module row embedded. Explicit `db` pins PG exactly; otherwise the workspace tier decides (local file store + `moduleGate` reads, dual PG gap-fill on the owning handle). Never throws for a missing stack — reads as `[]`.
- `agentGate.replaceInstructionStack` (`agent-gate.ts`) — atomic stack replacement, all-or-nothing per tier (PG transaction / local file swap under one lock). Explicit `db` pins PG exactly; otherwise the workspace tier decides. The local leg validates every module id up front (the PG leg enforces via FK). Optional `db`/`workspaceId` args are backward-compatible (XD-015 port, tier-aware since studio local/db decoupling).
- `LocalAgentRow` (`agent-gate.ts`) — type-only export for the file-tier row shape.
- `LocalInstructionStackLink` (`agent-instruction-stack-local-store.ts`) — file-tier stack-row shape (mirrors the PG columns).

## Relations
Gates called: `skillsGate.invalidateAgentCaches` on toolkit/permission changes; `moduleGate.validateReferences` for module-FK validation (dynamic import, cycle-safe); `forEachWorkspaceDb` via `workspace-gate.ts` for heartbeat/sweep; `messageGate.append` for escalation/emergency rows. Type-only: `EventBroker`. Shared helpers (exempt): `getDb`/`dbScopeKey`/`runWithDb`/`withTransaction`, sequence numbers, ULIDs, TTL cache.
Verified outside callers: REST CRUD via `routes/agents.ts`; roster reads in socket-server and mention-parser; file-tier reads/seeding now gate-routed — `agentGate.listLocalAgentRows` in `shared/core/workspace-sync.ts`, `agentGate.listLocalAgents` in `shared/sockets/register-socket-server.ts`, `agentGate.seedDefaultAgent` in `routes/workspace.ts`, `agentGate.update` for FK writes plus `agentGate.getInstructionStack`/`replaceInstructionStack` for the stack slot in `routes/studio.ts`; `agentGate.setStatus` from Runtime kernel and Librarian; `agentGate.touchHeartbeat`/`sweepOrphans` from Shared heartbeat; `EscalationChain.escalate` from loop-arbiter and token-tracker; import-only reference in `worker.ts`.
Reads (not owned): module tables via `moduleGate.validateReferences` and `moduleGate.instruction.get` (stack embed), never direct. `messages` rows go through `messageGate.append`, never direct.

## Emits-Listens
- `workspace:sync` (emits)
- `agent:status` (emits)
- `agent:thinking` (emits)
- `agent:paused` (emits)
- `message:new` (emits)
- `message:stream` (emits)
- `escalation:created` (emits)
- `strike:initiated` (emits)
- `budget:exceeded` (emits)

## Owns
- `agents` — profiles, instances, templates (this domain inserts/updates/hard-deletes).
- `runtime_states` — sole owner: lifecycle rows plus every status/heartbeat flip go through `agentGate.setStatus`/`touchHeartbeat`/`sweepOrphans`.
- `spawn_requests` / `task_files` — legacy tables retained in schema with no new writes (retired 2026-09-14; avoids a destructive migration).

## Flags
- None (legacy `SWARM_LEGACY` / spawn `RETENTION_*` flags removed; artifact retention `RETENTION_DAYS` lives in Artifacts).

## Decisions
- `[Observed]` Identity-only profiles: prompts, models, tools live in module tables; agents store references — keeps identity stable while cognition is versioned separately (`agent-types.ts:16+`, `agent-service.ts:228-249`).
- `[Observed]` Deny-by-default permission merge preserves existing grants on partial update — avoids accidental privilege wipe (`agent-service.ts:59-68,390,413,441`). 2026-09-23: the client update path no longer force-grants the full permission blob on every save (`crowdOsStore.ts updateAgent` sends only the fields the user edited; the server-side merge keeps existing values).
- `[Observed]` Roster cache is 30s TTL, 50 keys, single-flight on the loader promise with fail-evict — hot mention/trigger paths share one query and transient DB errors are never pinned (`agent-roster-cache.ts:15-30`).
- `[Observed]` Cache key includes tenant scope plus serialised filters — same filter shape shares an entry, different tenants/filters do not (`agent-service.ts:127-131`).
- `[Observed]` Escalation pauses first, resolves second — a failing agent can never keep acting while routing is decided.
- `[Observed]` Single owner for presence: `agents.status` and `runtime_states` flip together inside `agentGate.setStatus` (atomic tx + heartbeat + lease + emit), so spawn/error flips can no longer diverge from runtime state the way the old split `agents`-only updates did.
- `[Observed]` Loop strikes are fixed at 1 of 3 with a hardcoded reason — downstream strike counting lives elsewhere (`agent-errors.ts:89-98`).
- `[Inferred]` `offline` maps to `offline` runtime status and every other agent status maps to `idle` on create/update — runtime presence is derived, and a working agent edited via API goes idle (`agent-service.ts:289,344,465,497`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this. Roster cache, escalation pause-first, db-override scoping, transactional multi-statement writes, and studio FK-writes-via-gate are satisfied (2026-09-26); remaining gaps: archived visibility agreement and permission enforcement.
Presence has a single owner: agents.status plus runtime_states flip together inside agentGate.setStatus in one atomic write plus heartbeat, lease, and emit. Split updates are forbidden.
Every read-modify-write honors the caller db override end to end. Ambient getDb fallback on re-read is forbidden in multi-DB paths.
Delete semantics are explicit: hard-delete must cascade or explicitly orphan runtimeStates and messages rows with a documented rule. Two silent semantics are not acceptable.
getById archived visibility plus reference validation must agree: either both exclude archived rows or archived-as-fallback is an explicit contract.
Permission blobs with no enforcement must be labeled advisory or wired to enforcement. Stored-but-unenforced permissions are not acceptable as a security boundary.
Escalation keeps pause-first then resolve. Delayed takeover replies must have error handling and a defined stuck-working recovery, not fire-and-forget setTimeout.
All agent FK writes go through agentGate.update validation. Direct agents-table writes from Studio or other routes are forbidden.
## Failure + Resume
- Invalid references throw before any write: non-L3 `l3Subtype`, self-fallback, or missing model/instruction/toolkit/constraints/capabilities/fallback rows (`agent-service.ts:303-305,698-705,708-725`); REST maps these to 400 (`routes/agents.ts:83-89,120-126`).
- `create` re-read failure throws after rows were written — but both `agents` + `runtime_states` inserts now share one transaction, so the rows roll back together (`agent-service.ts:283-294,339-348`). Update and delete multi-statement writes are likewise transactional on db-override and dual paths (`agent-service.ts:459-470,491-501,517-527,544-552`).
- Escalation target lookup skips offline/paused agents and falls through to direct user notification plus `budget:exceeded` when nobody is eligible; the delayed takeover reply is tracked per target (supersede, `unref`'d) and every step is guarded — failed append logged, target reset to idle in `finally` (`agent-errors.ts:32-41,152-183`).
- Roster loader failures evict the cache entry so the next call retries.
- Resume is manual: unpause via update (route emits `agent:resumed` on paused → non-paused transitions, `routes/agents.ts:115`); no automatic unpause, no dispatch checkpointing, no sweeper catch-up for missed intervals.
- Previously silent `.catch(() => null)` reads (scoped local resolve, setStatus row read) now log a warning instead of swallowing the failure (`agent-service.ts:206-209`).

## Gaps
- `delete()` hard-deletes while spawn teardown archives: two deletion semantics. `runtime_states` is now cascaded explicitly inside the same transaction (logged on failure, no FK — schema follow-up), but `messages` rows are still orphaned on delete — intent unverified.
- `getById()` returns archived spawn instances; reference validation does not exclude archived rows, so an archived agent may be a legal fallback — unverified intent.
- `contextTokenCap` flows end to end in the schemas and local store (`agent-validators.ts:49,72`, `agent-service.ts:446`), but the PG `agents` table has no such column — the PG leg maps whatever the row happens to carry (`agent-service.ts:54-55`) until the migration lands.
- `worker.ts` imports `agentGate` only to void it (`worker.ts:33`) — likely a dead dependency-keepalive, purpose unverified (file outside this fix's allowed list, left untouched).
- `categoryPermissions`, `isOmniscient`, and the `permissions` blob have no in-domain enforcement observed; consumers were not exhaustively traced.
- `species`/`avatar` null-vs-undefined round-trip is asymmetric between create and update paths — cosmetic, intent unverified.
- `strike:initiated` is emitted with `as any`, hinting the broker's typed contract does not cover it (`agent-errors.ts:90`).
- `routes/studio.ts` skill writes touch their own domain tables directly (not `agents`); the `agents` FK updates route through `agentGate.update` with reference validation and roster invalidation (`routes/studio.ts`, 2026-09-26), and the instruction-stack slot reads/writes route through `agentGate.getInstructionStack`/`replaceInstructionStack` (studio local/db decoupling — the route no longer reads `agentInstructionStacks` directly, which 500'd every local-only workspace via bare `getDb()`).
- 2026-10-07 AGT-001/002 fixed: unbound (socket/worker) writes and re-reads resolve the owning workspace record DB via dbForWorkspace (agent-service.ts:221-233,267-275,540-583,690-721); bound-scope list merges the workspace-scoped local roster so local-first rows are visible (agent-service.ts:202-212). Regression: src/agents/agent-dual-handle.test.ts. contextTokenCap PG note above is stale (0027 landed).
- 2026-10-07 AGT-005 fixed: `delete()` no longer swallows the `runtime_states` cascade failure in-transaction — both legs (explicit-handle agent-service.ts:597-604; dual-write :624-629) let it propagate, so a failed cascade rejects the caller and the whole tx rolls back. The FK itself remains a schema follow-up. Regression: agent-dual-handle.test.ts:253-267.
- 2026-10-07 AGT-008 fixed: `contextTokenCap` now persists on the PG tier — create row (:305) and update pgSet (:476-477) write `context_token_cap`; schema.ts:236-237 + migration 0027. The two `contextTokenCap` Gaps bullets above are resolved. Regression: agent-dual-handle.test.ts:269-287.
- 2026-10-07 AGT-009 fixed: `modelModuleId` null now clears and undefined keeps on BOTH tiers — service merge (agent-service.ts:437-438) and the local-store mirror (agent-local-store.ts:81,276; was `??` which kept on null). Regression: agent-dual-handle.test.ts:293-310.
- 2026-10-07 AGT-014 fixed: generic `update()` no longer rewrites `runtime_states`/presence — the flip is guarded by `input.status !== undefined` on both legs (agent-service.ts:521-531,563-572), so a title-only edit of a working agent stays working; setStatus remains the sole presence owner. Regression: agent-dual-handle.test.ts:312-329. Note: line numbers throughout this doc drifted with the AGT-001/002/005/008/009/014 fixes.
- 2026-10-07 AGT-016 fixed: localSeedDefaultAgent namespaces the seed id per workspace (`<workspaceId>:default-assistant`, agent-local-store.ts:379-382) - two workspaces sharing one PG DB no longer collide on the agents.id PK; a pre-fix literal-id seed is still returned untouched (:375-377). Regression: agent-local-store.test.ts:118-141. NEXT_ACTION (workspace domain): workspace-canon.test.ts:157-186 pins the legacy literal filename/id (2 tests now fail) - update alongside this fix.
- 2026-10-08 IMPL-AGENTLIST500-001 fixed: the explicit-handle roster path (`list(filters, dbOverride)` — production caller `routes/agents.ts` passing `request.db`) now degrades exactly like the bound (ALS) path. `loadBoundRoster` takes the optional handle, wraps the PG leg in `pgCatchNull`, and merges the workspace-scoped local rows; unscoped filters (`workspaceId` undefined) stay PG-only. Pre-fix an unprovisioned/unreachable tenant PG leg (42P01 class) rejected and 500'd `GET /api/agents`, clearing the client's tenant slices. Regression: src/agents/agent-list-degrade.test.ts. AGT-010 (`pgCatchNull` catch-all semantics) remains Open.

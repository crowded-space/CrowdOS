# Agents Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/agents/` (8 source + 3 test files), facade `agent-gate.ts`, all cross-domain callers (grep-verified), persistence (schema + migrations), boot wiring, tests, docs.
Method: full read of every domain file and every cross-domain call site, schema/migration inspection, boot/queue wiring, baseline command run. READ-ONLY: no production edits; no branch; git untouched except `audit/`.
Docs updates NOT performed (drift recorded in contracts.md / bug-ledger, per AGENTS.md §6 left for the fix task).

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| `agent-gate.ts` | 2948 | Facade: 11 `agentGate` ports + class/instance re-exports + schema/type re-exports |
| `agent-service.ts` | 33397 | `AgentRegistry`: list/getById/create/update/delete/setStatus/touchHeartbeat/sweepOrphans; roster query; reference validation; runtime_states writes; dual-boot + local-first branching |
| `agent-errors.ts` | 8469 | `AgentErrorType` + `EscalationChain` (never-rejecting escalate; pause-first; takeover replies) |
| `agent-validators.ts` | 3833 | Zod schemas: create/update/list-query/params + queryBoolean coercion |
| `agent-roster-cache.ts` | 1908 | 30s / 50-key single-flight roster cache, fail-evict, test override |
| `agent-local-store.ts` | 17682 | File tier: `<ws>/vfs/agents/<id>.json` CRUD, scoped fan-out, tenant guards, seed |
| `agent-types.ts` | 3106 | Identity-only profile/input/filter types; `AgentStatus = RuntimeStatus` |
| `agent-local-store.test.ts` | 4014 | 3 tests: full-field persistence, merge-update, scoped list |
| `agent-roster-cache.test.ts` | 13691 | 5 tests: TTL cache behavior + tenant-scoped getById/delete (CRITICAL-1) |
| `agent-validators.test.ts` | 1643 | 3 tests: query booleans, contextTokenCap |

Naming (AGENTS.md §1): all `*.ts` kebab-case, gate `agent-gate.ts` — compliant. No `*.tsx` in domain.

## 2. Facade surface (exact, `agent-gate.ts`)

Value exports: `AgentRegistry` (:29), `agentRegistry` (:29), `EscalationChain` (:29), `agentGate` (:53), `createAgentSchema`/`updateAgentSchema`/`listAgentsQuerySchema`/`agentParamsSchema` (:43-48).
Type exports: `AgentProfile`, `AuthorityLevel`, `AgentStatus`, `MemorySharingPolicy`, `L3Subtype`, `AgentAuthorityPermissions`, `CreateAgentProfileInput`, `UpdateAgentProfileInput`, `AgentRegistryFilters`, `LocalAgentRow` (:33-42); `ListAgentsQuery`, `AgentParams`, `CreateAgentBody`, `UpdateAgentBody` (:51).
Ports (11): `list` (:54), `getById` (:55), `create` (:56), `update` (:57-58), `delete` (:59), `setStatus` (:60-61), `touchHeartbeat` (:62), `sweepOrphans` (:63-64), `listLocalAgents` (:67), `listLocalAgentRows` (:68), `seedDefaultAgent` (:69).
NOTE (:30-32): `AgentRegistry`/`agentRegistry` stay exported for existing callers (mention-parser, socket server, module-service); migration is a follow-up.

## 3. Entities / invariants / transitions

- `AgentProfile`: identity-only; `workspaceId?` (null = legacy global), `authorityLevel 0-3`, module refs (model nullable = unattached), `memorySharingPolicy`, `permissions` (deny-by-default), `status` ∈ {idle, working, paused, offline}, `isTemplate`, `contextTokenCap?` (local-only today), timestamps.
- `LocalAgentRow`: same shape + `archivedAt`/`archivedReason` (never set by any write path) + ISO-string dates.
- `runtimeStates`: `sessionId` PK = `session-<agentId>`, `agentId` (non-unique index), `status`, `errorInfo` jsonb, `lastHeartbeat`.
- Status transitions: free-form via `setStatus` (no state machine); `update()` derives runtime status (offline→offline, else idle); sweep forces working→paused on stale heartbeat.
- Cross-field invariants: l3Subtype ⇒ L3 (`agent-service.ts:700-702`, create pre-check :304); fallback ≠ self (:704-706); references exist (only db-override + dual tiers, :709-736).

## 4. Persistence / tables / migrations

- `agents` table (`db/schema.ts`): PK id text; `workspace_id` FK→workspaces ON DELETE CASCADE (migration `0018_agents_workspace_id.sql`); unique `(workspace_id, name)`; no `context_token_cap` column; `archivedAt/archivedReason` exist but no archive write path in this domain.
- `runtime_states`: no FK from `agent_id`; cascade delete done by hand in service (:521-525, :548-552) and failure is swallowed via `.catch` INSIDE the transaction.
- Migrations: 0018 only for this domain; contextTokenCap migration absent (documented gap); `db/bootstrap.ts:160` also creates runtime_states (bootstrap path).
- Cache: `agent-roster-cache.ts` module-level TtlCache (30s/50 keys); disabled under VITEST unless opted in (:20-27).
- Files: `<workspaceFolder>/vfs/agents/<safeId>.json`, one file per agent, no index; filename collision guard (:294-298); store lock `agents:<id>` (:198, :252, :335).

## 5. Dependency map (Caller → Facade → Service → Port → Adapter)

```
routes/agents.ts ─ agentGate.{list,getById,create,update,delete} ─ agentRegistry (agent-service.ts)
  ├─ getDb()/runWithDb/withTransaction ── shared/config/database.ts ── drizzle/postgres-js
  ├─ loadRoster (PG agents) ── pgCatchNull (swallows PG errors)
  ├─ localListAgents/localGetAgent/localUpsertAgent/localSetAgentStatus/localDeleteAgent
  │     └─ shared/core/local-file.ts (resolveWorkspaceAgentsDir, withStoreLock, writeJsonFile)
  ├─ moduleGate.validateReferences (dynamic import; gate-to-gate, cycle-safe)
  ├─ skillsGate.invalidateAgentCaches (toolkit/permissions change)
  └─ dualWrite ── shared/config/database.ts ── outbox (shared/core/outbox.ts) on PG failure
runtime-kernel.ts:234, librarian-runtime.ts:84,154, agent-errors.ts:101,146,174 ─ agentGate.setStatus
shared/core/agent-heartbeat.ts:35,41 ─ agentGate.touchHeartbeat / sweepOrphans (timers 15s/20s; sweep skipped in bullmq mode)
register-socket-server.ts:165 ─ listLocalAgents ; :752 list (UNSCOPED) ; :1013 getById/list for run:resume
workspace-sync.ts:75,227,308,573 ─ listLocalAgentRows ; :231,438,442 DIRECT agents table writes (sync/pull/outbox)
routes/workspace.ts:279 ─ seedDefaultAgent
routes/studio.ts:26,116,130,191 ─ getById + update (manifest FK writes)
routes/channels.ts:142 ─ getById (UNSCOPED pin validation)
swarm-worker-resolver.ts:196 ─ list ; module-service.ts:118,121 ─ agentRegistry.list ; capabilities:184 ─ getById
mention-parser.ts:8,44 ─ new AgentRegistry().list (UNSCOPED)
loop-arbiter.ts:45 / token-tracker.ts:132 ─ EscalationChain.escalate
worker.ts:33 ─ `void agentGate` (dead keepalive)
```

## 6. Entry points

- REST (`routes/agents.ts`): GET/POST `/api/agents`, GET/PUT/DELETE `/api/agents/:id`; loopback trust, no role gate; tenant via `x-workspace-id` → `request.workspaceId` + `request.db`; PUT emits `agent:resumed` on paused→non-paused; workspace:sync on all mutations.
- Studio: GET/PUT `/api/studio/agents/:id/manifest`, POST `/api/studio/inspect-prompt` (gate used for agent read + FK update; instruction-stack/skill tables written directly).
- Socket: `user:message` dispatch (unscoped roster), `run:resume` (agent resolution), emits consumed by clients.
- Timers: heartbeat touch 15s; orphan sweep 20s (inline mode only); escalation takeover 1.2s delayed per target.
- Boot: workspace create seeds default-assistant (`routes/workspace.ts:279`); worker import-only.

## 7. Bypasses

- Production: NONE past the gate for imports (check-gates: 0 violations).
- Direct table writes by other domains: `shared/core/workspace-sync.ts:231,438,442` (agents upsert/delete on sync/pull/outbox) — data-path bypass with NO roster-cache invalidation.
- Test-only gate bypasses (check-gates non-fatal, agent-related ×8): `channels/channel-local-mode.test.ts:23-24`, `events/events-integration.test.ts:79-80`, `modules/module-local-mode.test.ts:20`, `runtime/local-chat-e2e.test.ts:24-25`, `workspace/workspace-canon.test.ts:30`.
- CLI/scripts: `db/seed.ts:106,138`, `db/check.ts:46,124` write agents directly (dev tooling).

## 8. Config / env

- `ORPHAN_AFTER_MS` (min 10 000, default 60 000; silent clamp :651-652).
- `VITEST` (cache off; tenant guards relaxed in local store for fixtures).
- Roster cache constants 30s/50 keys (`agent-roster-cache.ts:15-16`).
- No domain feature flags (docs: none).

## 9. Test inventory

`npx vitest run src/agents` → 3 files, 11 tests, all passed (~3.0s). Coverage: local-store persistence/merge/scoping; roster cache TTL/invalidations/archived-guard + tenant getById/delete; validators. NOT covered: setStatus, sweepOrphans, touchHeartbeat, EscalationChain, REST routes, create/update service semantics beyond the scripted-db cache test, cross-tenant mention/channel-pin paths.

## 10. Baseline (exact)

- `npx vitest run src/agents` (packages/server) → `Test Files 3 passed (3)`, `Tests 11 passed (11)`.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `node scripts/check-gates.mjs` → exit 0: "scanned 361 files across 23 domains, 0 violations"; 46 TEST-ONLY findings (8 agent-related); 3 allowlisted pre-existing (none agents).
- `git status`: main, pre-existing dirty tree unchanged by audit; only `audit/` added.

## 11. Unknowns (Low confidence, time-boxed)

- Exact driver behavior for a swallowed statement error inside `withTransaction` (commit-as-rollback vs throw) — AGT-005 marked Medium.
- Whether unscoped socket roster reads are accepted legacy or a bug (docs §1/§30 imply isolation; code contradicts at socket/channel call sites) — AGT-003/004 High on code, intent Low.
- Real-world duplicate `runtime_states` rows per agent (index non-unique) — AGT-022 Low.
- Outbox drain poison-entry handling for agent rows (workspace-sync reviewed lightly) — AGT-024 Medium.

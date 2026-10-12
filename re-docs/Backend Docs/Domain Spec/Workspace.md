# Workspace

## Purpose
Workspace plane: per-workspace BYODB routing and provisioning, local `workspaces.json` registry, the on-disk workspace-folder layout (canon: `mock-structure-polished`), and workspace-row screenlock PIN storage. The gate is a registry+routing+paths facade (manager/guards deleted 2026-09-14).

### On-disk canon (mock-structure-polished)

```text
workspaces/
  workspaces.json                  <- portal/hub index (lists every workspace; truth on load)
  <folderName>/                    <- display name, sanitized; `id` is the stable key
    workspace.json                 <- singular record for THIS folder only, rootPath "."
    vfs/
      .crowdos/
        workspace.json             <- runtime only: permissions, constraints, artifactDir, fsMounts
        categories.json            <- ONLY place for categories
        channels.json              <- ONLY place for channels
        channel-settings.json, sequences.json, event-sequences.json, capabilities.json
        messages/<channelId>.jsonl, events/<channelId>.jsonl, memories/, skills/, locks/
        cache/ runtime/ snapshots/
      agents/<agentId>.json         <- one file per agent, single object, filename == id
      artifacts/                    <- plain file storage, no index file
      src/
```

`vfs/` is a local config sandbox: it is never a mount target for a user repository. The global index wins for listing and startup; the folder copy is rewritten from it after every save.

## Feature Scope
In-scope:
- Local `workspaces.json` registry CRUD with serialized writes (`workspace-registry.ts`).
- Canon folder layout: display-name folder resolution, the per-folder `workspace.json` mirror, and the `vfs/` path helpers (`workspace-paths.ts`, `workspace-runtime.ts`).
- BYODB URL validate/describe, `.env` key read/write, connection probe, schema provision under per-DB lock, preset seeding, full reset (`workspace-database.ts`).
- Pooled per-workspace Postgres routing with LRU cap, idle eviction, URL-hash rotation, and multi-DB fan-out (`workspace-database-runtime.ts`).
- Workspace-row screenlock hash read/write with registry-first, DB second ordering (`workspace-pin.ts`).
Non-goals (other domains):
- Screenlock crypto/HTTP enforcement → Auth/Pin (`pin-gate.ts:54`, `pin-gate.ts:190` owns hashing and the request gate; this domain only stores hashes).
- REST/tenant wiring, budget endpoints, screen-lock routes → Routes (`routes/workspace.ts`, `create-app.ts` tenant hook).
- File I/O and path containment → Filesystem (`LocalFilesystem` lives there, not here; it touches no table).
- Run orphan sweeps, approval/memory/token sweeps → Runs/Approvals/Memories/Shared (they borrow `forEachWorkspaceDb`, never own routing).
- Execution, queue delivery, approvals policy → Runtime/Queue/Approvals.

## Expect
- `[Observed]` Workspace URL precedence is the registry record first, then that workspace's `CROWDOS_WS_<ID>_DATABASE_URL` process/`.env` value. The process-wide `DATABASE_URL` is not a tenant fallback (`workspace-database-runtime.ts:122-130`; `workspace-registry.ts:288-306`).
- `[Observed]` No id or no workspace-assigned URL throws `NO_DATABASE`; global `getDb()` remains a separate unscoped pool (`workspace-database-runtime.ts:97-99`, `workspace-database-runtime.ts:122-130`, `shared/config/database.ts:363`).
- `[Observed]` Registry writes are serialized through an in-process promise chain; concurrent saves cannot interleave reads (`workspace-registry.ts:38`).
- `[Observed]` A missing registry (`ENOENT`) reads as zero workspaces; a corrupt/unreadable registry throws instead of reading as empty (WS-005) (`workspace-registry.ts:245-251`).
- `[Observed]` `.env` writes are serialized the same way and applied atomically via tmp-file rename with mode `0o600` (`workspace-database.ts:141`, `workspace-database.ts:181`).
- `[Observed]` Secrets never enter logs, errors, pool stats, or API output — only non-secret `{ host, port, database }` descriptors leave the domain (`workspace-database.ts:64`, `workspace-database.ts:91`, `workspace-database-runtime.ts:147`, `workspace-registry.ts:64`).
- `[Observed]` The `WorkspaceManager` and `permission-guard.ts` were deleted (2026-09-14, see Purpose) — the gate is now a registry+routing facade with no lifecycle/mount surface. Earlier revisions of this doc described those methods as frozen; they no longer exist at all.

## Flow
1. Resolve registry path: `CROWDOS_WORKSPACE_REGISTRY_FILE` override, else `CROWDOS_DATA_DIR`/`WORKSPACE_DIR` + `workspaces.json`, else `<cwd>/sandbox/workspaces.json` with the result cached (`workspace-registry.ts:44`).
2. Live create (routes, current path): `POST /api/workspaces` with a `databaseUrl` validates URL shape, probes `select 1`, provisions migrations under `withProvisionLock`, saves the registry record FIRST so `getWorkspaceDb(id)` resolves the new pool, bounded-mkdir sandbox, seeds presets, mirrors a `workspaces` row (`routes/workspace.ts:111`, `routes/workspace.ts:123`, `routes/workspace.ts:134`, `routes/workspace.ts:156`, `routes/workspace.ts:184`). Without a `databaseUrl` (C3 local-first 2026-09-16) it creates a registry-only workspace: sandbox mkdir only, `database.configured:false`, no probe/provision/seed. The 201 payload always carries `schemaReady`/`seedReady` (WS-006: `false` when provision or seed fell back to a warning) and `rootPathWarning` (WS-013: non-null when an explicit `rootPath` sits outside the sandbox) (`routes/workspace.ts:347-356`).
3. Per-request routing: tenant hook reads `x-workspace-id`, marks workspace-management paths DB-optional via `isWorkspaceManagementPath`, resolves `getWorkspaceDb`, fails closed with 503 `WORKSPACE_DB_OFFLINE` (25s watchdog), and runs the lifecycle inside `runWithDb` (`create-app.ts:228-236`, `create-app.ts:243-245`, `create-app.ts:283-304`).
4. Pool resolve: `getWorkspaceDb(id)` reads the registry URL first and the matching per-workspace env key second, returns the cached pool on URL-hash hit, rotates on URL change, then evicts idle/LRU pools before opening (`workspace-database-runtime.ts:122-158`).
5. Fan-out: `forEachWorkspaceDb(fn)` visits registry workspaces with a record URL or matching per-workspace env URL, dedupes identical handles, and runs serially with per-target best-effort catch; it does not add the global pool (`workspace-database-runtime.ts:235-266`).
6. Provision/seed/reset: `provisionWorkspaceDatabase` runs drizzle migrations over a short-lived single connection with abort timeout and redacted errors; `withProvisionLock` serializes per target DB; `seedWorkspacePresets` idempotently inserts model/instruction/category/channel/message/agent/settings rows; `resetWorkspaceDatabase` drops every table in the versioned `WORKSPACE_RESET_DROP_TABLES` list, journal-drift-guarded by test (WS-003) (`workspace-database.ts:384`, `workspace-database.ts:463`, `workspace-database.ts:488`, `workspace-database.ts:652-705`, `workspace-database.ts:708-716`).
7. Screenlock write: `setScreenLockPin` validates `4..128` chars via pin-gate, requires current-PIN proof (stored hash OR global `LOCAL_PIN`) when a hash exists, writes registry then DB sync, fails closed when no store acknowledges (WS-002 fixed), and invalidates the 15s pin cache so new state enforces immediately (WS-001 fixed) (`workspace-pin.ts`); reads go registry-first, DB-second, throw-to-404 when neither has the workspace (`workspace-pin.ts:32`). Corrupt `workspaces.json` throws instead of reading as empty (WS-005 fixed).
7b. Reset + quarantine (WS-003/WS-004 fixed): `resetWorkspaceDatabase` drops the full table set (runs, memories, skills, sequences, ledger, keys, events — was missing 15 tables), the versioned list diffed against every migration `CREATE TABLE` by the journal-drift test (`workspace-database.test.ts:25-44`); `tierContextFor` resolves `dbSync.state === "conflict"` records to local-only so `resolveTier` never yields dual and the write path's replica leg is never entered (unit-tested, `workspace-database.test.ts:49-102`).
11. Delete: `DELETE /api/workspaces/:id` optionally flushes tables with `?flush=true`, closes the pool, removes the registry record, best-effort `rm` sandbox, best-effort DB row delete (`routes/workspace.ts:355`, `routes/workspace.ts:363`, `routes/workspace.ts:364`, `routes/workspace.ts:375`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `workspace-gate.ts` | Thin facade: registry+routing only |
| `workspace-registry.ts` | `workspaces.json` file store: path resolution, lock, raw read/write, record CRUD, sanitized descriptors |
| `workspace-paths.ts` | Canon path layer: folder-name sanitize, `vfs/.crowdos`/`agents`/`artifacts`/`src` resolution, artifact-dir normalization |
| `workspace-runtime.ts` | Canon runtime object at `vfs/.crowdos/workspace.json`: read/write/normalize permissions, constraints, artifactDir, fsMounts |
| `workspace-types.ts` | Status/scope/permission/workspace/session/event/input types |
| `workspace-pin.ts` | Hash store: registry-first load, status/get/set/clear, current-PIN proof, hash-stripping sanitize |
| `workspace-database.ts` | BYODB core: URL validate/describe, env-file resolve, `.env` upsert/remove, probe, provision, seed, reset |
| `workspace-database-runtime.ts` | Routing: pooled handles, LRU + idle eviction, hash rotation, `forEachWorkspaceDb` fan-out |
| `workspace-database.test.ts` / `workspace-database-runtime.test.ts` / `workspace-database-routes.test.ts` / `workspace-pin.test.ts` | In-domain tests for URL keys, pool rotation/eviction, registry writes, sanitize/proof rules |

Key types/functions: `WorkspaceStatus`; `WorkspaceRecord` (registry row incl. `databaseUrl`, `rootPath`, `folderName`, `artifactDir`, `screenLockPinHash`) vs `Workspace` (DB row); `WorkspaceDescriptor` (sanitized, `screenLockEnabled` flag only); `WorkspaceRuntimeConfig` (canon `vfs/.crowdos/workspace.json` object); `ResolvedWorkspaceDb { db, source, workspaceId }`; `WorkspaceDatabaseDescriptor` (non-secret); `ScreenLockStatus`.

## Ports
- `resolveWorkspaceFolder` — absolute folder a record owns (`rootPath`, else `<sandboxBase>/<folderName>`).
- `resolveRecordFolderName` — display-name folder for a record (explicit `folderName`, else sanitized `name`, else id).
- `resolveRecordArtifactDir` — canon-normalized folder-relative artifact dir (default `vfs/artifacts`).
- `writeWorkspaceFolderCopy` — rewrite the per-folder `workspace.json` mirror (`rootPath: "."`).
- `resolveWorkspaceFolderPath` — `<sandboxBase>/<folderName>` join.
- `resolveVfsDir` / `resolveCrowdosDir` / `resolveAgentsDir` / `resolveSrcDir` — canon `vfs/` path helpers.
- `resolveArtifactsDir` — absolute artifact dir, refusing an absolute/traversal `artifactDir`.
- `normalizeArtifactDir` — folder-relative `artifactDir` (default `vfs/artifacts`).
- `toFolderRelative` — absolute path → folder-relative slash form (for DB artifact rows).
- `sanitizeWorkspaceFolderName` — display name → safe folder name (reserved names, trailing dots).
- `DEFAULT_ARTIFACT_DIR` — the canon default, `"vfs/artifacts"`.
- `getWorkspaceDb` — resolves `{ db, source }` from the workspace record or matching per-workspace env key, with pool rotation; never falls back to process-wide `DATABASE_URL`.
- `closeWorkspaceDatabase` — best-effort close of one pooled handle.
- `closeAllWorkspaceDatabases` — best-effort close of all pooled handles (shutdown).
- `getWorkspaceDbPoolStats` — `{ workspaceId, lastUsed }` inventory only, never URLs.
- `forEachWorkspaceDb` — serial best-effort fan-out over configured workspace DBs, including matching per-workspace env keys.
- `parseWorkspaceDatabaseUrl` — shape-validates a Postgres URL (scheme/host/length/controls), never logs it.
- `describeWorkspaceDatabaseUrl` — non-secret descriptor for metadata and API output.
- `testWorkspaceDatabaseConnection` — short-lived `select 1` probe with redacted user-facing errors.
- `provisionWorkspaceDatabase` — applies drizzle migrations to a user DB over a short-lived connection.
- `provisionWorkspaceDatabaseSchema` — alias of `provisionWorkspaceDatabase`.
- `withProvisionLock` — per-target-DB mutex serializing concurrent provisions.
- `checkWorkspaceSchemaReady` — SYNC-1 (2026-10-08): cached (60s/workspace) information_schema probe reporting `{ ready, missing[] }` for the CrowdOS relations; honest `null` when unresolvable, never throws.
- `invalidateWorkspaceSchemaProbe` — drops the cached probe (bind/change-db/disconnect, sync-now retry, tests).
- `seedWorkspacePresets` — idempotent minimal seed (modules/category/channels/agents/settings) into a workspace DB.
- `resetWorkspaceDatabase` — drops every table in the versioned `WORKSPACE_RESET_DROP_TABLES` list (journal-drift-guarded; WS-003).
- `upsertWorkspaceDatabaseEnv` — atomic insert/replace of one `CROWDOS_WS_*` key in `.env`, returns the key.
- `removeWorkspaceDatabaseEnv` — best-effort removal of one `CROWDOS_WS_*` key (no-op if absent).
- `resolveWorkspaceEnvFilePath` — nearest `.env` walking up from cwd, `CROWDOS_WS_ENV_FILE` wins.
- `listWorkspaces` — sanitized registry descriptors.
- `listWorkspaceRecords` — raw registry records including secrets-adjacent `databaseUrl` and PIN hashes.
- `getWorkspaceRecord` — one raw record or `null`.
- `getWorkspaceDescriptor` — one sanitized descriptor or `null`.
- `tierContextFor` — dual-boot TierContext for a workspace (registry preference + effective workspace URL, record first then matching per-workspace env key); a `dbSync.state === "conflict"` record resolves local-only so no replica write is attempted (WS-004).
- `saveWorkspaceRecord` — locked upsert of one record, returns the sanitized descriptor.
- `removeWorkspaceRecord` — locked delete, `true` when a row existed.
- `getScreenLockStatus` — `{ workspaceId, enabled }`, throws when the workspace exists nowhere.
- `getWorkspacePinHash` — stored hash or `null` (never throws on missing).
- `setScreenLockPin` — validates, proofs current PIN, persists hash to registry + best-effort DB.
- `clearScreenLockPin` — proofs current PIN, nulls the hash in registry + best-effort DB.
- `sanitizeWorkspace` — strips `screenLockPinHash`, exposes `screenLockEnabled`.
- `WorkspaceStatus` — lifecycle union type.
- `WorkspaceScope` — `private | shared | readonly | ephemeral` mount scope.
- `WorkspacePermissions` — `{ network, shell, maxAgents }` shape.
- `RuntimeConstraints` — `{ networkAccess, shellExecution, memoryLimitMb, cpuLimit }` shape.
- `FilesystemPermissions` — `{ read, write, execute }` permission shape.
- `Workspace` — DB row shape.
- `CreateWorkspaceInput` — create input.
- `MountAgentInput` — mount input (retained type; no live caller since the manager was deleted).
- `ScreenLockStatus` — `{ workspaceId, enabled }`.
- `WorkspaceRecord` — registry record shape.
- `WorkspaceDescriptor` — sanitized descriptor shape.
- `StoragePreference` — `default` (dual-write DB-first) | `local` (files-only) registry preference.
- `DbSyncState` — `paired | conflict | importing | pushing` pairing state.
- `DbSyncInfo` — `{ dbWorkspaceId, state, updatedAt }` pairing/sync state.

## Relations
Gates this domain calls:
- `pin-gate.ts` — crypto only (`getGlobalPin`, `hashScreenLockPin`, `validateScreenLockPin`, `verifyScreenLockPin` in `workspace-pin.ts:12`); PIN HTTP enforcement lives in Auth/Pin, not here.
- Non-gate internals used: `Shared/config/database.ts` (`getDb`, `withTransaction`, `runWithDb`), `db/schema.ts` (table defs), `Filesystem/filesystem-gate.js` (`LocalFilesystem`), `Shared/core/ttl-cache.ts` (`.env` path cache).
Verified outside callers:
- Sweep fan-out via `forEachWorkspaceDb`: `runs/orphan-sweep.ts:98`, `approvals/approval-sweeper.ts:11`, ``memories/memory-lifecycle.ts:184`, `Shared/core/token-tracker.ts:223`.
- BYODB routes via `routes/workspace.ts`: registry CRUD (`routes/workspace.ts:92`), `getWorkspaceDb` for seed/mirror (`routes/workspace.ts:184`), screen-lock endpoints (`routes/workspace.ts:415`).
- Tenant routing + boot via `create-app.ts`: `getWorkspaceDb` per request (`create-app.ts:258`), `listWorkspaceRecords` for filesystem bootstrap (`create-app.ts:60`), `getWorkspacePinHash` as the PIN resolver (`create-app.ts:331`).
- Registry reads: `routes/filesystem.ts` (`getWorkspaceRecord` for root-path resolution); `pin-gate.ts:108` (dynamic `listWorkspaceRecords` import to avoid a static cycle).
Tables shared with other domains (written here only where noted):
- `workspaces` (this domain writes via pin-sync/seed-mirror; read by Runs undo-compensation for root paths).
- Seed target tables owned elsewhere but written best-effort by `seedWorkspacePresets`: `categories`, `channels`, `messages`, `agents`, `model_modules`, `instruction_modules`, `workspace_settings`.
- Read-only here: `workspace_settings` budget rows (routes read/write via tenant handle). `workspace_nodes` was dropped in 0019 and is no longer read by any domain.

## Emits-Listens
- None (manager event emits deleted with `WorkspaceManager`).

## Owns
- `workspaces` (writes: status/PIN/metadata updates)
- `workspaces.json` registry file (writes: record save/remove)
- `<folderName>/workspace.json` per-folder record mirror (writes: rewritten on every save)
- `<folderName>/vfs/.crowdos/workspace.json` runtime object (writes: permissions/constraints/artifactDir/fsMounts)
- `.env` managed keys `CROWDOS_WS_*_DATABASE_URL` (writes: upsert/remove)

## Flags
- `CROWDOS_WORKSPACE_REGISTRY_FILE` — outright registry path override (`workspace-registry.ts:46`).
- `CROWDOS_DATA_DIR` — registry directory preference over `WORKSPACE_DIR` (`workspace-registry.ts:51`).
- `WORKSPACE_DIR` — sandbox root fallback for registry + workspace creation (`workspace-registry.ts:120`, `workspace-registry.ts:136-137`).
- `CROWDOS_WS_ENV_FILE` — outright `.env` path override (`workspace-database.ts:107`).
- `CROWDOS_WS_DB_MAX_POOLS` — pool cap, default 10 (`workspace-database-runtime.ts:48`).
- `CROWDOS_WS_DB_IDLE_MS` — idle eviction threshold, default 10min (`workspace-database-runtime.ts:52`).
- `CROWDOS_WS_<ID>_DATABASE_URL` — per-workspace URL key, sanitized from the id (`workspace-database.ts:49`); explicit `process.env` wins over disk (`workspace-database.ts:320`).
- `LOCAL_PIN` — consumed indirectly via pin-gate: global operator PIN accepted as current-PIN proof and request credential (`workspace-pin.ts:76`, `pin-gate.ts:34`).

## Decisions
- `[Observed]` Registry-first resolution with `.env` as legacy fallback and global as default — portal and sweeps work DB-less while configured workspaces route to their own DB (`workspace-database-runtime.ts:94`).
- `[Observed]` Serialized file writes (registry lock, `.env` lock) with atomic tmp-rename for `.env` — single-user desktop cannot drop concurrent keys; cross-process races explicitly out of scope (`workspace-registry.ts:105-109`, `workspace-database.ts:139`).
- `[Observed]` Pool per workspace capped with LRU + idle eviction and URL-hash rotation — hand-edits and portal saves apply without restart and stale pools never serve (`workspace-database-runtime.ts:61`, `workspace-database-runtime.ts:73`, `workspace-database-runtime.ts:101`).
- `[Observed]` Fan-out is serial and best-effort with handle dedupe — one dead database never stalls or duplicates the rest (`workspace-database-runtime.ts:168-192`).
- `[Observed]` Provision errors are redacted and user-facing; URLs/credentials never appear in messages (`workspace-database.ts:362`, `workspace-database.ts:270`).
- `[Observed]` Provision lock is per target database in-process only — concurrent launches queue instead of wedging in DDL locks; multi-instance fleets would need advisory locks (`workspace-database.ts:447`, `workspace-database.ts:463`).
- `[Observed]` Provision applies migrations only, never seed data; seeding is a separate explicit idempotent step (`workspace-database.ts:342`, `workspace-database.ts:488`).
- `[Observed]` Screenlock hashes live in the registry first and sync best-effort to the DB — lock writes survive DB outages and never throw on sync failure (`workspace-pin.ts:98`, `workspace-pin.ts:107`).
- `[Observed]` Hashes never leave the server: both sanitizers expose only `screenLockEnabled` (`workspace-pin.ts:22`, `workspace-registry.ts:64`).
- `[Observed]` Reset drop-list is an explicitly versioned constant (`WORKSPACE_RESET_DROP_TABLES`) consumed by `resetWorkspaceDatabase`, with a journal-drift test diffing it against every `CREATE TABLE` in `db/migrations` — a new migration cannot silently outlive a flush (WS-003) (`workspace-database.ts:652-705`, `workspace-database.test.ts:25-44`).
- `[Observed]` A `dbSync.state === "conflict"` record resolves local-only at tier resolution (`tierContextFor`), so `resolveTier` never yields dual and `dualWrite`/`withStoreFallback` never push rows into the unrelated database (WS-004) (`workspace-registry.ts:294-300`).
- `[Observed]` Create 201 always carries `schemaReady`/`seedReady` (false when provision/seed degraded to a warning) and `rootPathWarning` (non-null when an explicit `rootPath` sits outside the sandbox); both PATCH and create surface the warning (WS-006, WS-013) (`routes/workspace.ts:347-356`, `routes/workspace.ts:507-518`).
- `[Observed]` An explicit outside-sandbox `rootPath` is honored but flagged, never rejected — folder-picker flows stay usable and the portal owns the warn decision; delete keeps such folders in place (WS-013).
- `[Inferred]` Tenant hook fails closed (503) on unresolvable workspace DBs except management paths, which degrade to `dbError` so the portal stays usable (`create-app.ts:244`, `create-app.ts:243`).

## Alignment notes
- - 2026-09-23 QA tenant hardening: workspace bootstrap seeding (`routes/workspace.ts` -> localCreateCategory/localCreateChannel/localSeedDefaultAgent) passes the real workspace id, and the local stores refuse to create category/channel/agent rows without a scope (production throws/returns error instead of filing under `default`; unit-test fixtures keep their documented unscoped path).
2026-09-22 canon storage (mock-structure-polished): the global `workspaces.json` stays the portal/hub index and the truth on load; each workspace also owns a display-name folder (`<sandboxBase>/<folderName>`) holding a `workspace.json` mirror (`rootPath: "."`, rewritten on every save) plus the canon `vfs/` layout. `WorkspaceRecord` gained `folderName` + `artifactDir`. `LocalFilesystem.initialize()` now materializes `vfs/{src,artifacts,agents,.crowdos/{cache,runtime,snapshots}}` and seeds `vfs/.crowdos/workspace.json` with the canon runtime object. The old global `<registryDir>/localstore/` is gone: categories, channels, channel-settings, messages, events, memories, skills, capabilities and locks all live under the owning workspace's `vfs/.crowdos/`, and agents are one file per agent at `vfs/agents/<agentId>.json`. Renaming a workspace moves its folder (refused when the destination is occupied or outside the sandbox); deleting a record removes the folder only when it holds nothing CrowdOS did not create. Local AppData `workspaces/` was reset for this migration (destructive, no sensitive data).
- 2026-09-17 dual-boot: `storagePreference` (`default` dual-write DB-first / `local` files-only) + `dbSync` pairing state on the registry record; `PATCH /api/workspaces/:id` persists preference and evaluates pairing on attach; `GET|POST /api/workspaces/:id/db-sync` serves status + resolve/sync-now/rebuild-rag actions. Outage fallback is per-URL cached (~20s), connection-class errors only. Pairing rule: empty side pulls, same-id converges (union-merge), unrelated-DB quarantines to conflict (local-only, non-blocking resolve).
- 2026-09-18 fixes: converge unions PG-only channels (not just local list); outbox message replay insert-ignores by PK id (seq collisions no longer drop rows); resolve returns the auto-snapshot dir in `detail`; `boot-local-mode.test.ts` proves `buildServer()` builds with `DATABASE_URL` unset.
- 2026-09-20 local-wins: `convergeWorkspace` is a local→PG push (upsert-by-id, no deletes, no resequence, outbox cleared); PG→local union/resequence removed — local files are truth, PG is a replica (`workspace-sync.ts`). Agents push/pull per-workspace roster slices.
- 2026-10-09 storage-mode alignment: `tierContextFor`, `getWorkspaceDb`, and `forEachWorkspaceDb` share registry-first then per-workspace env URL behavior. A workspace with no assigned URL stays local even when the process-wide `DATABASE_URL` exists; that global pool remains available to unscoped `getDb()` and CLI/migration callers, not as a tenant fallback. The earlier env-only tier/handle mismatch is covered by `workspace-database-runtime.test.ts`.
- 2026-10-07 workspace bug-ledger fixes (WS-003/004/006/013), verified:
  - WS-003 reset coverage: `resetWorkspaceDatabase` now drops the versioned `WORKSPACE_RESET_DROP_TABLES` list (adds the 15+ missed tables: runs, memories, skills, sequences, ledger, keys, durable events, model profiles, runtime, scheduler, spawn/task files) and drops `__drizzle_migrations` last; the journal-drift test diffs the list against every migration `CREATE TABLE` (`workspace-database.ts:652-716`, `workspace-database.test.ts:25-44`).
  - WS-004 conflict quarantine: `tierContextFor` returns `storagePreference: "local"` for `dbSync.state === "conflict"` records (no URL), so message/local-store write paths never enter the replica leg; unit-tested with a conflict record and a paired control (`workspace-registry.ts:294-300`, `workspace-database.test.ts:49-102`).
  - WS-006 readiness: create computes `schemaReady`/`seedReady` at handler scope (provision and seed failures flip them false) and returns both in the 201 payload; route tests cover the provision-failure path and the DB-less path (`routes/workspace.ts:192-195,231,296,308,347-356`, `workspace-database-routes.test.ts:162-166,175-191`).
  - WS-013 rootPath flag: create and PATCH compute `rootPathWarning` via `isInsideRoot(path.resolve(rootPath), resolveSandboxBase())`; outside-sandbox paths are honored but flagged, contained paths return null; route tests cover both on create and patch (`routes/workspace.ts:243-251,507-518`, `workspace-database-routes.test.ts:279-350`).
  - Doc drift note: the `Expect` global-fallback lines and Flow-5 fan-out wording above still reflect WS-011 drift (ledger-tracked); not fixed here to keep this task scoped to the four rows.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Registry-first routing plus pooled rotation plus redacted provisioning stay; seed atomicity and port boundaries are the gaps. Reset coverage is now satisfied (WS-003: versioned list + journal-drift test).
Registry-first resolution with matching per-workspace env fallback stays; process-wide `DATABASE_URL` is not a tenant fallback. Serialized file writes with atomic tmp-rename stay. Per-workspace pooled routing with LRU plus idle eviction plus URL-hash rotation stays.
Fan-out stays serial best-effort with handle dedupe. Provision errors stay redacted with no URLs or credentials in messages. Migrations-only provision plus separate idempotent seed stays.
Screenlock hashes stay registry-first with best-effort DB sync and server-only exposure of screenLockEnabled.
isCurrentPinAccepted MUST be a gate port or removed. Proof enforcement reachable only past the gate is forbidden.
Port boundary MUST be consistent: importable-past-gate helpers are either ported or labeled internal. Mixed route-direct plus gate-only use is forbidden.
Import casing MUST match on-disk PascalCase dirs. Case-insensitive-only validity is forbidden.
seedWorkspacePresets MUST be transactional or resumable with explicit status: provisioned, seeded, degraded. Partial-seed with per-row swallow and no retry owner is forbidden.
resetWorkspaceDatabase drop-list MUST be generated from the migration journal or explicitly versioned. Hardcoded drop-lists drifting from migrations are forbidden.
describeWorkspaceDatabaseUrl schemaReady MUST have a documented writer flipping it after provisioning. Permanently-stale readiness is forbidden.
Pool stats MUST support leak versus idle attribution beyond ids plus timestamps, or explicitly document the observability limit.
## Failure + Resume
- Registry read failures resolve to `[]`/`null`; writes throw only on real FS errors after `mkdir -p` (`workspace-registry.ts:244-247`, `workspace-registry.ts:251-256`).
- URL shape errors throw `Invalid workspace database URL: ...`; probe/provision errors are redacted maps (auth/host/timeout classes) that routes surface as 400 (`workspace-database.ts:60`, `workspace-database.ts:270`, `workspace-database.ts:362`, `routes/workspace.ts:113`).
- Routing never throws to callers for unconfigured workspaces — it returns the global handle; the HTTP 503 only comes from the tenant hook, with a 25s watchdog converting stalls to visible errors (`workspace-database-runtime.ts:98`, `create-app.ts:232`).
- Pool close errors are swallowed; `__resetWorkspaceDbPoolsForTests` only clears the map (`workspace-database-runtime.ts:130`, `workspace-database-runtime.ts:153`).
- Screenlock set/clear throw `Current screenlock PIN is incorrect.` on bad proof and `Workspace <id> not found` (via status path as 404) when the workspace exists nowhere; `getWorkspacePinHash` instead returns `null` (`workspace-pin.ts:92`, `workspace-pin.ts:80`, `workspace-pin.ts:55`, `routes/workspace.ts:421`).
- Reset runs raw `DROP TABLE ... CASCADE` including the migrations journal with no dry-run and no resume — re-provision from scratch (`workspace-database.ts:668`).

## Gaps
- `isCurrentPinAccepted` enforces the current-PIN proof but is not a gate port; external reuse must import past the gate (`workspace-pin.ts:69`).
- `workspaceDatabaseEnvKey`, `readWorkspaceDatabaseUrl`, `clearWorkspaceEnvCache`, `sanitizeWorkspaceRecord`, `resolveRegistryFilePath`, `setRegistryFilePathForTests` are importable past the gate (routes/tests use them via the gate only where re-exported) — port boundary vs direct use is inconsistent.
- Imports use lowercase `shared/` + `workspace/` segments while the on-disk dirs are PascalCase `Shared/` + `Workspace/` (`create-app.ts:15`, `pin-gate.ts:108`) — valid on case-insensitive filesystems, breaks on case-sensitive ones; frozen per task, do not rename.
- `seedWorkspacePresets` writes Agents/Channels/Messages/Modules/Settings tables owned elsewhere with per-row try/catch — partial-seed visibility and retry ownership are unverified (`workspace-database.ts:488`).
- `describeWorkspaceDatabaseUrl` defaults `schemaReady=false`; the create 201 payload now carries `schemaReady`/`seedReady` (WS-006), but the descriptor-metadata surface (`metadata.database.schemaReady`) still has no writer — UI reading that path may stay stale.
- `getWorkspaceDbPoolStats` exposes only ids + timestamps, so pool leak vs idle attribution beyond counts was not traced.
- No `listens` observed; whether any worker subscribes to `workspace.created`/`agent.joined`/`agent.left` beyond socket fan-out was not traced beyond emit sites.

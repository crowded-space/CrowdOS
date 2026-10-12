# Workspace provisioning flow
> Type: Flow · Status: aligned · Updated: 2026-10-07

## Intent
A new workspace needs its own data plane — validated Postgres database, migrated schema, seed rows, registry entry, sandbox directory — in an order where no step can leave a half-live workspace serving traffic. This flow exists so validation and migration complete before the workspace becomes routable, and so schema (migrations) and data (seeding) failures stay distinguishable.

## Architectural decision
The live path runs through routes plus registry plus `getWorkspaceDb`, while `WorkspaceManager` create/status/mount semantics are frozen legacy with no verified production callers `[Observed]`. Provisioning applies migrations only under a per-target-DB lock, and seeding is a separate explicit idempotent step, so DDL and seed failures are told apart (`workspace-database.ts:342`, `workspace-database.ts:463`, `workspace-database.ts:488`) `[Observed]`. The registry record is saved *before* seeding so `getWorkspaceDb(id)` already resolves the new pool when subsequent steps run (`routes/workspace.ts:156`) `[Observed]`. Filesystem `initialize` creates the physical root and standard sectors on first use, with no DB access at all (`local-filesystem.ts:30-59`) `[Observed]`.

## How it works
1. `POST /api/workspaces` shape-validates the BYODB URL (scheme/host/length/controls, never logged) and probes it with a short-lived `select 1`; shape errors throw, probe errors surface redacted (`workspace-database.ts:60`, `workspace-database.ts:270`, `routes/workspace.ts:111`, `routes/workspace.ts:123`).
2. Drizzle migrations apply over a short-lived single connection with abort timeout, serialized per target DB by `withProvisionLock`, with redacted user-facing errors (`workspace-database.ts:384`, `workspace-database.ts:463`, `routes/workspace.ts:134`).
3. The registry record saves FIRST, so `getWorkspaceDb(id)` resolves the new pool from that point on (`workspace-registry.ts:38`, `routes/workspace.ts:156`); writes are serialized through the registry promise chain and `.env` keys go through atomic tmp-rename (`workspace-registry.ts:38`, `workspace-database.ts:141`, `workspace-database.ts:181`).
4. The sandbox directory is created under the `WORKSPACE_DIR` root, then `seedWorkspacePresets` idempotently inserts minimal model/instruction/category/channel/message/agent/settings rows (`routes/workspace.ts:151`, `workspace-database.ts:488`, `routes/workspace.ts:184`).
5. A `workspaces` row is mirrored into the new DB so row-level lookups (PIN sync, undo-compensation root paths) resolve (`routes/workspace.ts:184`).
6. On first use, filesystem `initialize` creates the physical root, mkdirs the seven standard sectors, and writes `/.crowdos/workspace.json` when missing. It touches no table (`local-filesystem.ts:30-59`).
7. From then on, per-request routing resolves the pooled handle via `getWorkspaceDb` (URL-hash rotation, idle + LRU eviction) and fans sweeps out via `forEachWorkspaceDb` (`workspace-database-runtime.ts:100-122`, `workspace-database-runtime.ts:160-183`).
8. Readiness + warning surface (WS-006, WS-013): the 201 response carries `schemaReady`/`seedReady` (false when provision or seed degraded to a logged warning — `routes/workspace.ts:192-195,231,296,308`) and `rootPathWarning` (non-null when the explicit `rootPath` is outside the sandbox; the path is still honored, never rejected — `routes/workspace.ts:243-251`). PATCH returns the same `rootPathWarning` when it changes `rootPath` (`routes/workspace.ts:507-518`). `describeWorkspaceDatabaseUrl`'s `schemaReady` parameter remains unwritten by any route (see open gap); the payload fields are the writer-less-descriptor fix for the create path.
9. Reset coverage (WS-003): `resetWorkspaceDatabase` (`?flush=true` delete path) drops every table in the versioned `WORKSPACE_RESET_DROP_TABLES` list, `__drizzle_migrations` last so the next provision re-runs `0000`; a journal-drift test diffs the list against every `CREATE TABLE` in `db/migrations` (`workspace-database.ts:652-716`, `workspace-database.test.ts:25-44`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Workspace.md> | Owns URL validate/probe, migration provision under lock, registry save, preset seeding, row mirror, pooled routing and fan-out |
| <../Domain Spec/Filesystem.md> | Owns standard-sector bootstrap on `initialize`; touches no table |

Related in this folder: [Workspaces and provisioning](./Workspaces%20and%20provisioning.md) — system design (registry-first routing, pools, PIN store, frozen manager); this flow covers only the create→seed→ensure timeline.

## Current state
Real on the routes path: validate → probe → locked migration provision → registry-first save → sandbox + idempotent seed → row mirror → lazy filesystem bootstrap. Frozen legacy: `WorkspaceManager` (the `CREATED → INITIALIZING → ACTIVE` lifecycle with filesystem-failure compensation) was deleted on 2026-09-14. Secrets never enter logs, errors, pool stats, or API output.

## Alignment notes
- 2026-10-07 WS-003/004/006/013 (bug-ledger, verified): the reset drop-list is the versioned `WORKSPACE_RESET_DROP_TABLES` constant with a journal-drift test (WS-003); `tierContextFor` quarantines `dbSync.state === "conflict"` records to local-only so no replica write is attempted (WS-004); the 201 payload carries `schemaReady`/`seedReady` (WS-006) and create/PATCH carry `rootPathWarning` for outside-sandbox roots (WS-013 — honored, flagged, never rejected). Scoped vitest (`src/workspace`, `src/shared/core/workspace-sync.test.ts`, `src/routes`) 85/85 passed; `tsc --noEmit` exit 0.
- 2026-09-22 canon storage (mock-structure-polished): the workspace folder is now the DISPLAY NAME (`<sandboxBase>/<folderName>`, sanitized) instead of the id, and it holds `workspace.json` (a mirror with `rootPath: "."`) plus the canon `vfs/` layout. `LocalFilesystem.initialize` mkdirs `vfs/{src,artifacts,agents,.crowdos/{cache,runtime,snapshots}}` and seeds `vfs/.crowdos/workspace.json` with the runtime object (permissions, constraints, `artifactDir: "vfs/artifacts"`, `fsMounts`) instead of the old root-level sectors and `/.crowdos/workspace.json`. The earlier "seven standard sectors" note is superseded by the canon list. Renaming a workspace moves its folder; deleting a record removes the folder only when it holds nothing CrowdOS did not create.
`none found` beyond the pointer already recorded in [Workspaces and provisioning](./Workspaces%20and%20provisioning.md) (sector count: the earlier `Vfs.md` claim of eight sectors was corrected — code creates seven paths at `local-filesystem.ts:43-60`, and `Filesystem.md` now states seven). Ordering note, not drift: the task shorthand reads "seed → registry", but code saves the registry *before* seeding (`routes/workspace.ts:156` then `:184`) so routing resolves during seed — the timeline above follows the code.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Validation plus locked migration provision before routable stays. Registry-first save so getWorkspaceDb resolves during seed stays.
* Seed is transactional or resumable with explicit status. Partial-seed with per-row swallow and no retry owner is forbidden.
* Reset drop-list is explicitly versioned and journal-drift-guarded — satisfied by WS-003 (`WORKSPACE_RESET_DROP_TABLES` + test). `schemaReady` has a documented writer: the create/PATCH payload fields (WS-006); the `describeWorkspaceDatabaseUrl` descriptor parameter still awaits one.
* Concurrent initialize has a conflict rule. Authority: Workspace, Filesystem standards.
## Open gaps
- `seedWorkspacePresets` writes Agents/Channels/Messages/Modules/Settings tables owned elsewhere with per-row try/catch — partial-seed visibility and retry ownership are unverified.
- `describeWorkspaceDatabaseUrl`'s `schemaReady` parameter still has no writer; the create 201 payload fields (WS-006) are the surfaced readiness, but the descriptor-metadata surface (`metadata.database.schemaReady`) may stay stale for consumers reading it.
- Concurrent `initialize` can race the workspace-row ensure-insert (no `onConflictDoNothing` there, unlike every other write path).
- `WorkspaceManager` has no verified production callers — whether it is retired, test-only, or a future path is unverified.
- DB-002 fixed 2026-10-07: db:check roundtrip probe now ensures the workspaces row id 'default' insert-if-missing (ON CONFLICT DO NOTHING) before inserting channel/message rows (check.ts:20-33, called at :37), removing the FK violation on fresh DBs. Guarded by src/db/check-workspace-ensure.test.ts (hermetic write-shape; live idempotency DB-gated on DATABASE_URL).
- SYNC-1 auto schema sync (2026-10-08): binding a database (PATCH databaseUrl) converges its schema inline under the provision lock and reports `schemaReady`/`schemaError` on the response without blocking the bind; POST db-sync `sync-now` retries a failed provision before draining; GET db-sync exposes `schemaReady`/`schemaMissing` via a cached information_schema probe (`checkWorkspaceSchemaReady`, 60s TTL, honest null when unresolvable).

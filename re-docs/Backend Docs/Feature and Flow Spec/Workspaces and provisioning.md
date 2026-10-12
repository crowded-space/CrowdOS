# Workspaces and provisioning

> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent

Each workspace needs its own data plane — its own Postgres database, its own sandbox directory, its own screenlock — while unconfigured workspaces keep behaving exactly as before. This feature exists so workspace identity, database routing, and provisioning stay coherent: a local registry decides which database serves each request, new databases are validated and migrated before they go live, and secrets never leak into logs or API output.

## Architectural decision

The workspace record is the primary routing source, with that workspace's `CROWDOS_WS_<ID>_DATABASE_URL` process/`.env` value as a legacy fallback. The process-wide `DATABASE_URL` remains an unscoped pool and is never a tenant fallback; a workspace with no assigned URL stays local even when it is set `[Observed]` (`workspace-registry.ts:288-306`, `workspace-database-runtime.ts:122-130`, `shared/config/database.ts:363-366`). The live create path runs through routes plus registry plus `getWorkspaceDb`, while `WorkspaceManager` lifecycle/mount semantics are gone entirely (deleted 2026-09-14) `[Observed]`. File writes that carry secrets (registry, `.env`) are serialized through in-process promise chains with atomic tmp-rename for `.env`, because this is a single-user desktop where concurrent saves must not interleave `[Observed]`. Pools are per-workspace with LRU plus idle eviction and URL-hash rotation, so hand-edits apply without restart and stale pools never serve `[Observed]`. Provision applies migrations only and seeding is a separate explicit idempotent step, so schema and data failures stay distinguishable `[Observed]`. Screenlock hashes live registry-first with best-effort DB sync and crypto owned elsewhere (Auth/Pin), so lock writes survive DB outages and hashes never leave the server `[Observed]`.

## How it works

Workspace identity starts in `workspaces.json`, resolved via `CROWDOS_WORKSPACE_REGISTRY_FILE`, then `CROWDOS_DATA_DIR`/`WORKSPACE_DIR`, then `<cwd>/sandbox` (`workspace-registry.ts:44`). The live create path (`POST /api/workspaces`) validates URL shape, probes with `select 1`, provisions migrations under a per-target-DB lock, saves the registry record first so `getWorkspaceDb(id)` resolves the new pool, bounded-mkdirs the sandbox, seeds presets, and mirrors a `workspaces` row (`routes/workspace.ts:111-184`). Per request, the tenant hook reads `x-workspace-id`, resolves `getWorkspaceDb` using the same effective workspace URL selection as `tierContextFor` (cached pool on URL-hash hit, close-and-reopen on URL change, idle then LRU eviction past the cap), and fails closed with 503 `WORKSPACE_DB_OFFLINE` except on management paths, which degrade so the portal stays usable. Sweeps fan out via `forEachWorkspaceDb` over registry records with a record or matching per-workspace env URL, serially with per-target best-effort catch and handle dedupe; the process-wide pool is not a tenant target. Provisioning runs drizzle migrations over a short-lived connection with redacted errors; `resetWorkspaceDatabase` drops all CrowdOS tables with no dry-run. Screenlock writes validate `4..128` chars, require current-PIN proof when a hash exists, persist to the registry, and sync best-effort to the DB; reads go registry-first, DB-second. On first use, filesystem `initialize` creates the physical root, mkdirs the seven standard sectors, and writes `/.crowdos/workspace.json` when missing — no DB access (`local-filesystem.ts:30-59`).

## Components involved

| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Workspace.md> | Owns registry CRUD, BYODB validate/probe/provision/seed/reset, pooled per-DB routing with `getWorkspaceDb`/`forEachWorkspaceDb`, workspace-row PIN hash store, and the frozen manager lifecycle |
| <../Domain Spec/Filesystem.md> | Owns standard-sector bootstrap on `initialize`; touches no table |
| <../Domain Spec/Pin.md> | Owns screenlock crypto and request gating (`hashScreenLockPin`, `validateScreenLockPin`, global `LOCAL_PIN` proof); Workspace only stores the resulting hashes |

## Current state

Real: registry-first routing with a matching per-workspace `.env` fallback and no global tenant fallback, serialized registry/`.env` writes, pooled routing with LRU plus idle eviction and hash rotation, serial best-effort fan-out, migration-only provision under a per-DB lock with redacted errors, idempotent preset seeding, registry-first PIN store exposing only `screenLockEnabled`. Deleted legacy: the `WorkspaceManager` create/status/mount/event class and the `permission-guard.ts` asserts were removed 2026-09-14; the gate is a registry+routing facade. Flags: `CROWDOS_WORKSPACE_REGISTRY_FILE`, `CROWDOS_DATA_DIR`/`WORKSPACE_DIR`, `CROWDOS_WS_ENV_FILE`, `CROWDOS_WS_DB_MAX_POOLS` (10), `CROWDOS_WS_DB_IDLE_MS` (10min), `CROWDOS_WS_<ID>_DATABASE_URL`.

## Alignment notes

- 2026-09-16 C3 slice 1 (local-first §17-18): `POST /api/workspaces` DB-optional — empty `databaseUrl` creates a registry-only workspace (sandbox mkdir, no probe/provision/seed); tenant hook lets registry-only workspaces through without `x-workspace-id` DB handle instead of 503. PG-backed chat/history/RAG still degrade honestly downstream; full local channels/messages is the next slice.
- 2026-09-16 C3 slice 2: registry-only create now seeds local defaults (General category + #general + default-assistant) so the workspace is immediately chattable; `resolveWorkspaceMount`/`attachWorkspaceMount` use the registry record when no DB.
- 2026-09-17 dual-boot: `storagePreference` (Default dual-write / Local-first) + `dbSync` pairing state on the record; `PATCH` persists preference and evaluates pairing on attach (pair/import/push/converge/conflict); `GET|POST db-sync` serves status + resolve/sync-now/rebuild-rag; outbox drain runs every 30s inline. Proven live: no-DB boot → Portal create → chat turn over socket with gap-free local seqs.
- 2026-09-20 local-wins: converge is a local→PG push (no union/resequence); roster push/pull are per-workspace slices (`agents.workspace_id`, 0018).
- 2026-09-20 tenant routing: runtime never uses process-wide env `DATABASE_URL` as a workspace URL; `getWorkspaceDb` throws `NO_DATABASE` rather than returning the global pool when no workspace URL is assigned. Per-workspace `CROWDOS_WS_<ID>_DATABASE_URL` values remain a legacy fallback, distinct from global `DATABASE_URL`. Server loads `<cwd>/.env` for its config and warns on sibling dotenv mismatch.
- 2026-10-09 storage-mode alignment: `tierContextFor` now uses the same registry-first, per-workspace-env-second URL precedence as `getWorkspaceDb`; `forEachWorkspaceDb` also includes configured per-workspace env URLs. A blank record with no matching key stays local even if process-wide `DATABASE_URL` is configured. This fixes the confirmed tier/handle disagreement without changing the global pool used by unscoped `getDb()` or CLI/migration callers.
- Sector count: corrected. `Filesystem.md` now states seven paths (`/src`, `/artifacts`, `/agents`, `/.crowdos`, `/.crowdos/runtime`, `/.crowdos/cache`, `/.crowdos/snapshots`, `local-filesystem.ts:43-60`).
- Otherwise cross-checked `Workspace.md` against current code: registry-first then per-workspace env URL resolution (`workspace-database-runtime.ts:122-130`), no global tenant fallback, serialized writes, missing-registry `[]`, `.env` atomic rename, secret redaction, pool rotation/eviction, and registry-first PIN ordering. The former “global fallback” statements were drift and are resolved above. (The `workspace-manager.ts` edges this line used to cite were deleted; that check is retired.)

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Registry-first workspace routing with a per-workspace env fallback stays; process-wide `DATABASE_URL` is not a tenant fallback. Serialized writes plus pooled rotation plus redacted provisioning stay.
* Seed status is explicit: provisioned, seeded, degraded with retry owner. Manager legacy is explicitly labeled.
* Two listWorkspaces shapes have distinct names. RegisterArtifactInput and Artifact have backing functions or are removed. Authority: Workspace standard.
## Open gaps

- `WorkspaceManager` has no verified production callers — whether it is retired, test-only, or a future path is unverified (`Workspace.md` Gaps).
- `RegisterArtifactInput`/`Artifact` are exported with no backing register/list function; the artifact write path was not found.
- Two `listWorkspaces` shapes share one name (registry descriptors vs manager search/limit/offset) — caller-confusion risk.
- `seedWorkspacePresets` writes Agents/Channels/Messages/Modules/Settings tables owned elsewhere with per-row try/catch — partial-seed visibility and retry ownership unverified.
- `resetWorkspaceDatabase` drop-list is hardcoded; coverage against the current migration journal was not diffed.
- `describeWorkspaceDatabaseUrl` defaults `schemaReady=false`; which writer flips it to ready after provisioning was not found.
- Filesystem `initialize` no longer touches the DB, so the old concurrent workspace-row ensure-insert race is gone. `routes/filesystem.ts` still resolves its root from the registry row rather than the mount chain — see `Filesystem.md` Gaps.
- SYNC-1 (2026-10-08): a reachable-but-stale workspace schema (e.g. drifted-baseline `Nightly` missing core tables) no longer 500s reads — tenant paths degrade to local via `isSchemaMismatchError`, and the bind/sync-now paths converge the schema automatically. A full baseline-drift repair (backfill migration) is still open.

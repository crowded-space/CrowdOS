# Workspace Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: packages/server/src/workspace (8 production files, 5 test files), facade workspace-gate.ts, all call sites (create-app, routes, sweeps, artifacts, sockets, shared), persistence (workspaces.json registry, per-folder mirrors, vfs/.crowdos runtime object, per-workspace Postgres pools, .env managed keys), docs (re-docs/Backend Docs/Domain Spec/Workspace.md).
Method: full reads of every domain file and test, ripgrep call-site census, schema + migration inspection, baseline commands (vitest, tsc, check-gates). No production edits; only audit/ writes. Branch stays main.

## 1. Domain files (all read)

| File | Role |
| --- | --- |
| workspace-gate.ts | Facade: pure re-export of 60 runtime symbols + 21 types from 6 internals |
| workspace-registry.ts | workspaces.json store: path resolution, serialized writes, record CRUD, descriptors, folder-copy mirror, sandbox base |
| workspace-paths.ts | Canon path layer: folder-name sanitize, vfs/.crowdos/agents/src/artifacts resolution, artifact-dir normalization |
| workspace-runtime.ts | vfs/.crowdos/workspace.json read/write/normalize (permissions, constraints, artifactDir, fsMounts) |
| workspace-pin.ts | Screenlock hash store: registry-first load, status/get/set/clear, current-PIN proof, hash-stripping sanitize |
| workspace-database.ts | BYODB: URL validate/describe, env-file resolve, .env upsert/remove, probe, provision, seed, reset, provision lock |
| workspace-database-runtime.ts | Pooled per-workspace Postgres: LRU cap, idle eviction, URL-hash rotation, fan-out |
| workspace-types.ts | Legacy sandbox types (Workspace/status/scope/inputs) — mostly unused by current registry path |

Tests: workspace-canon.test.ts, workspace-database.test.ts, workspace-database-runtime.test.ts, workspace-database-routes.test.ts, workspace-pin.test.ts (51 tests, all pass).

## 2. Facade surface (workspace-gate.ts — exact)

Routing/pools: getWorkspaceDb, closeWorkspaceDatabase, closeAllWorkspaceDatabases, getWorkspaceDbPoolStats, forEachWorkspaceDb.
BYODB: parseWorkspaceDatabaseUrl, describeWorkspaceDatabaseUrl, testWorkspaceDatabaseConnection, provisionWorkspaceDatabase (+ alias provisionWorkspaceDatabaseSchema), withProvisionLock, seedWorkspacePresets, resetWorkspaceDatabase, upsertWorkspaceDatabaseEnv, removeWorkspaceDatabaseEnv, resolveWorkspaceEnvFilePath.
Registry: listWorkspaces, listWorkspaceRecords, getWorkspaceRecord, getWorkspaceDescriptor, saveWorkspaceRecord, removeWorkspaceRecord, tierContextFor, resolveSandboxBase, resolveWorkspaceLocalRoot, resolveWorkspaceFolder, resolveRecordFolderName, resolveRecordArtifactDir, writeWorkspaceFolderCopy.
Paths: DEFAULT_ARTIFACT_DIR, normalizeArtifactDir, resolveAgentsDir, resolveArtifactsDir, resolveCrowdosDir, resolveSrcDir, resolveVfsDir, resolveWorkspaceFolderPath, sanitizeWorkspaceFolderName, toFolderRelative.
Runtime: defaultWorkspaceRuntimeConfig, readWorkspaceRuntimeConfig, writeWorkspaceRuntimeConfig.
Pin: getScreenLockStatus, getWorkspacePinHash, setScreenLockPin, clearScreenLockPin, sanitizeWorkspace.
Types: WorkspaceStatus, WorkspaceScope, WorkspacePermissions, RuntimeConstraints, FilesystemPermissions, Workspace, CreateWorkspaceInput, MountAgentInput, ScreenLockStatus, WorkspaceRecord, WorkspaceDescriptor, StoragePreference, DbSyncState, DbSyncInfo, WorkspaceRuntimeConfig, WorkspacePermissions (alias WorkspaceRuntimePermissions), RuntimeConstraints (alias WorkspaceRuntimeConstraints), WorkspaceFsMount, WorkspaceFsMounts.

Not on the gate (internal-only, correct): setRegistryFilePathForTests, sanitizeWorkspaceRecord, resolveRegistryFilePath, workspaceDatabaseEnvKey, readWorkspaceDatabaseUrl, clearWorkspaceEnvCache, isCurrentPinAccepted (exported from workspace-pin.ts but unused anywhere — see WS-012), __resetWorkspaceDbPoolsForTests, defaultWorkspaceRuntimeConfig is exported but 0 external callers.

## 3. Dependency map (Caller -> Facade -> Impl -> Externals + side effects)

create-app.ts (tenant hook onRequest)
  -> getWorkspaceDb/getWorkspaceRecord/listWorkspaceRecords/getWorkspacePinHash/resolveRecordFolderName/resolveWorkspaceFolderPath
  -> workspace-database-runtime -> postgres (pool per ws, lazy connect), workspace-registry -> workspaces.json read
  side effects: request.db / ALS runWithDb; 503 fail-closed for DB-required paths; 25s watchdog; boot bootstrapWorkspaces mkdir vfs sectors via Filesystem domain.

routes/workspace.ts (all /api/workspaces* + settings/budget)
  -> 22 gate ports (registry CRUD, probe/provision/seed/reset, pool close, pin, paths)
  side effects: registry writes, folder rename/mkdir/rm, DB migrate/seed/reset, pairing (shared/core/workspace-sync), workspaces row mirror, .env untouched in current flow.

Sweeps: runs/orphan-sweep.ts:110, approvals/approval-sweeper.ts:12, agents/agent-service.ts:644,654, memories/memory-lifecycle.ts:231, shared/core/token-tracker.ts:239 -> forEachWorkspaceDb -> per-ws pools (serial, best-effort).

Others: artifacts/artifacts-repository.ts (getWorkspaceRecord/resolveArtifactsDir/resolveRecordArtifactDir/resolveWorkspaceFolder/toFolderRelative), channel-mounts/channel-mount-service.ts (getWorkspaceRecord/resolveSandboxBase/resolveWorkspaceLocalRoot/read+writeWorkspaceRuntimeConfig/saveWorkspaceRecord), messages/channel/module services + observability + local-mode-guard + database.ts dbForWorkspace (tierContextFor/getWorkspaceDb), shared/sockets/register-socket-server.ts (listWorkspaceRecords/getWorkspaceDb/getWorkspaceRecord), tools/tool-registry.ts (resolveWorkspaceLocalRoot), shared/core/workspace-sync.ts (close/get/list/save/getRecord/tierContextFor + DbSyncState).

Cycles: none observed. Hidden global state: recordCache (60s), envPathCache (60s), pools Map, provisionLocks Map, writeChain/envWriteChain. Global-pool leakage: workspace-pin.ts loadHash/set/clear fall back to ambient getDb() (ALS-aware; outside request scope this is the global pool).

## 4. Entry points

REST (routes/workspace.ts): GET/POST /api/workspaces; GET/PATCH/DELETE /api/workspaces/:id; POST /api/workspaces/database/test; GET/POST/DELETE /api/workspaces/:id/screen-lock; GET/POST /api/workspaces/:id/db-sync; GET/PUT /api/workspace/settings; GET/PUT/POST /api/workspace/budget[/reset]; POST /api/workspace/database (legacy hot-reload, admin token).
Boot: create-app.ts buildServer (tenant hook, PIN resolver wiring, bootstrapWorkspaces), index.ts, desktop embedded-backend.ts.
Socket: register-socket-server.ts (workspace rooms, snapshot fan-out, workspace record lookups).
Timers: outbox drain interval (create-app.ts, 30s) -> workspace-sync.drainOutbox.
CLI/tools: read_workspace_local tool -> resolveWorkspaceLocalRoot.

## 5. Persistence / state

- <registryDir>/workspaces.json (global index; CROWDOS_WORKSPACE_REGISTRY_FILE / CROWDOS_DATA_DIR / WORKSPACE_DIR / cwd/sandbox).
- <sandboxBase>/<folderName>/workspace.json (mirror, rootPath "."), vfs/.crowdos/workspace.json (runtime object).
- Per-workspace Postgres pools (max 5 conns each, cap 10 pools, idle 10min, URL-hash rotation).
- .env CROWDOS_WS_<ID>_DATABASE_URL keys (write path currently unused by routes; registry holds databaseUrl).
- Tables owned elsewhere written here: workspaces (mirror + pin sync), and seed targets (categories/channels/messages/agents/instruction_modules/workspace_settings).

## 6. Auth / tenant

- Tenant: x-workspace-id header -> getWorkspaceDb; fail-closed 503 except isWorkspaceManagementPath (exact /api/workspaces, /api/workspaces/database/test, /^/api/workspaces/:id/screen-lock$/).
- PIN: pin-gate.ts requirePin (global LOCAL_PIN or per-workspace hash via resolver=getWorkspacePinHash), 15s pinEntries cache.
- No per-owner/tenant authorization inside the domain: any caller with a workspace id gets its record/pool (single-user local-first by design).

## 7. Config

CROWDOS_WORKSPACE_REGISTRY_FILE, CROWDOS_DATA_DIR, WORKSPACE_DIR, CROWDOS_WS_ENV_FILE, CROWDOS_WS_DB_MAX_POOLS, CROWDOS_WS_DB_IDLE_MS, CROWDOS_WS_<ID>_DATABASE_URL, LOCAL_PIN, ENABLE_DB_CONFIG_MUTATION + WORKSPACE_ADMIN_TOKEN (legacy route).

## 8. Gate/naming compliance

- Gate is thin (re-export only) — compliant. Domain folder lowercase 'workspace' predates the PascalCase folder rule (frozen; docs claim PascalCase on disk — drift, see WS-011).
- check-gates: 0 production violations; 3 allowlisted known violations (incl. routes/workspace.ts -> channels/channel-local-store.js); 46 test-only cross-domain findings incl. 4 importing workspace internals (channel-mount tests, Filesystem test, observability test, pin-gate.test).

## 9. Baseline (2026-10-06)

- npx vitest run src/workspace (packages/server): 5 files, 51 tests, 51 passed (~14s).
- npx tsc -p tsconfig.json --noEmit: exit 0.
- node scripts/check-gates.mjs: 0 violations; 46 test-only findings; 3 allowlisted known violations.
- Git: branch main, pre-existing dirty tree untouched; only audit/ written.

## 10. Known gaps carried into Phases 2-4

Registry fail-open on corrupt file; PIN cache invalidation missing; reset drop-list drift; conflict quarantine not enforced on live writes; create/patch rootPath unvalidated; dead ports; doc drift. See bug-ledger.csv (WS-001..WS-030) and test-gaps.md.


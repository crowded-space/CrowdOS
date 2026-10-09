# ChannelMounts Domain - Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: packages/server/src/channel-mounts/ (4 code files + 2 tests + 1 dead .ps1), facade channel-mount-gate.ts, transport routes/channel-mounts.ts + routes/filesystem.ts, callers (tools, coding-runtime, runs), persistence (channels/categories/workspaces + registry + runtime config), events, migrations, docs.
Method: full read of domain files and cross-domain importers; grep for bypasses; typecheck + focused vitest + gate lint (read-only). No production file modified; audit/ is the only write. Git: branch main, pre-existing dirty tree (unrelated files); nothing staged/committed.

## 1. Domain files

| File | Lines | Role |
| --- | --- | --- |
| channel-mount-gate.ts | 56 | Facade: 12 ports + 9 type re-exports; wire + re-export only (AGENTS.md compliant) |
| channel-mount-service.ts | 674 | All logic: jail, validate, 3 resolvers, effectiveRoot/scope, 3 attachers, browse, canon virtual mounts |
| channel-mount-types.ts | 132 | Pure types. ChannelMountRecord/CategoryMountRecord/FsBrowseEntry exported but unused; only WorkspaceMountRecord re-exported |
| channel-mount-gate.test.ts | 688 | Jail, validate, effectiveRoot, scope, panel/tool agreement, browse, attach, routes (local-first, no DATABASE_URL) |
| channel-mount-chain.test.ts | 228 | Canon virtual mount inherit/override chain (local-first) |
| pick-folder-win32.ps1 | 4.3KB | DEAD: route hard-410s (routes/channel-mounts.ts:36-38); no code references the file |

## 2. Facade surface (exact, channel-mount-gate.ts:40-56)

- resolve -> resolveChannelMount(channelId)
- resolveCategory -> resolveCategoryMount(categoryId)
- resolveWorkspace -> resolveWorkspaceMount(workspaceId)
- effectiveRoot -> resolveEffectiveRoot({workspaceId?, channelId?})
- effectiveMounts -> resolveEffectiveMounts({workspaceId?, channelId?})
- setEffectiveMounts({workspaceId?, channelId?, categoryId?, mounts, mode?})
- scope -> resolveMountScope({workspaceId?, channelId?})
- attachChannel(channelId, folderPath|null)
- attachCategory(categoryId, folderPath|null)
- attachWorkspace(workspaceId, folderPath|null)
- browse(targetPath?, workspaceId?) -> {path, parent, entries<=300, allowedRoots}
- validate(absPath, workspaceId?) -> {valid, resolved?, error?}
- allowedRoots(workspaceId?) -> string[]

Type re-exports (gate:28-38): EffectiveMounts, EffectiveRoot, FsMount, FsMountMode, FsMountScope, FsMounts, MountInfo, MountScope, WorkspaceMountRecord.
NOT re-exported: ChannelMountRecord, CategoryMountRecord, FsBrowseEntry (documented gap; unused).

## 3. Dependency map

Callers -> Facade -> Service -> Ports -> Adapters + side effects:

- routes/channel-mounts.ts:17-94 -> gate (browse/allowedRoots/resolve/attachChannel/resolveCategory/attachCategory/resolveWorkspace/attachWorkspace) -> service -> channelGate + workspace-gate + Filesystem gate -> local JSON store / PG rows. Side effects: writes channels.folderPath / categories.folderPath / workspaces.metadata.customMountPath or registry mountPath; emits channel:mount-updated / category:mount-updated / workspace:mount-updated via globalBroker (dynamic import, try/catch swallowed).
- routes/filesystem.ts:17-18 -> gate.scope on every Repo-panel request; MountScope type import. Side effect: none (read).
- tools/tool-registry.ts:146-147 resolveToolRoot -> gate.effectiveRoot (dynamic import to keep edge lazy); fallback Guard.getWorkspaceDir on throw. Consumers: read_file/write_file/edit_file/list_directory/delete_file/bash/safe-command cwd.
- runtime/runtimes/coding-runtime.ts:19-31 resolveRuntimeRoot -> gate.effectiveRoot; fallback Guard.getWorkspaceDir.
- runs/runs-service.ts:71-84 undoCompensation -> gate.effectiveRoot (channelId/workspaceId of run); fail-loud if no root.
- Filesystem/entry-visibility.test.ts:72 -> gate.browse (cross-domain test via gate: OK).
- Client: MountsInspector.tsx + FolderMountPicker.tsx -> apiClient (getChannelMount/getCategoryMount/getWorkspaceMount/getEffectiveMount/getAllowedRoots/setMount/browseFilesystem) -> REST above.

Gate-to-gate calls from service: channelGate (channels), workspace-gate (workspace), filesystem-gate (Filesystem). Shared exempt: shared/config/database (getDb/isDatabaseConfigured/isConnectionError), db/schema (channels/categories/workspaces tables), shared/core/ttl-cache, shared/core/local-file (transitively via gates).

## 4. Entry points

- REST: GET /api/fs/browse; GET /api/fs/allowed-roots; POST /api/fs/pick-folder (410); GET|PUT /api/channels/:id/mount; GET|PUT /api/categories/:id/mount; GET|PUT /api/workspaces/:id/mount; GET /api/workspace/mount + /api/workspace/files* (scope consumer). Registered at routes/index.ts:40,43; pinned by routes/index.test.ts:12-43.
- Sockets: none in-domain; route emits are fanned out by register-socket-server.ts:414-461 (room-scoped, workspace-namespaced).
- Worker/jobs/scheduler/CLI: none.
- UI: MountsInspector (reads all three levels + effective + jail; clear confirm), FolderMountPicker (browse + native desktop dialog via desktop-bridge, then setMount).
- Agents: tool-registry file tools + bash cwd; coding-runtime; runs undo. All via effectiveRoot.

## 5. Persistence / caches / config

- channels.folderPath (db/schema.ts:276-280); categories.folderPath (schema.ts:259-264); channels/categories.fs_mounts jsonb (schema.ts:264,280; migration 0021_channels_fs_mounts.sql:14-15).
- workspaces.metadata.customMountPath (PG tier; service:194,323-336); registry record.mountPath (local tier; workspace-registry.ts:73,298-325).
- Workspace runtime fsMounts in vfs/.crowdos/workspace.json (workspace-runtime.ts:142-147,169-189).
- Local rows: channels.json/categories.json (channel-local-store.ts; lock via mutateJsonArray).
- Caches: realpath TtlCache 60s/200 (service:23); workspace recordCache 60s/200 (workspace-registry.ts:28); local-file folderCache 2s (shared/core/local-file.ts:67).
- Config/env: WORKSPACE_DIR (sandbox base + default jail root), CROWDOS_DATA_DIR/CROWDOS_WORKSPACE_REGISTRY_FILE (registry path). No in-domain flag; ALLOWED_MOUNT_ROOTS removed.

## 6. Bypasses / violations / hidden deps

- Gate-rule lint: 0 production violations; channel-mounts TEST-ONLY findings (check-gates.mjs output): channel-local-mode.test.ts:25 imports channel-mount-service.js directly (cross-domain past gate); channel-mount-gate.test.ts:21,24,86 and channel-mount-chain.test.ts:13,15 import workspace-registry/workspace-runtime/tool-registry/routes internals.
- No cross-domain production import of service internals found; all production callers use the gate.
- Hidden coupling: FsMount/FsMounts descriptor defined 3x (channel-mount-types.ts:102-117, channel-local-store.ts:27-41, workspace-runtime.ts:42-54) with different normalizers (workspace-runtime drops mounts missing id, service does not).
- Global state: module-level realpath cache (service:23) and registry recordCache; both process-lifetime, not cross-process (documented).
- No import cycles observed (tools/runtime/runs use dynamic import for the edge; comment says to avoid a cycle).

## 7. Tests present

channel-mount-gate.test.ts (45 tests): jail default/record/blank/env-ignored; validate (empty/null-byte/missing/file/outside/vfs marker/plain-vfs sibling); effectiveRoot fallbacks+reason; scope; panel/tool agreement; browse (sort/dotfiles/clamp/missing/parent); attach (workspace local write/clear/refuse; channel/category round-trip); routes (allowed-roots, browse, 410, workspace mount GET/PUT, channel PUT).
channel-mount-chain.test.ts (10 tests): workspace default, category override, channel override, inherit skip, phantom drop, none, setEffectiveMounts workspace/channel/category, missing channel refusal.
Adjacent: routes/index.test.ts:12-43 (registration pin), Filesystem/entry-visibility.test.ts, channels/channel-local-mode.test.ts:110-124 (uses service directly).
All run local-first (no DATABASE_URL); PG branches untested.

## 8. Flags for Phase 2+

- Workspace mount has TWO storage tiers with no sync/migration between them (CM-001).
- Jail read failure falls back to the WIDE default (sandbox+home) rather than failing closed (CM-002).
- No tenant/ownership check that a route id belongs to the caller's workspace (CM-003).


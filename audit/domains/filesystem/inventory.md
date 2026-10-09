# Filesystem Domain — Inventory (READ-ONLY audit, Phases 1–4, time-boxed)

Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd
Domain: packages/server/src/Filesystem · Facade: filesystem-gate.ts · Branch: main (dirty pre-existing; no edits made, audit/ only)

## Files
| File | Lines | Role |
|---|---|---|
| filesystem-gate.ts | 25 | Thin facade: re-exports class/helpers/types + `filesystemGate` object |
| local-filesystem.ts | 197 | LocalFilesystem: disk I/O, sector bootstrap, onEvent callbacks |
| path-guard.ts | 180 | normalize/safety/containment/realpath resolution/mime |
| entry-visibility.ts | 28 | One listing rule: REPO_MARKER_NAMES + isVisibleEntryName |
| filesystem-types.ts | 22 | FileNode / FileStat contracts |
| index.ts | 1 | Dead barrel (re-exports gate; zero importers found) |
| entry-visibility.test.ts | 157 | 8 tests: rule + tree/picker agreement |

## Exports (exact, filesystem-gate.ts:15-27)
- Named: `LocalFilesystem`, `normalizePath`, `isPathSafe`, `isInsideRoot`, `resolveWorkspacePath`, `extractName`, `guessMimeType`, `isVisibleEntryName`, `REPO_MARKER_NAMES`.
- Types: `FileNode`, `FileStat`, `LocalFilesystemOptions`.
- Object: `filesystemGate` { createLocalFilesystem, normalizePath, isPathSafe, isInsideRoot, resolveWorkspacePath, extractName, guessMimeType, isVisibleEntryName }.

## Importer map (caller → facade → service → effect)
| Caller (file:line) | Facade port | Effect |
|---|---|---|
| routes/filesystem.ts:4,21-27 | LocalFilesystem (new) | per-request instance; list/read/write/delete via routes |
| create-app.ts:25,68,85 | LocalFilesystem (new) | boot bootstrap: 4-wide initialize per workspace + default |
| db/create-workspace-crowdos.ts:3,46 | LocalFilesystem (new) | seed script initialize |
| routes/workspace.ts:35,56,522 | isInsideRoot | rename/delete sandbox containment |
| tools/safety/guard.ts:3,152 | isInsideRoot | Guard.isInsideRoot shared impl (5s own root cache) |
| channel-mounts/channel-mount-service.ts:10,507-510 | isVisibleEntryName | mount picker listing rule |
| tools/tool-registry.ts:1349-1373 | isVisibleEntryName (dynamic) | workspace-local list tool |
| runtime/runtime-lifecycle.test.ts:25,555-560 | filesystemGate | facade-shape smoke test |
| workspace/workspace-database-routes.test.ts:59 | mocked gate | route test double |

## Routes (routes/filesystem.ts)
- GET /api/workspace/mount:17-86 (scope via channelMountGate.scope; 500 on error)
- GET /api/workspace/files:90-123 (root listing carries scope; ENOENT → 404 with root path)
- GET /api/workspace/files/content:126-149 (400 for "/" ; 404 ENOENT)
- POST /api/workspace/files/content:151-166 (write; all errors → 500)
- DELETE /api/workspace/files:168-192 (400 for "/" ; 404 ENOENT)

## Persistence / events / jobs / config
- Persistence: NONE. No table touched (schema.ts:503 confirms workspace_nodes/workspace_events dropped by migration 0019).
- Events: plain onEvent callbacks only — file.updated/deleted/renamed (local-filesystem.ts:123,141,153). No subscriber anywhere (grep onEvent: only domain internals).
- Jobs: none; bootstrap is a fire-and-forget start() task (create-app.ts:316-330, M5 listen-first).
- Flags: none in-domain. Adjacent: SYSTEM_ACTOR_ID (routes/filesystem.ts:24), WORKSPACE_DIR (bootstrap + tests), LEGACY_GUARD (Tools).

## Execution trace (representative)
GET /api/workspace/files → resolveScope(channelMountGate) → filesystemFor → new LocalFilesystem → list() → resolve() → resolveWorkspacePath (isPathSafe → rootRealCache(60s) → fast realpath | ancestor walk → isInsideRoot) → readdir → isVisibleEntryName filter → 32-wide stat batches → sort → route wraps scope for "/".
POST content → write() → resolve → mkdir parent → writeFile → onEvent("file.updated").
DELETE → delete() → resolve → stat (throws ENOENT) → rm/unlink → onEvent("file.deleted").

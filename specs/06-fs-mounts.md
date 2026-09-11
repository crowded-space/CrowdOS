# SPEC 6 — Drop VFS Mirror, Mount Real FS (Guard Jail Kept)

## 1. Goal & Non-Goals

### Goal
Delete the PostgreSQL mirror of the filesystem (`workspace_nodes` + all sync-on-write logic in `LocalVFS`). After this spec a workspace **is** a local directory on disk — ideally an actual local repo checkout passed in at creation time — accessed directly via `node:fs`. The only filesystem safety boundary that survives is the **Guard jail**: anchored containment (`isInsideRoot` + `realpath` deep resolution) + sensitive-file blacklist. Every read/write/exec path must resolve through the Guard against the workspace's **per-mount root**.

### Non-goals
- No new sandboxing (no containers, no chroot, no user-namespaces, no FUSE).
- No new indexing/caching/search layer to replace `workspace_nodes` queries — callers use `readdir`/`stat` directly.
- No change to command policy (`Guard.evaluateCommand`, `execHardened` env filtering, timeouts). Only path containment is in scope.
- No change to `workspaces`, `workspace_events`, `workspace_agents`, `artifacts`, `runs` / `runs_compensation` tables (except deleting the `workspace_nodes` table and its relations).
- No multi-root workspaces (one `rootPath` per workspace row). Symlink-following and mount-point policy stays "resolve realpath, reject escape" as today.

### What "mirror deleted, Guard stays" means concretely
| Deleted | Kept |
|---|---|
| `workspace_nodes` table, unique index `workspace_nodes_ws_path_idx`, enum `workspace_node_type`, Drizzle `workspaceNodes` + relations | `workspaces.rootPath` as the mount pointer |
| All `db.query.workspaceNodes` / `db.insert/update/delete(workspaceNodes)` in `vfs/local-vfs.ts` | `vfs/path-guard.ts`: `normalizePath`, `isPathSafe`, `isInsideRoot`, `resolveRealDeep`, `resolveWorkspacePath`, `extractName`, `guessMimeType` |
| `LocalVFS.write/mkdir/delete/rename` DB sync + `stat.checksum/createdBy` DB lookup + `listCache` + `onEvent file.*` auto-emit | `tools/safety/Guard.ts`: `getWorkspaceDir`, `isInsideRoot`, `resolveRealDeep`, `validatePath` (+ blacklist), `legacyValidatePath` behind `LEGACY_GUARD` |
| `LocalVFS.initialize()` sector/node seeding; `index.ts` per-workspace `initialize()` boot loop; `db/create-workspace-crowdos.ts` VFS init | `Guard.validatePath` call sites in `toolRegistry.ts`, `CodingRuntime.ts`, `runsGate.ts` (adapted to per-mount roots, see §3.4) |
| `.crowdos/` node rows | `.crowdos/` on disk only if explicitly retained (see §3.2 recommendation: delete) |

---

## 2. Current State (Verified, with `file:line`)

### 2.1 `LocalVFS` — thin mirror: reads hit disk, writes hit disk + DB

File: `packages/server/src/vfs/local-vfs.ts` (396 lines).

- Options: `LocalVFSOptions` — `workspaceId`, `workspaceRoot`, `actorId`, `onEvent?` (`16-21`). List cache: shared `TtlCache<FileNode[]>(10_000, 300)` (`28`; comment bounds staleness for out-of-band disk changes e.g. bash tools `23-27`). Invalidated on every mutation (`113-115`). `computeChecksum` — `sha256(content, utf8)` (`117-119`).

**Read paths (disk-only, no DB):**

- `read(path)` (`121-134`): `resolve` → `fs.stat` → if `> 1_048_576` bytes read first 1MB + append `[TRUNCATED: …]`; else `fs.readFile(absPath, "utf8")`.
- `readBinary(path)` (`136-149`): same 1MB cap, returns `Buffer.subarray`.
- `list(path)` (`316-356`): `normalizePath` → cache lookup → `fs.readdir(absPath, {withFileTypes:true})` → **filter out `.crowdos`** (`326`) → bounded stat concurrency 32 (comment cites prior unbounded `Promise.all` → `EMFILE`) → dirs-first + alpha sort → cache set.
- `exists(path)` (`387-395`): `resolve` + `fs.access`, no DB.
- `stat(path)` (`358-385`): **hybrid** — `type/size/mime` from `fs.stat`, but `checksum/createdAt/updatedAt/createdBy/updatedBy` from `workspaceNodes` row if present, else `birthtime/mtime/"unknown"`. DB lookup at `365-371`.

**Write paths (disk FIRST, then DB upsert + event):**

- `write(path, content)` (`151-209`): `resolve` → `fs.mkdir(parent, recursive)` → `fs.writeFile` → invalidate → `findFirst(workspaceId+path)` → update + `onEvent("file.updated")`, else insert + `onEvent("file.created")`.
- `mkdir(path)` (`211-246`): `fs.mkdir` → invalidate → insert directory row if missing. No event.
- `delete(path)` (`248-276`): `fs.stat` → dir ? `fs.rm(recursive, force)` : `fs.unlink` → invalidate → delete row (comment notes cascade removes children — but there is no FK parent/child; **children rows are orphaned**) → `onEvent("file.deleted")`.
- `rename(old,new)` (`278-314`): `mkdir(newParent)` → `fs.rename` → invalidate → update single row + `onEvent("file.renamed")`. Descendant rows under a renamed directory are **not** rewritten (stale-path bug).

**`initialize()` — workspace row + sectors + `workspace.json` (`43-106`):**

1. `findFirst(workspaces.id)`; if missing, insert row (`status:"ACTIVE"`, normalized `rootPath`, defaults).
2. `fs.mkdir(workspaceRoot, recursive)`.
3. `standardDirs = ["/src","/artifacts","/agents","/.crowdos","/.crowdos/runtime","/.crowdos/cache","/.crowdos/snapshots"]` each via `this.mkdir` (so each also inserts a `workspaceNodes` directory row).
4. `wsJsonPath = "/.crowdos/workspace.json"`; if missing → `write` with `{id, name, createdAt, permissions, constraints}` — which itself inserts a file row.

Interface: `vfs/vfs.interface.ts:25-36` (`VirtualFS`: `read/readBinary/write/mkdir/delete/rename/list/stat/exists/initialize`). Facade: `vfs/vfsGate.ts:1-15`. Gate-facade test asserts the shape at `runtime/runtimeLifecycle.test.ts:549-553`.

### 2.2 `workspace_nodes` schema + unique constraint (only consumer is `LocalVFS`)

- Definition `db/schema.ts:474-490`: `workspaceNodes` (`workspaceId FK cascade`, `path`, `name`, `type: file|directory`, `mimeType`, `size`, `checksum`, `createdBy`, `updatedBy`, `metadata`) with unique `workspace_nodes_ws_path_idx` on `(workspaceId,path)` (`489`).
- Enum `workspaceNodeTypeEnum` at `schema.ts:42`; TS type `WorkspaceNode` at `Workspace/workspaceTypes.ts:40-54`.
- Relations: `workspacesRelations.nodes` (`796-801`), `workspaceNodesRelations.workspace` (`803-808`).
- Legacy DDL duplicates it: `db/bootstrap.ts:80-94` + unique index (`476`); baseline migration `0000_baseline.sql:401` + FK (`474`).
- **Only runtime readers/writers are `local-vfs.ts`** (grep `workspaceNodes` returns hits only in `local-vfs.ts` + `schema.ts`). No route, tool, runtime, or search path queries `workspace_nodes` directly. `query_database` allowlist excludes it, so agents cannot SQL-read it either.
- Consequence: dropping the table touches exactly one runtime file plus schema/migrations/bootstrap. Stale-row hazards (orphaned children on dir delete, stale descendants on rename, `stat` fallbacks) disappear with the table.

### 2.3 `.crowdos` layout + consumers

- Created only by `local-vfs.ts:80-88` and `local-vfs.ts:94-105` (`/.crowdos/workspace.json` = `{id, name, createdAt, permissions, constraints}`).
- Hidden only by `local-vfs.ts:326` in `list()`. `read/stat/exists` do **not** filter it; raw-fs tools never filter it.
- Grep `\.crowdos|workspace\.json` returns hits **only** in `local-vfs.ts`. No runtime, route, tool, migration, seed, or socket file reads `.crowdos/workspace.json`, `runtime/`, `cache/`, or `snapshots/`. It is write-only scaffolding today.
- Recommendation (see §3.2): **delete it** — do not create `.crowdos/` in mounted repos (it dirties `git status` for every user repo and has zero readers).

### 2.4 Guard API + all `validatePath` / `getWorkspaceDir` call sites

**`vfs/path-guard.ts` (VFS-internal, POSIX-oriented):**

- `normalizePath`: backslash→slash, `posix.normalize`, strip leading/trailing slashes.
- `isPathSafe`: reject `..`-escape, null bytes, drive-letter absolutes (single leading `/` tolerated).
- `isInsideRoot(candidate, root)`: slash-normalize, strip trailing `/`, **lowercase both sides on `win32`**, anchored `c===r || c.startsWith(r+"/")`.
- `resolveRealDeep(target)`: `realpathSync(target)`; on `ENOENT/ENOTDIR` walk up to deepest existing ancestor, `realpath` it, rejoin remaining segments.
- `resolveWorkspacePath(workspaceRoot, relativePath)`: `isPathSafe` gate → `realpathSync(workspaceRoot)` with lexical fallback → `posix.join` → `resolveRealDeep` → `isInsideRoot` else throw `Path traversal blocked`.
- `extractName`, `guessMimeType` (~19 extensions, else `null`).

**`tools/safety/Guard.ts` (the enforced jail — 402 lines):**

- `getWorkspaceDir(customRoot?)` (`100-114`): `customRoot`+exists → resolve; else `sandbox/<customRoot>`+exists → resolve; else `WORKSPACE_DIR` env → resolve; else **`process.cwd()`** (`113`). 5s `existsSync` cache.
- `isInsideRoot(candidate, root)` (`116-129`): same anchored semantics, lowercased on win32.
- `resolveRealDeep(target)` (`131-151`): same deepest-existing-ancestor algorithm.
- `validatePath(targetPath, workspaceRoot?)` (`153-188`): `root = getWorkspaceDir(workspaceRoot)` → `realpathSync(root)` → `resolve(rootReal, targetPath)` → `resolveRealDeep` → `isInsideRoot` else `Access Denied` → **blacklist**: `.env`/`.env.*`, `credentials.json`, `package-lock.json`, `.git` → `Access Denied: blacklist` → return `candidateReal`. Legacy prefix-only path behind `LEGACY_GUARD=true`.
- Command policy (`evaluateCommand`, `DENY_PATTERNS`, `ASK_PATTERNS`) is out of scope except that validation gates the two shell tools.

**All call sites (complete):**

| # | File:line | Call | Notes |
|---|---|---|---|
| 1 | `tools/toolRegistry.ts:204` | `Guard.validatePath(args.path, ctx?.workspaceId)` in `read_file` | `workspaceId` passed as root; resolves via `sandbox/<id>` or falls back to `cwd` — ambiguous, must become DB mount lookup (§3.4) |
| 2 | `tools/toolRegistry.ts:233` | `Guard.validatePath(args.path, ctx?.workspaceId)` in `write_file` (+ compensation, `mkdir`, `writeFile`) | Same ambiguity; compensation recorded |
| 3 | `tools/toolRegistry.ts:281` | `Guard.validatePath(relPath \|\| ".", ctx?.workspaceId)` in `list_directory` | Defaults to `"."` = root itself |
| 4 | `tools/toolRegistry.ts:314` | `Guard.validatePath(args.path, ctx?.workspaceId)` in `delete_file` (+ compensation, `fs.unlink`) | `unlink` only — deleting a directory via tool errors |
| 5 | `tools/toolRegistry.ts:363` | `Guard.getWorkspaceDir(ctx?.workspaceId)` as `cwd` for `execute_bash` | Shell inherits jail only via `cwd`; absolute-path args inside command are **not** path-validated |
| 6 | `tools/toolRegistry.ts:394` | `Guard.getWorkspaceDir(ctx?.workspaceId)` as `cwd` for `execute_safe` | Same |
| 7 | `runtime/runtimes/CodingRuntime.ts:201` | `Guard.validatePath(targetPath, packet.workspaceId)` in `write_file` override | Bypasses `ToolExecutor`; duplicates toolRegistry logic + adds hash/patch |
| 8 | `runtime/runtimes/CodingRuntime.ts:271` | `Guard.validatePath(targetPath, packet.workspaceId)` in `edit_file` override | Same bypass pattern |
| 9 | `Runs/runsGate.ts:72` | `Guard.validatePath(inverse.path, workspaceRoot)` in `undoCompensation` delete-branch | `workspaceRoot` from DB — already per-mount, the correct pattern |
| 10 | `Runs/runsGate.ts:75` | `Guard.validatePath(inverse.path, workspaceRoot)` in restore-branch | Same |

`Guard.getWorkspaceDir` env inputs: `WORKSPACE_DIR` schema at `Shared/config/env.ts:90`; `Guard.ts:105-112` consumes `process.cwd()/sandbox/<id>` and `WORKSPACE_DIR`.

### 2.5 Raw-`node:fs` bypass sites (already outside the mirror)

These never touch `workspaceNodes` today — they prove the mirror is already bypassed and define the guard-first pin list:

- `tools/toolRegistry.ts` (`read/write/readdir/unlink` + `execHardened` with `cwd=Guard.getWorkspaceDir`); `CodingRuntime.ts` (Guard-jailed raw fs in overrides); `Runs/runsGate.ts` (dynamic `node:fs/promises`, Guard-jailed undo); `Workspace/workspaceManager.ts:143` (`fs.rm` on delete — **unjailled, must change**: with real repo mounts this deletes the user's checkout); `Agents/agentSpawnManager.ts:429-431` (raw write, **no `Guard.validatePath`** — unjailled legacy path, gated by retired `SWARM_LEGACY`; must route through Guard or be deleted); `tools/safety/hardenedExec.ts` (`execHardened`: inherits whatever `cwd` the caller passes; no path validation of its own).

### 2.6 `routes/vfs.ts` (all four handlers go through `LocalVFS`)

File: `packages/server/src/routes/vfs.ts` (127 lines).

- `getDynamicVFS(workspaceId, actorId?)` (`11-23`): `select workspaces where id` → `null` if missing → `new LocalVFS({workspaceId, workspaceRoot: ws.rootPath, actorId})`.
- `GET /api/workspace/files` (list; `ENOENT` → `[]`), `GET /api/workspace/files/content` (read; reject `/`; `ENOENT` → 404), `POST /api/workspace/files/content` (write), `DELETE /api/workspace/files` (delete; reject `/`; `ENOENT` → 404).
- No Guard calls, no events, no compensation in this file. Zod schemas default `path:"/", workspaceId:"default"`.

### 2.7 `index.ts` bootstrap + other `initialize()` callers

- `index.ts:136-171` `bootstrapWorkspaces`: `select workspaces` → for each row `new LocalVFS(...).initialize()` → then hardcoded `default` VFS init; errors only logged. Called before `listen`.
- `WorkspaceManager.createWorkspace`: `rootPath = join(sandboxRoot, id)` → insert `CREATED` → `INITIALIZING` → `new LocalVFS(...)` + `initialize()` → `ACTIVE` → `emitEvent(workspace.created)`. Constructor takes `sandboxRoot`.
- `db/create-workspace-crowdos.ts` (`rootPath = join(cwd,"sandbox","crowdos")`, `new LocalVFS` + `initialize()`); `db/seed.ts` seeds `default` row with `rootPath = join(cwd,"sandbox","default")`; migration `0011` inserts `default` with literal `'sandbox/default'`.

---

## 3. Target Design

### 3.1 Mount model — `workspaces.rootPath` becomes a real repo path

- **Semantics:** `workspaces.rootPath` (still `text NOT NULL`) is the single source of truth for "where this workspace lives on disk". It may point at an existing local repo checkout (e.g. `C:\Repos\acme-web`) or a fresh empty dir the server creates. No `sandbox/<id>` derivation at runtime; no per-file DB rows.
- **Who configures it (recommendation):** `CreateWorkspaceInput` gains an **optional** `rootPath?: string`, validated and canonicalized server-side:
  1. Client sends `{name, rootPath?}` (absolute path or allowlist-relative). If omitted, server falls back to `WORKSPACE_DIR/<id>` or `cwd/sandbox/<id>` and `mkdir -p`s it — preserving today's behavior for tests and the `default` workspace.
  2. Server canonicalizes with `fs.realpath` (must exist and be a directory; otherwise 400), checks containment inside an allowlist (`WORKSPACE_MOUNT_ALLOWLIST`, new optional env, comma-separated absolute prefixes; unset = allow any absolute path on dev, but log a warn; production should set it), rejects blacklisted locations, then stores the canonical absolute path with forward slashes.
  3. Alternative considered and rejected: separate mount-table or symlink farm under `sandbox/` pointing at repos. Rejected — symlinks reintroduce the exact `resolveRealDeep` escape surface the jail exists to close, and double the path-resolution code. Store the real path directly.
- **Single-DB-spec handoff:** the `workspaces` row lifecycle is unchanged; only the `rootPath` value source changes.
- **Windows:** store canonical path after `realpathSync` (resolves `\\?\`, junctions, case variants). Never string-compare user input to `rootPath` — always compare `resolveRealDeep(candidate)` to `realpathSync(root)`.

### 3.2 What replaces `workspace_nodes` reads

| Old (DB) | New (disk) |
|---|---|
| `list()` from `readdir` + DB-free nodes (already disk; only drop cache/filter) | `fs.readdir(root, {withFileTypes:true})` + `fs.stat` per entry, keep bounded concurrency 32 and dirs-first sort. **Delete** the `TtlCache` — with no mirror there is no invalidation protocol; a 10s stale listing over a live repo checkout is a correctness bug (user edits in VS Code must appear immediately). If `readdir` on huge repos proves slow, add pagination/`limit` at the route, not a cache. |
| `stat()` checksum/actors from DB | `fs.stat` for `size/mtime/birthtime/type`; `mimeType` via kept `guessMimeType`; `checksum` **on demand only**: `sha256` of file content when caller asks (new `?checksum=true` query or dedicated `stat` util), capped at 1MB like `read()` — never precomputed for listings. `createdBy/updatedBy` fields are dropped from the API (no source left); return `"unknown"` or remove the keys (prefer remove — do not fake provenance). |
| `exists()` via `fs.access` | Unchanged (already disk). |
| `read()/readBinary()` 1MB truncation | Unchanged, moved into the new `WorkspaceFS` helper (see §4). |
| Unique `(workspaceId, path)` constraint | Gone. Duplicates are impossible on a real FS; concurrent writers get last-writer-wins + compensation history via `runs_compensation` (unchanged). |

**`.crowdos/workspace.json` — recommendation: delete the concept.**
Do not create `.crowdos/` in mounted repos (it dirties `git status` for every user repo and has zero readers). Workspace metadata already lives in the `workspaces` row. If a repo happens to contain `.crowdos/workspace.json`, tools may read it as an ordinary file through the Guard (no special-casing, still subject to listing — recommendation is **stop hiding it**; transparency over magic).

### 3.3 Filesystem access layer after the mirror (no more `LocalVFS` class)

- Delete `vfs/local-vfs.ts` entirely. Replace with a stateless `WorkspaceFS` (lives in `Workspace/` or `vfs/` — one file, ~120 lines) with pure functions taking an absolute mount root:
  `readFile(root, rel)`, `readBinary(root, rel)`, `writeFile(root, rel, content)`, `listDir(root, rel)`, `statPath(root, rel)`, `exists(root, rel)`, `deletePath(root, rel)`, `renamePath(root, oldRel, newRel)`.
  Each function: `abs = Guard.validatePath(rel, root)` (absolute-root overload, §3.4) → `node:fs` op → return. No DB, no cache, no events inside. `mkdir -p` parents on write. Keep 1MB read cap + truncation marker. Keep `guessMimeType`/`extractName`/`normalizePath` from `path-guard.ts` (move or re-export; delete the rest if `Guard.ts` becomes the single jail).
- `routes/vfs.ts` handlers keep their paths/signatures but resolve root via `workspaces.rootPath` per request and call `WorkspaceFS` instead of `LocalVFS`. `POST`/`DELETE` also record compensation when `runId` is present (parity with tool paths — currently the route path records **no** compensation, a gap this spec closes or explicitly documents as out of scope).
- `WorkspaceManager.getVFS` is deleted; callers needing the root call a new `getWorkspaceRoot(workspaceId): Promise<string>` (DB lookup + `realpath` + existence check, throw 404 if missing). `createWorkspace` stops constructing any VFS object: insert row → `mkdir(root, recursive)` → `ACTIVE` → `emitEvent(workspace.created)`. No sector seeding.

### 3.4 Guard adaptation — per-mount roots, no `cwd` fallback

This is the security core. Today's `Guard.getWorkspaceDir(customRoot?)` conflates *workspace id* with *path* and silently falls back to `process.cwd()`. Against real repo mounts that fallback is a host-FS-escape hatch.

Required changes to `tools/safety/Guard.ts`:

1. **New primary overload:** `validatePath(targetPath: string, absoluteRoot: string)` where `absoluteRoot` must already be absolute + canonical. Resolution: `rootReal = realpathSync(absoluteRoot)` (throw if root does not exist — fail closed, never fall back); `candidateReal = resolveRealDeep(resolve(rootReal, targetPath))`; `isInsideRoot` else throw; blacklist unchanged (keep `.env`/`.env.*`, `credentials.json`, `package-lock.json`, `.git` — note: with repo mounts, `.git` blocking now matters *more*, and `package-lock.json` blocking may annoy node repos; keep both for this spec, revisit blocklist in a follow-up with per-workspace overrides).
2. **Keep the old `(targetPath, workspaceIdOrUndefined)` overload only as a thin resolver** that maps id → `getWorkspaceRoot(id)` (async) or a sync cache pre-populated at request start. No `sandbox/<id>` probing, no `process.cwd()` fallback on the miss path — throw `workspace_context_required` / `Unknown workspace`.
3. **Update all 10 call sites:** `toolRegistry.ts` (6), `CodingRuntime.ts` (2), `runsGate.ts` (2) — each resolves `workspaceId` to the mount root first, then validates. `runsGate.ts` fabricated fallback (`join(cwd,"sandbox","default")`) is deleted; missing root → undo returns `{ok:false, error:"workspace root missing"}` instead of writing into a fabricated directory.
4. **Single jail implementation:** `vfs/path-guard.ts` and `Guard.ts` duplicate `isInsideRoot`/`resolveRealDeep` line-for-line. Keep `Guard.ts` as the canonical jail (it has the blacklist + tests). `path-guard.ts` helpers `normalizePath/extractName/guessMimeType` survive as pure string utilities (relocated next to `WorkspaceFS`); the duplicated jail functions are deleted to end the dual-jail drift.
5. **Shell tools:** `execute_bash`/`execute_safe` keep `cwd = mountRoot`. Document that in-command absolute paths (`cat /etc/passwd`) are **not** path-jailed — only the command *policy* constrains them. Closing that gap (cwd-jail via container) is explicitly out of scope.

### 3.5 Compensation / undo — unchanged shape, re-homed root

- `buildCompensationInverse` and `runs_compensation` table are **unchanged**.
- `runsGate.undoCompensation` keeps its logic but takes the root from `getWorkspaceRoot(run.workspaceId)` and the new `validatePath` overload. Truncation caveat (`priorContentRef` capped at 20k) is pre-existing and out of scope — undo of >20k files restores a prefix; document it in the undo API response.
- Recording points stay where they are and are added to `routes/vfs.ts` write/delete when a `runId` is supplied.

### 3.6 VFS event emissions replacement

- `LocalVFS.onEvent` (`file.created/updated/deleted/renamed`) → `getVFS` forwarder → `emitEvent` persisting `workspace_events` rows is **deleted with the class**.
- Replacement: the *mutation sites* emit directly. `write_file`/`delete_file` (toolRegistry + CodingRuntime overrides) and `undoCompensation` call `workspaceManager.emitEvent(workspaceId, ...)` after a successful fs op. `file.renamed` has no producer today outside `LocalVFS.rename` (no route or tool exposes rename) — drop the event type or keep it dormant for a future rename tool.
- No fs-watchers, no polling. Out-of-band edits (user's editor, `execute_bash` heredocs) produce no `workspace_events` rows — same as today's bash path, which never touched the mirror consistently anyway.

### 3.7 Delete-workspace semantics without the mirror

- **Today:** `deleteWorkspace` marks `TERMINATED`, `fs.rm(rootPath, recursive, force)`, deletes the row (cascades), emits `agent:status`.
- **New rule: never `rm` a mount root.** `deleteWorkspace(id)` = status `TERMINATED` → delete the `workspaces` row (cascades as before) → **leave the directory on disk untouched**. Rationale: the directory may be the user's repo with uncommitted work; `rm -rf` on someone's checkout from a "delete workspace" click is data loss.
- Fresh empty dirs the server itself created under `sandbox/` may be removed only when (a) the stored root is inside the server-managed `sandbox/` base **and** (b) caller passes explicit `{purgeFiles: true}`. Otherwise return `{workspaceDeleted: true, filesKeptAt: rootPath}`. Document in the route response.

---

## 4. Expected Files Touched

| File | Change |
|---|---|
| `vfs/local-vfs.ts` | **Delete** (mirror, cache, checksum sync, `initialize`, all `workspaceNodes` I/O) |
| `vfs/path-guard.ts` | Delete jail duplicates; keep or relocate `normalizePath`, `extractName`, `guessMimeType` next to new `WorkspaceFS` |
| `vfs/vfsGate.ts`, `vfs/index.ts` | Re-point facade at `WorkspaceFS` + string utils; remove `createLocalVFS`; keep export names stable where cheap |
| `vfs/vfs.interface.ts` | Delete `VirtualFS`/`FileStat` with provenance fields, or shrink to `{read, list, stat(size/mtime/type/mime)}`; remove `checksum/createdBy/updatedBy` or make them nullable-documented |
| `Workspace/workspaceManager.ts` | `createWorkspace`: accept `rootPath?`, canonicalize + allowlist, `mkdir` only, no `LocalVFS`; delete `getVFS`; add `getWorkspaceRoot(id)`; `deleteWorkspace`: remove `fs.rm`, add `purgeFiles` gate |
| `Workspace/workspaceTypes.ts` | `CreateWorkspaceInput` += `rootPath?: string`; `WorkspaceNode` deleted or marked deprecated; `WorkspaceEventType` — drop `file.renamed` or keep dormant (decide in review) |
| `tools/safety/Guard.ts` | `validatePath` absolute-root overload + fail-closed root resolution; remove `cwd`/`sandbox` silent fallbacks; keep blacklist + command policy untouched |
| `tools/toolRegistry.ts` | All 6 sites: resolve mount root from `ctx.workspaceId` then validate; `write/delete` emit `workspace_events` directly |
| `runtime/runtimes/CodingRuntime.ts` | Both overrides: same root resolution; keep hash/patch/artifact flow; emit `workspace_events` |
| `Runs/runsGate.ts` | `undoCompensation`: root from run's workspace, no fabricated fallback |
| `routes/vfs.ts` | Replace `LocalVFS` with `WorkspaceFS` + root lookup; add compensation recording when `runId` present; surface `?checksum=true` if adopted |
| `index.ts` | Delete `bootstrapWorkspaces` VFS loop and `LocalVFS` import; replace with lightweight mount check (verify each `rootPath` exists + is dir, log warn, never `mkdir` outside `sandbox/`, never seed) |
| `db/schema.ts` | Drop `workspaceNodes`, `workspaceNodeTypeEnum`, relations; keep `workspaces.rootPath` |
| `db/bootstrap.ts` | Remove `workspace_nodes` DDL + index |
| `db/create-workspace-crowdos.ts` | Delete file (or rewrite as mount-registration script without `LocalVFS.initialize`) |
| `db/seed.ts` | Keep `default` row; ensure its `rootPath` dir exists on boot instead of VFS init |
| `db/migrations/0012_drop_workspace_nodes.sql` | **New**: `DROP TABLE workspace_nodes; DROP TYPE workspace_node_type;` (+ remove index). Renumber if another spec already took `0012`. |
| `Agents/agentSpawnManager.ts` | Route raw write through `Guard.validatePath` + mount root, or delete with `SWARM_LEGACY` retirement (legacy path, no new features) |
| `Shared/config/env.ts` | Optional: `WORKSPACE_MOUNT_ALLOWLIST` (comma-separated absolute prefixes); keep `WORKSPACE_DIR` as default-base |
| Tests | Extend `tools/safety/guard.test.ts`; add mount-escape + mirror-absence tests (§6); update `runtimeLifecycle.test.ts` facade assertions |

Not touched: `workspace_events`, `workspace_agents`, `artifacts`, `runs`, `runs_compensation` tables; `hardenedExec.ts`; command policy tables; socket snapshot mapping (reads `rootPath` for display only — safe).

---

## 5. Ordered Steps (Guard-First)

1. **Pin the jail API (no behavior change).** Add `Guard.validatePathAbs(target, absoluteRoot)` (or overload) implementing §3.4.1 alongside the existing signature. Add unit tests for it (mount root, `../`, sibling-prefix, symlink-escape, `.env`/`.git` blacklist, nonexistent-target write path, win32 case). Keep all callers on the old signature.
2. **Add `getWorkspaceRoot(workspaceId)`.** DB lookup of `workspaces.rootPath` + `realpath` + is-directory check; throw `WorkspaceContextRequiredError` / 404 on miss. Cover with a test (missing workspace, file-as-root, case variant on win32).
3. **Re-home raw-fs sites behind per-mount roots.** Migrate call sites one by one, each with its test: `toolRegistry read/write/list/delete` → `execute_bash/execute_safe cwd` → `CodingRuntime write/edit overrides` → `runsGate undo` (delete fabricated fallback). Fix `agentSpawnManager` raw write (Guard or delete). At the end, no caller passes a bare workspace id as a path and no path resolves through `process.cwd()` fallback.
4. **Emit `workspace_events` from mutation sites.** Add direct `emitEvent(file.created/updated/deleted)` in toolRegistry + CodingRuntime + undo paths. Verify rows appear without any `LocalVFS` involvement.
5. **Cut the mirror writes.** Delete `TtlCache`/DB/event code from `LocalVFS` (or introduce `WorkspaceFS` beside it): reads + writes become pure Guard+fs. Switch `routes/vfs.ts` and `getVFS` consumers to the pure functions. `stat()` drops DB lookup (checksum on-demand only).
6. **Re-home creation/bootstrap.** `createWorkspace` accepts optional `rootPath` (canonicalize + allowlist + `mkdir` only for server-managed bases); `index.ts` boot loop becomes mount verification (no `initialize`, no seeding, no `.crowdos/`); `seed.ts` ensures `default` dir exists. Verify boot with (a) existing repo mount, (b) missing mount (warn, stay up), (c) fresh id (mkdir under sandbox).
7. **Drop the table.** Land migration `0012_drop_workspace_nodes.sql`; remove `schema.ts` table/enum/relations, `bootstrap.ts` DDL, `local-vfs.ts`, `path-guard.ts` jail duplicates, `vfs.interface.ts` provenance fields, `create-workspace-crowdos.ts` VFS init. Update facade assertions.
8. **Change delete semantics.** `deleteWorkspace` stops `rm`; add `purgeFiles` gate for server-managed `sandbox/` roots only. Test that deleting a workspace mounted on a fake "repo" leaves files byte-identical.
9. **Decide `.crowdos/` fate.** Default: stop creating/hiding it; leave existing dirs on disk; document that `workspace.json` is not read. One-line review decision, no code beyond removing `standardDirs` + the list filter.

Rollback after any step: old code paths are additive until step 7 (new overload + new FS helper coexist with `LocalVFS`). Revert = flip callers back; no data migration until the `DROP TABLE` lands (back it up with `pg_dump -t workspace_nodes` in the migration runbook).

---

## 6. Verification

- **Existing suites (must stay green):**
  - `tools/safety/guard.test.ts` — anchored prefix + realpath jail (nested allow, new-file allow, `../` block, sibling-prefix confusion, absolute-escape block, win32 case-insensitivity, symlink/junction escape, `.env` blacklist, `LEGACY_GUARD` rollback) and command classification.
  - VFS/route coverage for `routes/vfs.ts` list/read/write/delete (incl. `ENOENT` → `[]`/404 branches).
  - Undo/compensation: `Runs/checkpoint.test.ts` (`buildCompensationInverse` delete/restore/hash/truncation) and `Runs/resume.integration.test.ts` (compensation round-trip).
  - `runtime/runtimeLifecycle.test.ts` facade shape (update to new facade in step 7).
- **New tests required:**
  1. *Escape attempts against mounts:* temp "repo" + temp sibling; assert `../`, absolute (`/etc/passwd`, `C:\Windows\…`), sibling-prefix (`repo-evil`), symlink-inside-pointing-out, and `.env`/`.git/config`/`credentials.json` all throw via every entry point (tool handlers, CodingRuntime overrides with mocked `packet.workspaceId`, undo with mocked run, `WorkspaceFS` direct). Include win32 case-variant root.
  2. *Per-mount isolation:* two mounts; write same relpath in both; assert no cross-talk; `getWorkspaceDir(idA)` never resolves into mount B; unknown id throws (never `cwd`).
  3. *Mirror-absence boot:* seed rows + real dirs, boot without `workspace_nodes` table; assert server listens, list/read work, write lands on disk with zero DB node writes.
  4. *Delete-keeps-files:* mount workspace on fixture repo with uncommitted file; `deleteWorkspace(id)` (default, no purge) → row gone, fixture bytes identical; with `purgeFiles:true` on a `sandbox/`-managed root → dir removed; with `purgeFiles:true` on a non-sandbox root → refused.
  5. *Events-without-VFS:* write/delete/undo produce `workspace_events` rows with correct `type/path/agentId`; out-of-band shell write produces none (documented).
  6. *Mount validation:* creation with nonexistent root → 400; file-as-root → 400; root outside allowlist (when set) → 400; relative root → resolved against allowlist base, stored canonical.

---

## 7. Risks & Rollback

| Risk | Blast radius | Mitigation / Rollback |
|---|---|---|
| **Path escape = host FS read/write** (the one critical risk). Any missed caller still using `cwd` fallback or lexical join exposes the whole host to agents. | Arbitrary file read (secrets), write (persistence), delete via tools/undo | Guard-first order (§5.1-5.3): new overload + tests land before any caller moves; delete `process.cwd()` fallback and `sandbox/<id>` probing; grep-gate CI for single-arg `getWorkspaceDir(` and for `resolve(` on workspace paths outside `Guard`; keep `LEGACY_GUARD` escape hatch untouched |
| **Stale DB references to `workspace_nodes`** (code, migrations, backups, dashboards referencing the table/index/enum) | Boot/migration failure, runtime `relation does not exist` | Pre-drop grep for `workspace_nodes\|workspaceNodes\|workspace_node_type` across repo + migrations meta; `DROP` in a dedicated migration after all code refs are gone; `pg_dump -t workspace_nodes` before drop; rollback = restore table + revert to pre-drop commit (writes during the window lose node rows — harmless: regenerable scaffolding, real files are on disk) |
| **`.crowdos` consumers outside `src`** (client UI, scripts, docs expecting `/.crowdos/workspace.json`, `/src`, `/artifacts`, `/agents` sectors) | UI 404s, broken onboarding flows | Verified zero readers in `src/`; still grep client + scripts + docs for `.crowdos` before deleting creation; keep serving those paths as ordinary disk paths (a mounted repo simply won't have them); announce in release notes |
| **Windows path/case/junction issues** (`C:` vs `c:`, `\\?\` prefixes, junctions, case-only renames, `path.sep` vs `/`) | Jail bypass or false rejections on Windows hosts | Both jails already lowercase on win32 and use anchored `root + sep` checks; canonicalize roots with `realpathSync` at creation and at every resolution; test matrix includes case-variant root, junction-escape, and backslash-heavy inputs; store roots slash-normalized but compare via `realpath` output, never the stored string |
| **Orphaned/stale node rows damage trust in history** (dir delete orphans children, rename orphans descendants) | Post-drop audits comparing old `workspace_events` payloads (`{checksum, size}`) to new ones | Accept: old event payloads stay as-is (history, not state); new events carry `{size?}` from `stat` and no checksum unless on-demand; document the payload change in the API changelog |
| **Deleting a workspace wipes a real repo** if `fs.rm` survives anywhere | Unrecoverable user data loss | Step 8 makes `rm` opt-in + sandbox-scoped; add a pre-`rm` assertion `isInsideRoot(realpath(target), realpath(sandboxBase))`; code-review every remaining `fs.rm(` (today only `workspaceManager.ts:143` + `local-vfs.ts:256` — both die in this spec) |
| **`package-lock.json` / `.git` blacklist friction on real repos** (agents legitimately need `git diff`, lockfile reads) | Agent workflows break on node repos | Keep blacklist for this spec (security first); file a named follow-up to scope the blacklist per-operation (e.g. allow `git` tool subprocesses + read-only lockfile `stat`, keep blocking direct `.env`/`.git/objects` reads). `execute_bash` allowlist already covers the common git reads without touching `.git` files directly |
| **Perf on large repos** (no cache + per-entry `stat`, bounded 32) | Slow `list` on `node_modules`-scale dirs | Keep the 32-wide bound; add route-level `limit`/`depth=1` default and document "don't list repo root ingenuously"; measure before adding any cache back |

---

## 8. Dependencies

- **Workspace-creation spec (follow-on, must follow this shape):** defines the `POST /workspaces` contract for `rootPath` (absolute vs allowlist-relative, `~` handling, auto-`mkdir` policy for non-sandbox bases, `WORKSPACE_MOUNT_ALLOWLIST` env name/shape, error codes for nonexistent/not-a-dir/outside-allowlist). This spec only reserves `CreateWorkspaceInput.rootPath?: string` and the canonicalize→allowlist→store flow (§3.1). Do not design mount UX elsewhere.
- **Single-DB spec (parallel, DB-row handling):** owns the `0012_drop_workspace_nodes.sql` migration sequencing (after all code refs die), removal of `schema.ts` table/enum/relations + `bootstrap.ts` DDL, seed/backfill adjustments, and any backup/restore runbook for the dropped table. This spec owns the runtime/file behavior; single-DB owns the DDL cutover.
- **No dependency on:** command policy, approvals, queue mode, provider/search runtimes, socket snapshot shape (`rootPath` passthrough is display-only and safe unchanged).

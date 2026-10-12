# Filesystem and metadata mirror
> Type: Feature · Status: aligned · Updated: 2026-09-21

## Intent
Each workspace needs a real filesystem agents and routes can read and write. This feature exists to provide a workspace-scoped filesystem on local disk: disk holds the truth, every path resolves through traversal- and symlink-aware containment, and large reads are capped so they cannot OOM the process.

**Historical name note:** this flow was written when a PostgreSQL metadata mirror (`workspace_nodes`) still existed. CrowdOS §16/§35.5 says NO VFS and migration 0019 dropped `workspace_nodes` + `workspace_events`. The sections below describe the current disk-only behavior; the mirror is gone, and the flow is kept under its historical title only for link stability.

## Architectural decision
Writes are disk-only because the metadata mirror was removed — a write is one `writeFile` with no second store to half-succeed against, so the old disk-first/compensation dance no longer exists [Observed]. Containment is anchored (`candidate === root || startsWith(root + "/")`, case-folded on Windows) plus realpath verification of both existing targets and deepest-existing ancestors — lexical `..` filtering alone was deemed insufficient for symlink escapes [Observed]. Two-tier resolution cost (one realpath for clean existing paths; ancestor walk only for traversal-marked or missing paths; root realpath cached 60s) keeps the common path cheap [Observed]. The 1MB read cap with an inline marker for text lets large files enter LLM context without OOM while keeping truncation visible to the model [Observed]. `.crowdos` is filtered from listings but directly addressable, and `initialize` seeds its sectors through the same `mkdir` path, so control-plane files stay out of browsing [Observed]. `stat` is disk-only: `checksum` is always `null` and the actor stamps are the constructing `actorId` [Observed]. `isInsideRoot` is exported through the domain gate so Tools can share the containment implementation without importing past the gate (§2) [Observed].

## How it works
`filesystemGate.createLocalFilesystem({ workspaceId, workspaceRoot, actorId, onEvent? })` binds one instance to one root; all outside callers (`routes/filesystem.ts`, `create-app.ts` boot, `db/create-workspace-crowdos.ts`) construct through the gate file. `initialize` creates the physical root, mkdirs the seven standard sectors through the same `mkdir` path, and writes `/.crowdos/workspace.json` when missing. Every operation resolves through `resolveWorkspacePath` first: `isPathSafe` rejects `..` escape, null bytes, and drive-letter forms; the cached root realpath is joined lexically, then clean existing targets take a single-realphath fast path while missing ones walk to the deepest existing ancestor — anything outside the anchored root throws before I/O. `write` `mkdir -p`s the parent, writes bytes, and emits `file.updated` with `{ size }`. `read` stats for size, then streams only the first 1MB with a `[TRUNCATED ...]` marker for text (binary truncates silently). `mkdir` is recursive; `delete` stats first (missing → throw), removes recursively, emits `file.deleted`; `rename` ensures the new parent, `fs.rename`s, emits `file.renamed` with `oldPath`; `list` readdirs minus `.crowdos`, stats entries with 32-wide bounded concurrency, and sorts directories-first then alphabetical; `stat` returns disk truth; `exists` returns boolean where `delete` would throw. Serving: `routes/filesystem.ts` resolves the workspace root per request (30s row cache → registry → DB → `sandbox/default` fallback) and maps ENOENT to 404/`[]`. Callbacks are plain function calls, not broker events, and no in-repo caller currently passes `onEvent`.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Filesystem.md> | Owns disk I/O, path containment, standard-sector bootstrap, `onEvent` callbacks |
| <../Domain Spec/Workspace.md> | Owns `workspaces` rows and root-path resolution; the filesystem domain reads no table |
| <../Domain Spec/Tools.md> | Owns authorization/blacklist policy for tool-driven I/O (`Guard.validatePath` wraps `isInsideRoot`); tool handlers do not call `LocalFilesystem` |
| <../Domain Spec/Approvals.md> | Owns approval policy for destructive file ops (enforced in `tool-executor.ts`, not here) |

## Current state
Real: file/dir CRUD over a workspace root, anchored + realpath containment on every op, 1MB capped reads (text marked, binary silent), sorted listings (`.crowdos` hidden), disk-truth `stat`, sector bootstrap on `initialize`, `file.updated/deleted/renamed` callbacks. Flags: none in-domain (adjacent: `SYSTEM_ACTOR_ID` actor fallback in routes, `WORKSPACE_DIR` tool I/O root in guard). Stub: `onEvent` has no subscriber.

## Alignment notes
- 2026-09-16 C2 (NO VFS §16/§35.5): `LocalFilesystem` is pure fs — no `workspace_nodes` reads/writes, no listing cache, no workspace-row ensure. `stat.checksum=null`, actors = caller. Table drop + `bootstrap.ts` DDL removal = later migration; no code reads the table.
- 2026-09-20 NO-VFS enforced: `workspace_nodes` + `workspace_events` dropped (0019), removed from `schema.ts` + legacy DDL; `LEGACY_BOOTSTRAP` deprecated, migrations are truth.
- 2026-09-21 Phase 0 (VFS → Filesystem codemod): domain folder `vfs/` → `Filesystem/`, gate `vfsGate` → `filesystemGate`, class `LocalVFS` → `LocalFilesystem`, routes `routes/vfs.ts` → `routes/filesystem.ts`, client `VfsNode` → `ExplorerNode`, store `vfsRevision` → `filesystemRevision`, `VFSPermissions` → `FilesystemPermissions`, IPC `crowdos:vfs:*` → `crowdos:fs:*`. The `VirtualFS` interface was dropped (one implementation). The §2 gate violation in `tools/safety/guard.ts` was fixed by exporting `isInsideRoot` through the gate. Dead types `WorkspaceNode`/`WorkspaceEvent`/`WorkspaceAgentSession`/`WorkspaceEventType`/`WorkspaceNodeType` were removed from `workspace-types.ts`.
- Sector count: the code creates seven paths (`/src`, `/artifacts`, `/agents`, `/.crowdos`, `/.crowdos/runtime`, `/.crowdos/cache`, `/.crowdos/snapshots`, `local-filesystem.ts:43-60`). The prior "eight sectors" claim in this file is corrected above.
- The Flow and How-it-works sections previously described checksum upserts, `workspace_nodes` sync, and disk-first compensation. Those described code that no longer exists; they are replaced by the disk-only description above.
- Remaining drift: this flow's title still says "metadata mirror". The mirror is gone; the title is retained only so inbound links keep resolving.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* One resolver: the panel root and the agent tool root resolve through the same authority-aware resolver (Phase 1). Readers never infer a root from a registry row alone.
* Concurrent `initialize` has a conflict rule. `readBinary` truncation is signaled like text reads.
* Authority: Filesystem standard.

## Open gaps
- `readBinary` truncates silently at 1MB while `read` appends a marker — binary consumers cannot distinguish full from clipped content.
- Root symlink flips within the 60s `rootRealCache` window resolve against the stale root; scope is one process.
- No file locking or atomic-rename writes — concurrent writers to one path interleave at byte level.
- `onEvent` has no in-repo subscriber — file-change notification is dead surface today.
- `routes/filesystem.ts` resolves its root from the workspace registry row, not from the mount chain — the Phase 1 defect recorded in `UI UX Overhaul/02-filesystem-model.md` §3.
- Unsafe-path errors surface from routes as 500s, not 400s — caller-input hygiene is the caller's job.

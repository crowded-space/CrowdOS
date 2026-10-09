# Filesystem Domain — Contracts (facade surface, exact)

## Gate exports (filesystem-gate.ts:15-27) — must remain stable (AGENTS.md §2)
| Export | Kind | Signature / shape | Notes |
|---|---|---|---|
| LocalFilesystem | class | ctor(options: LocalFilesystemOptions) | Methods: initialize, read, readBinary, write, mkdir, delete, rename, list, stat, exists |
| normalizePath | fn | (string) => string | backslash→slash, posix.normalize, strip leading/trailing "/", "." for empty |
| isPathSafe | fn | (string) => boolean | rejects ..-escape/null/drive forms; **accepts absolute "/..." (stripped)** and ":"-bearing names |
| isInsideRoot | fn | (candidate, root) => boolean | anchored equality/prefix; case-folded win32 |
| resolveWorkspacePath | fn | (root, rel) => Promise<string> | throws "Unsafe path detected" / "Path traversal blocked" |
| extractName | fn | (string) => string | posix basename of normalized path |
| guessMimeType | fn | (string) => string \| null | static extension map |
| isVisibleEntryName | fn | (string) => boolean | dotfiles hidden except REPO_MARKER_NAMES |
| REPO_MARKER_NAMES | const | readonly string[] = [".ThisCrowd",".crowdos",".crowdosrc"] | pinned by test:96 |
| FileNode / FileStat / LocalFilesystemOptions | types | see filesystem-types.ts; options { workspaceId, workspaceRoot, actorId, workspaceName?, onEvent? } | options type lives in local-filesystem.ts:16 |
| filesystemGate | object | createLocalFilesystem + 7 pure helpers | construction port used by tests |

## Caller contracts (what outsiders depend on)
- routes/filesystem.ts: filesystemFor builds a LocalFilesystem per request; expects ENOENT as error.code on missing paths; expects root listing shape { ...scope, root, nodes } vs bare array below (channel-mount-gate.test.ts:613).
- routes/workspace.ts: isInsideRoot gates rm/rename of workspace folders (workspace sandbox safety).
- tools/safety/guard.ts: Guard.isInsideRoot = sharedIsInsideRoot (one containment impl; Tools adds its own blacklist on top).
- channel-mounts + tool-registry: isVisibleEntryName as THE listing rule (tree/picker/tool agreement).
- bootstrap: create-app.ts + db/create-workspace-crowdos.ts call initialize() only; no other methods used outside routes.

## onEvent contract (local-filesystem.ts:123,141,153)
- write → ("file.updated", normalizedPath, { size }); delete → ("file.deleted", normalizedPath); rename → ("file.renamed", normalizedNew, { oldPath: normalizedOld }).
- mkdir/list/stat/exists/initialize emit nothing. No in-repo subscriber (grep: 0 production call sites pass onEvent).

## Invariants the contract relies on (enforced or violated — see invariants.md)
- Every op resolves through resolveWorkspacePath before I/O.
- Facade stays thin (wire + re-export only) — satisfied; gate has zero logic beyond the one-line factory.
- Gate-to-gate only — satisfied; domain imports only node builtins + Shared/core/ttl-cache.ts (exempt per §2).
- index.ts barrel: re-export only; no importer found (dead surface, harmless).

## Doc alignment (re-docs/Backend Docs/Domain Spec/Filesystem.md)
- Ports list matches gate exports exactly (checked line-by-line).
- Flow doc line numbers in Domain Spec are STALE (doc cites local-filesystem.ts:88-94 for read; actual read at 85-98, write at 115-124 ✓, list at 156-189, delete 131-142, rename 144-154 — close but drifted; Domain Spec "seven sectors at 43-60" matches; "rootRealCache path-guard.ts:105" matches).
- Feature doc "Filesystem and metadata mirror.md" still carries the "resolves its root from the workspace registry row" gap text although Domain Spec marks it resolved 2026-09-21 — intra-doc drift between the two files (docs-only; not fixed in this read-only audit).

# Filesystem

## Purpose
Workspace-scoped direct filesystem on local disk (§16/§35.5 NO VFS). No DB mirror: every op hits clamped fs via the path-guard jail. `workspace_nodes` + `workspace_events` dropped (0019); `LEGACY_BOOTSTRAP` DDL is deprecated, migrations are truth.

## Feature Scope
In-scope:
- File/dir CRUD over a workspace root: read (capped), readBinary (capped), write, mkdir, delete, rename, list, stat, exists (`local-filesystem.ts`).
- Path normalization, safety predicates, anchored containment, and realpath-based escape rejection (`path-guard.ts`).
- Standard-sector bootstrap on `initialize` (seven paths) + `/.crowdos/workspace.json` seed.
- Canon `vfs/` bootstrap on `initialize` (2026-09-22): `vfs/{src,artifacts,agents,.crowdos/{cache,runtime,snapshots}}` plus the canon runtime object at `vfs/.crowdos/workspace.json`.
- Plain-callback change notifications (`onEvent`) — no broker, no persistence.
Non-goals (other domains):
- Authorization and blacklist policy for tool-driven I/O → Tools (`Guard.validatePath` wraps `isInsideRoot` with its own blacklist; Tools handlers do not call `LocalFilesystem`).
- Workspace lifecycle, membership, and root-path resolution → Workspace (`workspace-registry.ts`, `routes/workspace.ts`).
- HTTP surface, actor resolution, and root selection → Routes (`routes/filesystem.ts` builds a per-request instance via `filesystemFor` and picks the root through `channelMountGate.scope`).
- Approval policy for destructive file ops → Approvals/channel settings (enforced in `tool-executor.ts`, not here).

## Expect
- `[Observed]` Every operation resolves through `resolveWorkspacePath` first — traversal, null bytes, drive-letter forms, and symlink escapes all throw before any I/O.
- `[Observed]` `write` is disk-only: `mkdir -p` the parent, then `writeFile`. There is no metadata mirror, so there is no upsert and no compensation path.
- `[Observed]` `mkdir` is recursive and idempotent; `delete` and `rename` are read-then-act and not race-safe.
- `[Observed]` Text reads are capped at 1MB with an explicit `[TRUNCATED ...]` marker; `readBinary` caps silently at the same limit.
- `[Observed]` `list` hides dotfiles through the shared `isVisibleEntryName` rule, which keeps the repo markers `.ThisCrowd`/`.crowdos`/`.crowdosrc` visible; it stats entries with bounded (32-wide) concurrency and sorts directories-first then alphabetical. There is no listing cache.
- `[Observed]` `delete` on a missing path throws (`stat` first); `exists` on the same path returns `false` — check-then-act callers must use `exists`, not try/delete.
- `[Observed]` `stat` is disk-only: `checksum` is always `null` and `createdBy`/`updatedBy` are the constructing `actorId`. Nothing is merged from a DB.
- `[Observed]` `onEvent` fires `file.updated`, `file.deleted`, and `file.renamed` only. `mkdir`, `list`, `stat`, `exists`, and `initialize` emit nothing.

## Flow
1. Construction: `filesystemGate.createLocalFilesystem({ workspaceId, workspaceRoot, actorId, onEvent? })` binds one instance to one root (`filesystem-gate.ts:18`); all outside callers import through the gate file (`routes/filesystem.ts:3`, `create-app.ts:17`, `db/create-workspace-crowdos.ts:3`).
2. Bootstrap: `initialize()` creates the physical root, mkdirs the canon sectors (`vfs/`, `vfs/src`, `vfs/artifacts`, `vfs/agents`, `vfs/.crowdos`, `vfs/.crowdos/{runtime,cache,snapshots}`), and writes `vfs/.crowdos/workspace.json` when missing — the canon runtime object (`{ workspace: { id, name, createdAt, permissions, constraints, artifactDir, fsMounts } }`). No DB access at any point.
3. Resolve: `resolveWorkspacePath(root, rel)` rejects unsafe input via `isPathSafe` (`path-guard.ts:130`); takes the cached root realpath (`path-guard.ts:105`), joins lexically, then either single-realphaths clean existing targets (fast path, `path-guard.ts:144`) or walks to the deepest existing ancestor for missing ones; anything outside the anchored root throws (`path-guard.ts:163`).
4. Write: resolve → `mkdir -p` parent → `writeFile` → emit `file.updated` with `{ size }` (`local-filesystem.ts:115-124`).
5. Read: resolve → `stat` for size → over-1MB reads stream only the first 1MB with a truncation marker (text, `local-filesystem.ts:88-94`) or a silent slice (binary, `local-filesystem.ts:100-112`).
6. Mkdir/delete/rename: `mkdir` creates recursively (`local-filesystem.ts:126-129`); `delete` stats (throws when missing), removes recursively via `rm`, emits `file.deleted` (`local-filesystem.ts:131-142`); `rename` ensures the new parent, `fs.rename`s, emits `file.renamed` with `oldPath` (`local-filesystem.ts:144-154`).
7. List/stat: `list` readdirs and filters through `isVisibleEntryName` (`entry-visibility.ts`, `local-filesystem.ts:156-164`), bounded-stats in 32-wide batches, sorts, returns (`local-filesystem.ts:185-189`); `stat` returns disk truth with `checksum: null` and caller actors (`local-filesystem.ts:169`).
7a. List tolerance (FS-001 fixed): per-entry `stat` failure (dangling symlink/junction) resolves to null and is skipped — one broken entry no longer fails the entire listing with ENOENT.
8. Serving: `routes/filesystem.ts` resolves the root per request through `channelMountGate.scope` — the same resolver the agent file tools use, so the panel and the agents cannot disagree (`routes/filesystem.ts:17-19`). A `root` query param (`effective` default, or `workspace-local` to pin Zone A) selects which of the two roots the caller wants; both are jailed by the same `LocalFilesystem` path guard, so it is a selector and not a bypass (`routes/filesystem.ts:29-35`). A root listing returns `{ ...scope, root, nodes }` so the header and the tree come from one response; nested listings stay a bare array (`routes/filesystem.ts:102-107`). ENOENT on the root listing is a 404 carrying the missing path, never `[]` — an empty array reads as "empty repository", which is the one thing the panel must never claim (`routes/filesystem.ts:109-121`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `filesystem-gate.ts` | Thin facade: re-exports `LocalFilesystem`/path helpers/types plus the `filesystemGate` constructor/utility ports |
| `local-filesystem.ts` | `LocalFilesystem`: disk I/O + sector bootstrap + `onEvent` callback |
| `path-guard.ts` | Pure path layer: normalize/safety/containment/realpath resolution/mime |
| `entry-visibility.ts` | The one listing rule: `REPO_MARKER_NAMES` + `isVisibleEntryName` |
| `filesystem-types.ts` | `FileNode` / `FileStat` contracts (no interface — one implementation) |
| `index.ts` | One-line re-export of the gate |

Key values: `rootRealCache` (60s, 200 keys, `path-guard.ts:105`); `MAX_READ_BYTES = 1MB` (`local-filesystem.ts:88`); `BOUNDED_CONCURRENCY = 32` (`local-filesystem.ts:165`); seven standard sectors (`local-filesystem.ts:43-60`).

## Ports
- `LocalFilesystem` — disk-backed filesystem class (read/readBinary/write/mkdir/delete/rename/list/stat/exists/initialize).
- `normalizePath` — backslash→slash, collapse `.`/`..`, strip leading/trailing slashes (`.` for root).
- `isPathSafe` — lexical veto on `..` escape, null bytes, and drive-letter forms.
- `isInsideRoot` — anchored containment check (candidate equals root or lives strictly under it); case-folded on Windows.
- `resolveWorkspacePath` — safe-join with realpath containment proof; throws on escape.
- `extractName` — basename of a normalized path.
- `guessMimeType` — extension→mime map, `null` when unknown.
- `FileNode` — `{ name, path, type, size, mimeType, updatedAt }` listing-entry type.
- `FileStat` — `FileNode` plus checksum/created/actor stamps type.
- `LocalFilesystemOptions` — `{ workspaceId, workspaceRoot, actorId, onEvent? }` type.
- `isVisibleEntryName` — the shared listing predicate: false for dotfiles except the repo markers.
- `REPO_MARKER_NAMES` — `[".ThisCrowd", ".crowdos", ".crowdosrc"]`, the markers that stay visible despite the leading dot.
- `filesystemGate.createLocalFilesystem` — constructs a bound `LocalFilesystem`.
- `filesystemGate.normalizePath` / `isPathSafe` / `isInsideRoot` / `resolveWorkspacePath` / `extractName` / `guessMimeType` / `isVisibleEntryName` — direct re-exports of the pure helpers.

## Relations
Gates this domain calls:
- None — `local-filesystem.ts` imports only `node:fs/promises`, `node:path`, and `./path-guard.ts`. `path-guard.ts` additionally imports `Shared/core/ttl-cache.ts`.
- Tools→Filesystem: `Guard.isInsideRoot` reuses this domain's `isInsideRoot`, now imported through the gate (`guard.ts:3`) — the former direct `path-guard.js` import was a §2 violation and is fixed.
Verified outside callers (all construct via the gate file):
- Routes: `routes/filesystem.ts` `filesystemFor` (per-request instances for list/read/write/delete, rooted through `channelMountGate.scope`).
- ChannelMounts→Filesystem: `channel-mount-service.ts` imports `isVisibleEntryName` through the gate so the mount picker and the Repo tree share one listing rule.
- Bootstrap: `create-app.ts` `bootstrapWorkspaces` (workspace initialization on boot), `db/create-workspace-crowdos.ts` (seed provisioning).
Tables shared with other domains:
- None. This domain touches no table.

## Emits-Listens
- `file.updated` (callback, with `{ size }`)
- `file.deleted` (callback)
- `file.renamed` (callback, carries `oldPath`)
- Callbacks are plain function calls, not broker events. No `listens` anywhere in this domain. No caller in the repo currently passes `onEvent`, so these fire into nothing today.

## Owns
- Nothing persisted. This domain owns only the on-disk workspace root it is constructed with.
- `workspace_nodes` and `workspace_events` were dropped in migration 0019 and are no longer written or read here.

## Flags
- None in-domain — no `process.env` reads in `local-filesystem.ts`, `path-guard.ts`, `filesystem-types.ts`, or `filesystem-gate.ts`. Adjacent: `SYSTEM_ACTOR_ID` (actor fallback, read in route transport `routes/filesystem.ts`); `WORKSPACE_DIR` (tool I/O root, read in `guard.ts`).

## Decisions
- `[Observed]` 2026-09-22 canon layout: `initialize()` materializes the `vfs/` sandbox the mock-structure-polished canon defines (replacing the old root-level `/src /artifacts /agents /.crowdos`). `vfs/` is a config sandbox and is never a mount target for a user repository.
- `[Observed]` Disk-only writes with no metadata mirror — the DB copy was removed by §16/`0019`, so a write is one `writeFile` and cannot half-succeed across two stores.
- `[Observed]` Anchored containment (`candidate === root || startsWith(root + "/")`, case-folded on Windows) plus realpath verification of both existing targets and deepest-existing ancestors — lexical `..` filtering alone was deemed insufficient for symlink escapes (`path-guard.ts:66`, `path-guard.ts:130`).
- `[Observed]` Two-tier resolution cost: clean paths to existing files cost one realpath; only traversal-marked or missing paths pay the ancestor walk, and the root realpath itself is cached 60s (`path-guard.ts:144`, `path-guard.ts:105`).
- `[Observed]` 1MB read cap with an inline marker for text — large files can enter LLM context without OOM, and the marker keeps the truncation visible to the model (`local-filesystem.ts:88-94`).
- `[Observed]` Dotfiles are hidden but directly addressable, and `initialize` seeds its sectors through the same `mkdir` path — control-plane files stay out of normal browsing (`local-filesystem.ts:156-164`, `local-filesystem.ts:43-60`).
- `[Observed]` The visibility rule is shared with the mount picker (`entry-visibility.ts`) rather than duplicated — why: the two callers used to answer differently, so a mounted repository's markers vanished from the tree while showing in the picker. Hiding is a display decision, never a security boundary: a caller naming a hidden path still resolves it through the path guard.
- `[Observed]` `isInsideRoot` is exported from the gate rather than imported past it, so Tools satisfies §2 while still sharing one containment implementation (`filesystem-gate.ts:15`).

## User Decision:

## Architectural Standard (Target)

> **Status:** Target — documents the invariant new work must satisfy.

* One resolver: this domain must never resolve "the workspace root" independently of the mount model. Satisfied — `routes/filesystem.ts` resolves through `channelMountGate.scope`, the same call the agent file tools make. A future consumer that derives its own root is a regression.
* Readers MUST NOT assume a listing cache exists; staleness is bounded by re-list only.
* Subtree invariant: `rename`/`delete` on a directory is atomic with respect to any consumer that caches paths.

## Failure + Resume
- Unsafe/unresolvable paths throw (`Unsafe path detected` / `Path traversal blocked`) from every operation before I/O; routes surface these as 500s, not 400s — caller-input hygiene is the caller's job (`path-guard.ts:131`, `routes/filesystem.ts:100`).
- Missing files: `read`/`stat` throw ENOENT (route → 404), `delete` throws ENOENT via pre-`stat` (route → 404), `list` on a missing dir throws ENOENT (route → 404 with the missing root path, never `[]`), `exists` returns `false`.
- `mkdir` is idempotent by construction (recursive); `initialize` re-runs safely for the same reason.
- Resume is N/A (synchronous filesystem ops, no background work).

## Gaps
- `readBinary` truncates silently at 1MB while `read` appends a marker — binary consumers cannot distinguish full from clipped content (`local-filesystem.ts:100-112`).
- Root symlink flips within the 60s `rootRealCache` window resolve against the stale root; cache poisoning scope is one process (`path-guard.ts:105`).
- No file locking or atomic-rename writes — concurrent writers to one path interleave at the byte level.
- `onEvent` has no in-repo subscriber, so file-change notification is currently dead surface (`local-filesystem.ts:25`).
- ~~`routes/filesystem.ts` resolves its root from the workspace registry row, not the mount chain~~ — resolved 2026-09-21: the route resolves through `channelMountGate.scope`, so the panel and the tools agree. The remaining half of that defect (`Guard.getWorkspaceDir`'s `process.cwd()` fallback) lives in Tools, not here.
- Whether the seven standard sectors are still the intended set is unverified; the count previously drifted between doc and code.

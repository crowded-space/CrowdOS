# ChannelMounts

## Purpose
Filesystem mount resolver for channel → category → workspace fallback chains, plus the single authority-aware root answer (`EffectiveRoot`) that every other consumer — Repo panel, agent file tools, coding runtime, runs undo — must use. It validates candidate directories against a per-workspace mount jail with symlink-safe realpath, attaches/clears mounts by writing mount columns, and browses the host filesystem clamped to that jail. It also resolves the canon VIRTUAL mount chain (`EffectiveMounts`): a workspace declares mounts with mode `default`, each category/channel either `inherit`s the parent or `override`s it, and the first override walking channel → category → workspace wins.

## Feature Scope
In-scope:
- Mount validation (exists + directory + inside the workspace's allowed roots, null-byte fast reject, realpath cached 60s).
- Resolution precedence: channel `folderPath` → category `folderPath` → workspace mount → `none`.
- Canon virtual mount resolution (`resolveEffectiveMounts`): channel override → category override → workspace `default`, with `inherit` levels skipped by definition. Sources and targets are virtual paths (what the agent sees), never host paths; host mounts still pass `validateMountPath`.
- **One root answer** (`resolveEffectiveRoot`): the mount chain plus the Zone A fallback collapsed into `{ path, zone, source, reason }`, so the panel and the tools cannot resolve different directories.
- Attach/detach for channel, category, and workspace mounts (detach = `null`/empty write).
- Rooted filesystem browse (dotfile-filtered through the shared `entry-visibility` rule, dirs-first, 300-entry cap) + allowed-roots listing.
Non-goals (other domains):
- Channel/category row lifecycle (names, types, archive, delete) → Channels (owns `channels` identity; this domain only writes mount columns).
- Workspace lifecycle, permissions, sharding, and the per-workspace jail field → Workspace (owns `workspaces` rows; this domain only writes the Zone B mount column).
- File I/O, risk classification, approvals → Tools/Approvals (validate mount paths, never execute).
- Transport (REST schemas, auth, socket fan-out) → Routes/Sockets (call `channelMountGate`, emit `*:mount-updated` themselves).
- Transport (REST schemas, auth, socket fan-out) → Routes/Sockets (call `channelMountGate`, emit `*:mount-updated` themselves). `category:mount-updated` now carries the owning `workspaceId` so the fan-out stays workspace-scoped instead of global (CM-017/CM-019 fixed).
- Transport (REST schemas, auth, socket fan-out) → Routes/Sockets (call `channelMountGate`, emit `*:mount-updated` themselves). `category:mount-updated` now carries the owning `workspaceId` so the fan-out stays workspace-scoped instead of global (CM-017/CM-019 fixed). Mount PUT routes assert caller-vs-target workspace (CM-003 fixed); PG resolve backfills the registry mirror (CM-001 fixed); unreadable registry fails closed to the sandbox base instead of widening the jail (CM-002 fixed).
- The native folder dialog → Desktop (`dialog.showOpenDialog`). The server-spawned picker was removed; `POST /api/fs/pick-folder` hard-410s.

## Expect
- `[Observed]` Resolution never throws on missing rows or invalid mounts; it falls through to the next level and ends in `{ source: none }`.
- `[Observed]` Channel-level mount wins over category, which wins over workspace; an invalid path at one level does not block fallback.
- `[Observed]` `validate` returns `{ valid: false, error }` instead of throwing for missing/file/outside-roots inputs.
- `[Observed]` Attach with `null`/empty clears the mount without validating; non-empty paths validate before any write.
- `[Observed]` `browse` never escapes the allowed roots; outside/missing inputs clamp back to the first root.
- `[Observed]` `effectiveRoot` always returns a value: Zone B (`zone: "mounted"`) when a mount resolves, otherwise Zone A (`zone: "workspace-local"`) — the caller never re-derives the fallback.
- `[Observed]` A configured-but-unusable mount is reported through `reason`, so the panel can explain an empty tree instead of rendering one that looks like an empty repository.
- `[Observed]` Canon virtual mounts are separate from host mounts: they carry virtual `source`/`target` paths and resolve by the `inherit`/`override` chain. A mount missing either path is dropped rather than surfaced as a phantom entry.
- `[Observed]` `vfs/` is never a mount target — the canon layout is a config sandbox, and host mounts are still validated against the workspace jail.

## Flow
1. Roots: `getAllowedRoots(workspaceId)` returns `record.allowedMountRoots` (resolved, blanks dropped) when the workspace registry record sets them, else the default policy `[resolveSandboxBase(), os.homedir()]` with home dropped when it equals the sandbox (`channel-mount-service.ts:38-57`). **There is deliberately no env read**: `ALLOWED_MOUNT_ROOTS` appeared in neither `env.ts` nor `.env.example`, so mounting a real repository failed with "Path outside allowed roots" until the operator discovered an undocumented variable. The jail is now per-workspace registry policy (`workspace-registry.ts:48-53`). `allowedRoots()` exposes it (`channel-mount-service.ts:479`); `GET /api/fs/allowed-roots` wraps it (`routes/channel-mounts.ts:30`).
2. Validate: `validateMountPath(path, workspaceId)` rejects empty/null-byte (`Path required` / `Invalid path`), `stat`-checks directory-ness (`Path does not exist` / `Path is not a directory`), `realpath`s through a 60s/200-key `TtlCache` for symlink safety, then requires `isInsideAllowedRoots` (win32-lowercased, `\\?\`-stripped, trailing-sep-normalized); failure is `Path outside allowed roots: <joined>` (`channel-mount-service.ts:77-114`, `channel-mount-service.ts:59-75`).
3. Workspace resolve: `resolveWorkspaceMount(id)` reads **Zone B only** — `record.mountPath`; valid → `{ source: "workspace" }`, configured-but-unusable → `{ source: "none", reason }` (`channel-mount-service.ts:116-135`). `rootPath` is Zone A and is deliberately never read here: reading it is what made the panel and the agent tools resolve different roots the moment a mount was set (`channel-mount-service.ts:119-121`).
4. Channel resolve: `resolveChannelMount(id)` returns `none` on miss (`channel-mount-service.ts:340-343`); pre-fetches category + workspace mounts in parallel (`channel-mount-service.ts:349-355`); channel `folderPath` (`channel-mount-service.ts:313`), else category `folderPath` (`channel-mount-service.ts:327`), else workspace mount (`channel-mount-service.ts:340`), else `none` carrying the first configured-but-unusable `reason` (`channel-mount-service.ts:348-353`); `GET /api/channels/:id/mount` wraps it (`routes/channel-mounts.ts:41`).
5. Category resolve: `resolveCategoryMount(id)` — own `folderPath`, else inherits the workspace mount, else `none` + `reason` (`channel-mount-service.ts:356-390`); `GET /api/categories/:id/mount` wraps it (`routes/channel-mounts.ts:60`).
6. Effective root — THE resolver: `resolveEffectiveRoot({ workspaceId, channelId })` (`channel-mount-service.ts:188-231`). Channel Zone B wins → `{ zone: "mounted", source, reason: null }` (a `none` source is coerced to `workspace` at `channel-mount-service.ts:199`); otherwise Zone A via `resolveWorkspaceLocalRoot` with `{ zone: "workspace-local", source: "workspace-local", reason: mount.reason ?? null }`. A channel naming a workspace we were not told about is trusted (`channel-mount-service.ts:203`). Exported as the `effectiveRoot` port.
7. Panel scope: `resolveMountScope({ workspaceId, channelId })` = `effectiveRoot` + `workspaceRoot` (the Zone A sibling) + `displayName` (`path.basename(path) || path`) — one round trip answers both "which folder" and "what else could it be" (`channel-mount-service.ts:233-247`). Exported as the `scope` port; `GET /api/workspace/mount` wraps it (`routes/filesystem.ts:78`).
8. Attach: `attachChannelMount` / `attachCategoryMount` / `attachWorkspaceMount` 404-check the row, clear on `null`/empty, else validate-then-write (`channel-mount-service.ts:392`, `channel-mount-service.ts:405`, `channel-mount-service.ts:249`). Workspace attach writes **Zone B `mountPath` only**, with forward slashes, and leaves Zone A `rootPath` untouched (`channel-mount-service.ts:264-266`) — writing it into `rootPath` made `initialize()` create the CrowdOS workspace sectors inside the user's repository. Routes re-resolve and emit `channel:mount-updated` / `category:mount-updated` / `workspace:mount-updated` outside the gate (`routes/channel-mounts.ts:47-57`, `routes/channel-mounts.ts:66-75`, `routes/channel-mounts.ts:84-93`).
9. Browse: `browseFs(path?, workspaceId?)` defaults to the first root, realpaths, clamps outside-roots input back to the first root, degrades file→parent dir, throws only on a missing path (`channel-mount-service.ts:418-476`); filters through the shared `isVisibleEntryName` (`Filesystem/entry-visibility.ts`), sorts dirs-first + alpha, caps 300, nulls `parent` at the roots boundary; `GET /api/fs/browse` maps the throw to 400 (`routes/channel-mounts.ts:19-27`).
10. Virtual mount writes (2026-09-25 audit fix): `setEffectiveMounts` refuses `mode: "default"` for channel/category levels with `{ ok: false }` — that mode is the workspace level's own canon value, the resolver only honors `override` below workspace, and a stored-but-ignored set was dead data pretending to be configured (`channel-mount-service.ts`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `channel-mount-types.ts` | Pure types, no I/O. `MountInfo` / `EffectiveRoot` / `MountScope` / `ChannelMountRecord` / `CategoryMountRecord` / `WorkspaceMountRecord` / `FsBrowseEntry` |
| `channel-mount-service.ts` | All logic: per-workspace roots + containment, `TtlCache` realpath, validate, 3 resolvers, `effectiveRoot` + `scope`, 3 attachers, `browseFs` |
| `channel-mount-gate.ts` | Thin facade, wire + re-export only |
| Key types | `MountInfo` (`workspaceId` / `mountedPath` / `source: channel\|category\|workspace\|none` / `reason?`); `EffectiveRoot` (`path` / `zone: mounted\|workspace-local` / `source` / `reason`); `MountScope` = `EffectiveRoot` + `workspaceRoot` + `displayName`; attach returns `{ ok: true } \| { ok: false, error }`; validate returns `{ valid, resolved?, error? }`; browse returns `{ path, parent, entries[≤300], allowedRoots }` |
| Key types | `MountInfo` (`workspaceId` / `mountedPath` / `source: channel\|category\|workspace\|none` / `reason?`); `EffectiveRoot` (`path` / `zone: mounted\|workspace-local` / `source` / `reason`); `MountScope` = `EffectiveRoot` + `workspaceRoot` + `displayName`; canon `FsMount` (`id` / virtual `source` / virtual `target` / `type` / `readOnly`), `FsMounts` (`scope` / `mode: default\|inherit\|override` / `mounts[]`), `EffectiveMounts` (`workspaceId` / winning `source` / `mounts` / `reason`); attach returns `{ ok: true } \| { ok: false, error }`; validate returns `{ valid, resolved?, error? }`; browse returns `{ path, parent, entries[≤300], allowedRoots }` |

## Ports
- `MountInfo` — resolved mount info type (`source` plus optional `reason`).
- `EffectiveRoot` — the single root answer (`path` / `zone` / `source` / `reason`).
- `MountScope` — `EffectiveRoot` plus Zone A `workspaceRoot` and `displayName`.
- `WorkspaceMountRecord` — workspace mount record type.
- `channelMountGate.resolve` — resolves the effective channel mount (`channel → category → workspace → none`).
- `channelMountGate.resolveCategory` — resolves a category mount (own → workspace → none).
- `channelMountGate.resolveWorkspace` — resolves a workspace mount (Zone B `mountPath` → none).
- `channelMountGate.effectiveRoot` — `resolveEffectiveRoot`: the one root answer every consumer must use.
- `channelMountGate.effectiveMounts` — `resolveEffectiveMounts`: canon virtual mount chain (channel override → category override → workspace default).
- `channelMountGate.scope` — `resolveMountScope`: `effectiveRoot` + Zone A sibling + display name (panel-facing).
- `channelMountGate.attachChannel` — sets or clears `channels.folderPath` (validated).
- `channelMountGate.attachCategory` — sets or clears `categories.folderPath` (validated).
- `channelMountGate.attachWorkspace` — sets or clears the workspace Zone B `mountPath` (validated; Zone A `rootPath` untouched).
- `channelMountGate.browse` — rooted directory listing, throws only on a missing path.
- `channelMountGate.validate` — mount-path check returning `{ valid, resolved?, error? }`.
- `channelMountGate.allowedRoots` — the jail this workspace actually enforces.
- `channelMountGate.owns` — CM-003 caller-vs-target ownership check for mount routes (channel/category/workspace id).

## Relations
Gates this domain calls:
- `channelGate` (`get`/`getCategory`/`update`/`updateCategory`) and `workspace-gate.ts` (`getWorkspaceRecord`/`saveWorkspaceRecord`/`resolveSandboxBase`/`resolveWorkspaceLocalRoot`) — mount reads/writes go through gates so file truth applies locally; direct `db` remains only for the PG workspace-row path plus `shared/config/database.ts` (`getDb`/`isDatabaseConfigured`/`isConnectionError`), `shared/core/ttl-cache.ts` (`TtlCache`), and `db/schema.ts`.
- `Filesystem/filesystem-gate.ts` — `isVisibleEntryName`, the one listing rule shared with `LocalFilesystem.list`.
Known outside callers of `channelMountGate`:
- Routes: `routes/channel-mounts.ts` (browse/allowedRoots/resolve/attachChannel/resolveCategory/attachCategory/resolveWorkspace/attachWorkspace), `routes/filesystem.ts` (`scope` on every Repo-panel request).
- Tools: `tools/tool-registry.ts` `resolveToolRoot` (`effectiveRoot` for every FS tool plus bash/safe cwd, dynamic import).
- Runtime: `runtime/runtimes/coding-runtime.ts` `resolveRuntimeRoot` (`effectiveRoot`, dynamic import).
- Runs: `runs/runs-gate.ts` `undoCompensation`.
- Tests: `channel-mounts/channel-mount-gate.test.ts` (validate/browse/resolveWorkspace/resolve/effectiveRoot + route integration).
Tables shared with other domains (co-written, single-column ownership split):
- `channels.folderPath` (Channels owns identity, this domain writes the mount column); `categories.folderPath` (category lifecycle elsewhere, mount column here); `workspaces.metadata.customMountPath` (Workspace owns the row, this domain writes the mount column).

## Emits-Listens
- None emitted in-domain (no broker import in `channel-mount-service.ts`); `routes/channel-mounts.ts` emits `channel:mount-updated`, `category:mount-updated`, `workspace:mount-updated` outside the gate.

## Owns
- `channels.folderPath` (writes: set validated resolved path, clear on `null`/empty)
- `categories.folderPath` (writes: set validated resolved path, clear on `null`/empty)
- `workspaces.metadata.customMountPath` (writes: set on attach, `null` on detach)
- Zone A `workspaces.rootPath` is **not** owned here — this domain never writes it.

## Flags
- `WORKSPACE_DIR` — the sandbox base, and therefore one of the two default allowed roots (`workspace-registry.ts:110-113`).
- No in-domain feature flag. `ALLOWED_MOUNT_ROOTS` and `ALLOW_SERVER_PICKER` were **removed**: the jail is per-workspace registry policy (`allowedMountRoots`) and the server-spawned picker has no reachable caller.

## Decisions
- `[Observed]` 2026-09-23 route registration is pinned by test: `channelMountRoutes` was discovered never registered in `routes/index.ts` (every mount endpoint 404'd in production while private-app integration tests passed). Registration now lives in `routes/index.ts` and `routes/index.test.ts` asserts every mount endpoint answers on the real `registerRoutes` entrypoint.
- `[Observed]` 2026-09-23 attach write failures surface: `attachChannelMount`/`attachCategoryMount`/`setEffectiveMounts` (workspace branch) previously swallowed store-write errors and returned `ok: true`, so a broken store answered 200 with a mount that was never written. Failures now return `{ ok: false, error }` (route 400).
- `[Observed]` 2026-09-23 canon `fsMounts` has PG parity: `channels.fs_mounts` and `categories.fs_mounts` (jsonb, migration 0021) mirror the local tier, and the PG branches of `updateChannel`/`updateCategory` plus sync push/pull/replay carry the descriptor — dual-write convergence no longer silently drops virtual mounts. PG rows predating the column read as `undefined` and keep the local tier's read-side "inherit" defaulting.
- `[Observed]` 2026-09-22 canon virtual mounts: mounts are described in VIRTUAL paths (agent-visible `source` → `target`) and resolved through `inherit`/`override`, with the first override walking channel → category → workspace winning. This is deliberately separate from host `folderPath`/`mountPath`, which stay jailed by `validateMountPath`. `vfs/` is never a mount target.
- `[Observed]` Per-workspace registry jail with a sandbox+home default — why: `ALLOWED_MOUNT_ROOTS` was undocumented, so mounting a real repository failed until the operator found it, and user repositories live under the home directory.
- `[Observed]` Realpath + containment check (not string-prefix on raw input) — why: symlink escapes must resolve before the roots comparison.
- `[Observed]` 60s/200-key realpath `TtlCache` — why: validate/browse hit the same roots repeatedly; stat + realpath syscalls dominate.
- `[Observed]` Invalid-mount fallthrough instead of error, with the first failure kept as `reason` — why: a stale/broken mount at one level must not brick the channel, but the panel still has to explain an empty tree.
- `[Observed]` Null/empty attach clears without validation — why: detach must always succeed even when the old path is gone or outside new roots.
- `[Observed]` Zone A and Zone B are separate fields (`rootPath` vs `mountPath`) — why: conflating them made mounting a repository write `.crowdos/` into the user's working tree and made workspace deletion `rm -rf` that repository.
- `[Observed]` `resolveEffectiveRoot` returns the Zone A fallback itself rather than letting callers derive it — why: the panel and the agent tools drifted apart precisely because each derived the fallback separately.
- `[Observed]` Browse clamps into roots but throws on a missing path — why: navigation outside the jail is a UX clamp, while a deleted cwd is a caller-visible 400.
- `[Observed]` Dotfile hiding through the shared `isVisibleEntryName` rule — why: the picker and the tree previously gave two answers for the same directory; the picker's intent (repo markers are what a user browsing for a repository looks for) is the better rule.
- `[Observed]` Server picker removed rather than kept behind a flag — why: the desktop shell owns the native dialog and the HTTP route hard-410s, so the spawn path had no reachable caller.
- `[Inferred]` Win32 path normalization (lowercase, `\\?\` strip, sep trim) applied to both sides — why: Windows case-insensitivity and extended-path prefixes would otherwise break containment.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Precedence, validation, and the single resolver stay; column ownership and the browse traversal contract are the gaps.
All channels, categories, and workspaces mount-column writes go through channelMountGate. Direct db.query writes from this domain are forbidden.
Every consumer that needs "which directory do I work in" resolves through `effectiveRoot`; no consumer re-derives the Zone A fallback.
A mount that was configured but cannot be used MUST be reported through `reason`. An empty tree that looks like an empty repository is forbidden.
Browse multi-root traversal has an explicit contract; parent nulling at the first root boundary must be intentional and documented.
Workspace slash normalization has a round-trip rule tested on win32. Mixed-separator ambiguity is not acceptable.
Unused exported record types are either ported or removed. Export-but-unreachable types are forbidden.

## Failure + Resume
- Unknown channel/category/workspace id on resolve → `{ source: none, mountedPath: null }`, never throws (`channel-mount-service.ts:340-343`, `channel-mount-service.ts:359`, `channel-mount-service.ts:118`); attach on an unknown id → `{ ok: false, error: <Type> not found }`, route 400 (`channel-mount-service.ts:254`, `routes/channel-mounts.ts:49`).
- Invalid attach path → `{ ok: false, error }` with `Path required / Invalid path / Path does not exist / Path is not a directory / Path outside allowed roots`, no write (`channel-mount-service.ts:263`, `channel-mount-service.ts:286`); route 400 with the same message.
- Configured-but-unusable mount → `none` + `reason`, surfaced by `effectiveRoot` as Zone A carrying that reason and rendered by the Repo panel as a warning banner (`channel-mount-service.ts:127-132`, `channel-mount-service.ts:204-209`).
- Browse missing path throws `Path does not exist`, route 400 `Browse failed` (`channel-mount-service.ts:448`, `routes/channel-mounts.ts:25`); file input degrades to the parent dir instead of failing (`channel-mount-service.ts:450-453`).
- No sweep or auto-heal in-domain; resume is manual: re-attach a valid path or detach to fall back down the chain.

## Gaps
- `ChannelMountRecord` / `CategoryMountRecord` / `FsBrowseEntry` are exported from `channel-mount-types.ts` but never re-exported by the gate nor used in the service; live consumers unverified. Only `WorkspaceMountRecord` is ported.
- `attachWorkspaceMount` normalizes `mountPath` slashes to `/` while `validateMountPath` returns the OS-native `resolved`; mixed-separator round-trip on win32 is unverified (`channel-mount-service.ts:266`).
- `browseFs` nulls `parent` at the roots boundary, so callers cannot navigate above the first root even when multiple roots exist; multi-root traversal intent unverified.
- Whether `channels.folderPath` / `categories.folderPath` / `workspaces.metadata.customMountPath` have a single owner (Channels/Workspace vs Mounts) is unresolved; both sides write without a gate boundary.
- The default jail includes the user's home directory, so any path under home is mountable with no configuration; whether that is the intended blast radius for a multi-tenant install is unverified.
- Canon virtual mounts (`resolveEffectiveMounts`/`setEffectiveMounts`) have persistence parity (local + PG) and passing chain tests but no transport or client yet: no route exposes them and no UI writes `fsMounts`; they resolve only from data seeded directly. Host `folderPath` mounts are the only transport-reachable mount surface.
- CM-001 fixed (fix-cm-micro-001-002): registry `mountPath` is local truth, `workspaces.metadata.customMountPath` the mirror; resolve backfills either direction (service read-time backfill) and PG attach/clear write through to the registry. Covered by T1/T2 in `channel-mount-tier-flip.test.ts`.
- CM-002 fixed (fix-cm-micro-001-002): corrupt/unreadable registry fails closed to `[sandboxBase]` (service:57) and `readAllRaw` throws instead of returning `[]` (workspace-registry.ts:247). Covered by T3 in `channel-mount-tier-flip.test.ts`.
- CM-003 fixed (fix-cm-micro-003): `channelMountGate.owns` (service:109, gate:58) + route guards on GET/PUT mount routes, browse and allowed-roots (routes/channel-mounts.ts:40,57,72,81,97,106,134,143) → 403 on cross-workspace ids; scoped callers without a query id get their own jail. Covered by T5 in `channel-mount-gate.test.ts:731-796`.

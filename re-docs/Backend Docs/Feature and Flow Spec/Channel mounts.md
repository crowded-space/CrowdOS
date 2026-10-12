# Channel mounts

> Type: Feature · Status: aligned · Updated: 2026-09-23

## Intent

Channels need to point at real folders on the host — a channel showing a repo, a category sharing one root, a workspace falling back to its sandbox — without ever escaping the directories the workspace allowed. This feature exists so mounting is validated (exists, is a directory, inside the jail, symlink-safe), resolution degrades gracefully down a precedence chain instead of erroring, browsing stays clamped inside the jail, and every consumer of "which directory do I work in" gets the same answer.

## Architectural decision

The jail is **per-workspace registry policy**, not an env var: `getAllowedRoots` prefers `record.allowedMountRoots` and otherwise allows the workspace sandbox plus the user's home directory, because that is where user repositories actually live `[Observed]`. `ALLOWED_MOUNT_ROOTS` was removed — it appeared in neither `env.ts` nor `.env.example`, so mounting a real repository failed with "Path outside allowed roots" until the operator discovered an undocumented variable. Validation resolves realpath before the containment check rather than string-matching raw input, because symlink escapes must be resolved before comparison `[Observed]`. Resolution falls through invalid levels to the next instead of erroring, keeping the first configured-but-unusable failure as `reason`, so a stale mount never bricks the channel while the panel can still explain an empty tree `[Observed]`. Zone A (the workspace's own directory, `rootPath`) and Zone B (the user's mounted repository, `mountPath`) are separate fields, and `resolveEffectiveRoot` returns whichever applies — the panel and the agent tools drifted apart precisely because each derived that fallback on its own `[Observed]`. Detach (`null`/empty attach) clears without validating, so unmounting always succeeds even when the old path is gone or outside new roots `[Observed]`. Browse clamps out-of-jail navigation back to the first root but throws on genuinely missing paths — wrong turns are UX-clamped, deleted directories are caller-visible 400s `[Observed]`. The server-spawned native picker is gone: the desktop shell owns `dialog.showOpenDialog` and `POST /api/fs/pick-folder` hard-410s, so the spawn path had no reachable caller `[Observed]`.

## How it works

`getAllowedRoots(workspaceId)` returns the workspace registry's `allowedMountRoots` when set, else `[resolveSandboxBase(), os.homedir()]` with home dropped when it equals the sandbox — there is deliberately no env read (`channel-mount-service.ts:38-57`). `validateMountPath` rejects empty and null-byte input, stat-checks directory-ness, realpaths through a 60s cache for symlink safety, then requires containment in the allowed roots with win32 normalization (`channel-mount-service.ts:77-114`). Resolution walks channel `folderPath` → category `folderPath` → workspace `mountPath` → `none`, validating each level and falling through on invalid, ending in `{ source: none, reason }` rather than throwing (`channel-mount-service.ts:295-354`); category resolution is own-mount → workspace → `none`, and workspace resolution reads **Zone B `mountPath` only** — `rootPath` is never a mount (`channel-mount-service.ts:116-135`). `resolveEffectiveRoot` collapses that chain plus the Zone A fallback into `{ path, zone, source, reason }` (`channel-mount-service.ts:188-231`), and `resolveMountScope` adds the Zone A sibling `workspaceRoot` and a `displayName` so the panel header needs one round trip (`channel-mount-service.ts:233-247`). Attach (`attachChannel`/`attachCategory`/`attachWorkspace`) 404-checks the row, clears on `null`/empty, else validates-then-writes the resolved path (`folderPath`, or Zone B `mountPath` with forward slashes for workspaces); routes re-resolve and emit `channel:mount-updated` / `category:mount-updated` / `workspace:mount-updated` outside the gate. `browseFs` defaults to the first root, clamps outside-roots input back, degrades file input to its parent dir, throws only on missing paths, filters through the shared `isVisibleEntryName` rule (repo markers `.ThisCrowd`/`.crowdos`/`.crowdosrc` stay visible, other dotfiles hidden), sorts dirs-first, caps at 300 entries, and nulls `parent` at the roots boundary (`channel-mount-service.ts:418-476`).

## Components involved

| Domain spec | Role |
| --- | --- |
| <../Domain Spec/ChannelMounts.md> | Owns mount validation, the channel → category → workspace resolution chain, the single `effectiveRoot` answer, attach/detach writes to mount columns, and rooted browse |
| <../Domain Spec/Channels.md> | Owns channel identity (names, types, archive, delete); co-owns the `channels.folderPath` column, which it never writes itself — the mount column writer lives here |
| <../Domain Spec/Workspace.md> | Owns the workspace row and its Zone A `rootPath`; this feature only writes the Zone B mount column |
| <../Domain Spec/Filesystem.md> | Owns the shared listing rule (`isVisibleEntryName`) that browse applies |

## Current state

Real: per-workspace root resolution with a sandbox+home default, symlink-safe validation with cached realpath, three resolvers with fallthrough precedence, the single `effectiveRoot`/`scope` answer, three attachers with clear-without-validate detach, and clamped dotfile-filtered browse (300 cap, dirs-first). Removed: `ALLOWED_MOUNT_ROOTS` (jail moved to the registry record), `ALLOW_SERVER_PICKER` and `pickNative` (desktop owns the dialog; the HTTP route hard-410s). Flags: `WORKSPACE_DIR` (sandbox base, hence one of the two default roots).

## Alignment notes

- 2026-09-23 production-parity fixes: the mount route module is now registered in `routes/index.ts` (it previously 404'd in the running app) and is pinned by a registration test; attach clear/set failures surface as `{ ok: false, error }` instead of a swallowed success; the canon `fsMounts` descriptor gained PG parity (`fs_mounts` jsonb on `channels`/`categories`, migration 0021) so dual-write convergence no longer drops virtual mounts; the in-app picker's browse is scoped by `workspaceId` so it enforces the same jail the attach validates against.
- 2026-09-21: rewritten for the per-workspace jail, `EffectiveRoot`/`MountScope`, and the removal of the server picker. Previous versions described `ALLOWED_MOUNT_ROOTS`, `ALLOW_SERVER_PICKER`, `pickNative`, and `MountInfo.effectivePath` — all four are gone from the code.
- Pointer only: the `allowedRoots` gate port maps to the service function `getAllowedRootsList` (`channel-mount-gate.ts:29`, `channel-mount-service.ts:479`). No behavioral difference.
- Partially stale gap: the mount record types are not all ported — the gate re-exports `WorkspaceMountRecord` (`channel-mount-gate.ts:16`) but not `ChannelMountRecord`, `CategoryMountRecord`, or `FsBrowseEntry`.
- Cross-checked against the cited code: registry-backed roots (`channel-mount-service.ts:38-57`), validate-then-contain (`channel-mount-service.ts:77-114`), three-level precedence with fallthrough and `reason` (`channel-mount-service.ts:295-354`), Zone-B-only workspace resolve (`channel-mount-service.ts:116-135`), clear-on-empty attach (`channel-mount-service.ts:255-258`), and browse clamp/filter/cap/sort (`channel-mount-service.ts:418-476`).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Mount precedence channel to category to workspace to none stays with validate-then-contain and fallthrough.
* All mount-column writes go through channelMountGate. Direct db writes are forbidden.
* Every consumer resolves through `effectiveRoot`; a consumer that re-derives the Zone A fallback is forbidden.
* A configured-but-unusable mount MUST surface its `reason`. An empty tree that reads as an empty repository is forbidden.
* Authority: ChannelMounts domain standard.
## Open gaps

- Whether `channels.folderPath` / `categories.folderPath` / `workspaces.metadata.customMountPath` have a single owner (Channels/Workspace vs Mounts) is unresolved; both sides write without a gate boundary.
- `browseFs` nulls `parent` at the roots boundary, so callers cannot navigate above the first root when multiple roots exist — multi-root traversal intent unverified.
- `attachWorkspaceMount` normalizes `mountPath` slashes to `/` while validation returns the OS-native `resolved`; mixed-separator round-trip on win32 is unverified.
- The default jail allows the user's home directory, so any path under home is mountable with no configuration — whether that is the intended blast radius for a multi-tenant install is unverified.
- `ChannelMountRecord`, `CategoryMountRecord`, and `FsBrowseEntry` are exported but unused; live consumers unverified.

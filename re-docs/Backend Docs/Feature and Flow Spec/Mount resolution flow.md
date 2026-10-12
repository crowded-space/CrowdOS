# Mount resolution flow
> Type: Flow · Status: aligned · Updated: 2026-09-23

## Intent
A channel needs to answer "which host folder am I showing" on every request — with per-channel overrides, per-category sharing, and a workspace fallback — without a stale or broken mount at one level ever bricking the channel. This flow exists so resolution degrades gracefully down a precedence chain, every level is re-validated (symlink-safe) at read time, the answer is always a value (`none` included), never a throw, and the panel and the agents get the *same* value.

## Architectural decision
Resolution falls through invalid levels to the next instead of erroring, keeping the first configured-but-unusable failure as `reason` (`channel-mount-service.ts:295-354`) `[Observed]`. Validation resolves realpath before the containment check rather than string-matching raw input, because symlink escapes must be resolved before comparison (`channel-mount-service.ts:77-114`) `[Observed]`. Roots are per-workspace registry policy with a sandbox+home default — there is deliberately no env read (`channel-mount-service.ts:38-57`) `[Observed]`. The precedence itself is channel → category → workspace → `none`, with category resolving own-mount → workspace → `none` and workspace reading **Zone B `mountPath` only** `[Observed]`. One resolver, `resolveEffectiveRoot`, then collapses the chain plus the Zone A fallback into a single `{ path, zone, source, reason }` so no consumer derives the fallback on its own `[Observed]`.

## How it works
1. A request arrives at `GET /api/channels/:id/mount` (channel), `GET /api/categories/:id/mount` (category), or `GET /api/workspaces/:id/mount` (workspace), each a thin wrap over the matching resolver (`routes/channel-mounts.ts:41`, `routes/channel-mounts.ts:60`, `routes/channel-mounts.ts:78`).
2. `resolveChannelMount(id)` returns `{ source: none }` on unknown channel, never throws; otherwise it pre-fetches the category and workspace mounts in parallel (`channel-mount-service.ts:295-310`).
3. Channel level: the channel's `folderPath` is validated (exists + directory + inside the jail via cached realpath); when valid it wins (`channel-mount-service.ts:313`).
4. Category level: on channel miss/invalid, the parent category's `folderPath` is validated the same way; when valid it serves (`channel-mount-service.ts:327`, `channel-mount-service.ts:356-390`).
5. Workspace level: on category miss/invalid, the workspace's Zone B `mountPath` serves when valid (`channel-mount-service.ts:340`, `channel-mount-service.ts:116-135`). Zone A `rootPath` is never consulted here.
6. Fallback: when every level misses or fails validation, the answer is `{ source: none, mountedPath: null }` carrying the first configured-but-unusable `reason` (`channel-mount-service.ts:348-353`).
7. Effective root: `resolveEffectiveRoot({ workspaceId, channelId })` returns Zone B (`zone: "mounted"`, `reason: null`) when a mount resolved, else Zone A via `resolveWorkspaceLocalRoot` with `zone: "workspace-local"` and the mount's `reason` preserved — so a broken mount yields a *reachable* tree plus an explanation, never an empty one (`channel-mount-service.ts:188-231`).
8. Panel scope: `resolveMountScope` adds the Zone A sibling `workspaceRoot` and `displayName`, which is what `GET /api/workspace/mount` returns and what the Repo panel header renders (`channel-mount-service.ts:233-247`, `routes/filesystem.ts:78-88`).
9. Validation at each level is `validateMountPath`: empty/null-byte fast reject, `stat` directory check, realpath through a 60s cache for symlink safety, then containment in `getAllowedRoots` output with win32 normalization — returning `{ valid, resolved?, error? }`, never throwing for bad input (`channel-mount-service.ts:77-114`).
10. Writes go the other way: `attachChannel`/`attachCategory`/`attachWorkspace` 404-check the row, clear on `null`/empty without validating, else validate-then-write the resolved path; routes re-resolve and emit `channel:mount-updated` / `category:mount-updated` / `workspace:mount-updated` outside the gate (`channel-mount-service.ts:249-416`, `routes/channel-mounts.ts:47-93`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/ChannelMounts.md> | Owns roots, validation, all three resolvers with fallthrough, the single `effectiveRoot` answer, attach/detach writes to mount columns |
| <../Domain Spec/Channels.md> | Owns channel identity (names, types, archive, delete); co-owns the `channels.folderPath` column, which it never writes — the mount column writer lives in ChannelMounts |
| <../Domain Spec/Filesystem.md> | Owns the Repo-panel route that consumes `scope`, and the shared listing rule |

Related in this folder: [Channel mounts](./Channel%20mounts.md) — system design (per-workspace jail, browse jail, removed server picker); this flow covers only the resolve + validate timeline.

## Current state
Real: three resolvers with fallthrough precedence and `reason`, per-level symlink-safe validation with cached realpath, the single `effectiveRoot`/`scope` answer consumed by the Repo panel and the agent tools, clear-without-validate detach, and route-level re-resolve + `*:mount-updated` emits. Roots come from the workspace registry record (`allowedMountRoots`) or default to the sandbox (`WORKSPACE_DIR` or `<cwd>/sandbox`) plus the user's home directory. The server picker is removed (route hard-410).

## Alignment notes
- 2026-09-23 route registration + write-failure surfacing: `channelMountRoutes` was never registered in `routes/index.ts`, so every mount endpoint (channel/category/workspace mount, fs browse, allowed-roots) 404'd in production while the private-app integration tests kept passing; registration is now pinned by `routes/index.test.ts` against the real `registerRoutes` entrypoint. Attachers and `setEffectiveMounts` no longer swallow store-write failures — a failed clear/set returns `{ ok: false, error }` (route 400) instead of a false `ok: true`.
- 2026-09-22 canon virtual mounts: mounts are now described in VIRTUAL paths (agent-visible `source` → `target`) with a canon `fsMounts { scope, mode, mounts[] }` descriptor on the workspace record, each category row, and each channel row. `resolveEffectiveMounts` walks channel → category → workspace and the FIRST `override` wins; `inherit` levels are skipped by definition, and with no override anywhere the workspace `default` set applies. Host mounts (`folderPath`/`mountPath`) keep the existing validate-then-contain jail unchanged, and `vfs/` is never a mount target.
- 2026-09-21: rewritten. Previous versions described `ALLOWED_MOUNT_ROOTS` as the jail, `effectivePath` on `MountInfo`, and `rootPath` as a workspace mount candidate — all three are gone. The `Open gaps` bullet about `none` plus a non-null `effectivePath` is resolved: `EffectiveRoot.zone` now states the answer explicitly.
- 2026-09-16 C3 slice 2: resolvers/attachers go through `channelGate` + workspace registry, so file truth applies with no DB; precedence/fallthrough unchanged.
- Pointer only: `allowedRoots` gate-port vs `getAllowedRootsList` service name (`channel-mount-service.ts:479`); partial staleness on gate re-exports of mount record types.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Precedence channel to category to workspace to none stays with validate-then-contain and fallthrough.
* Every consumer resolves through `effectiveRoot`; no consumer re-derives the Zone A fallback.
* A configured-but-unusable mount MUST surface its `reason`. An empty tree that reads as an empty repository is forbidden.
* All mount writes go through channelMountGate. Direct column writes are forbidden. Authority: ChannelMounts standard.
## Open gaps
- ~~No non-route caller of `resolve` — resolved: Tools (`resolveToolRoot`), coding-runtime (`resolveRuntimeRoot`), Runs undo, and `routes/filesystem.ts` now consume the gate; the Repo panel resolves through `scope` so it cannot disagree with the tools.~~
- Whether `channels.folderPath` / `categories.folderPath` / `workspaces.metadata.customMountPath` have a single owner (Channels/Workspace vs Mounts) is unresolved; both sides write without a gate boundary.
- `attachWorkspaceMount` normalizes `mountPath` slashes to `/` while validation returns OS-native `resolved` — mixed-separator round-trip on win32 is unverified.
- The default jail allows the user's home directory, so any path under home is mountable with no configuration — blast radius for a multi-tenant install unverified.

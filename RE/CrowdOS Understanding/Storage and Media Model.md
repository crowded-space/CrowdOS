# Storage and Media Model

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding of the persistence and media architecture: the on-disk workspace tree, mount inheritance, workspace isolation, message and agent persistence, the client-local storage mirrors, and the exact state of media handling today. This document is the ground truth for the planned agent-profile-picture feature. The canonical CrowdOS docs remain `re-docs/Frontend Docs/` and `re-docs/Backend Docs/`.

## Purpose

Describe where CrowdOS stores things, how a workspace is isolated from its neighbours, how mounts are resolved, and what happens to a file the user attaches to a message. Scope: the server's on-disk canon, the mount resolver, the local-first storage tier, the client mirrors, and the media path end to end. Visual style is out of scope.

## How it works

### The on-disk workspace tree

The sandbox base is `WORKSPACE_DIR` or `<cwd>/sandbox` (`workspace-registry.ts:137-140`). Each workspace owns **one display-name folder** under it:

```text
<sandboxBase>/<folderName>/
  workspace.json                 <- per-folder record mirror, rootPath "."
  vfs/
    .crowdos/
      workspace.json             <- runtime object: permissions, constraints, artifactDir, fsMounts
      categories.json  channels.json  channel-settings.json  sequences.json
      messages/<channelId>.jsonl  events/<channelId>.jsonl  memories/  skills/  locks/
      cache/  runtime/  snapshots/
    agents/<agentId>.json         <- one file per agent, filename == id
    artifacts/                    <- plain file storage, no index
    src/
```

- The global `<sandboxBase>/workspaces.json` is the portal/hub index and wins on load; the per-folder `workspace.json` is rewritten from it after every save (`workspace-registry.ts:190-206`, `:311-338`; `re-docs/Backend Docs/Domain Spec/Workspace.md:9-26`).
- Path helpers are the single source: `resolveVfsDir`, `resolveCrowdosDir`, `resolveAgentsDir`, `resolveSrcDir`, `resolveArtifactsDir` (`workspace-paths.ts:57-85`). `resolveArtifactsDir` **refuses** an absolute or traversal `artifactDir` and falls back to the canon default `vfs/artifacts` (`workspace-paths.ts:81-85`).
- Folder names are sanitized display names, never ids: `sanitizeWorkspaceFolderName` strips illegal characters, caps at 80 chars and avoids Windows reserved names (`workspace-paths.ts:39-49`). The `id` is the stable key; the folder may move on rename.
- Registry writes are serialized through an in-process promise chain (`workspace-registry.ts:108-112`, `:311-312`). A missing registry reads as zero workspaces; a corrupt one **throws** rather than reading as empty (`workspace-registry.ts:245-252`).

### Zone A vs Zone B

Two roots, deliberately separate:

| Zone | What | Where it lives | Who may reach it |
|---|---|---|---|
| **Zone A** | Workspace-local state: config, agent roster files, channel history, runtime state | `rootPath` on the record / `<folder>/vfs` | L0 only |
| **Zone B** | The user's mounted repository | `mountPath` on the record / `metadata.customMountPath` | any agent, through the mount chain |

`workspace-registry.ts:60-80` documents both. The separation is load-bearing: conflating them made mounting a repository write `.crowdos/` into the user's working tree and made workspace deletion `rm -rf` that repository (`workspace-registry.ts:68-72`).

### Mount inheritance

Two distinct chains, both resolved by one service (`channel-mount-service.ts`):

**Zone B path chain** — `resolveChannelMount(channelId)` (`:435-494`):
1. Channel `folderPath` → validate → **source `channel`**.
2. Category `folderPath` → validate → **source `category`**.
3. Workspace mount → **source `workspace`**.
4. Nothing → **source `none`** with a `reason` when a level was configured but unusable.

`resolveEffectiveRoot({workspaceId, channelId})` (`:308-351`) wraps that: a mounted path wins and returns `zone: "mounted"`; otherwise it returns the workspace-local root with `zone: "workspace-local"` and carries the mount's `reason` through. `resolveMountScope` (`:354-367`) adds the Zone A sibling root and a display name — this is the single answer the Repo panel and the agent file tools both consume, so they can never disagree.

**Virtual `fsMounts` chain** — `resolveEffectiveMounts({workspaceId, channelId})` (`:676-713`): channel **override** → category **override** → workspace **default**. A level whose mode is `inherit`, or which has no mount set at all, is skipped by definition. The returned `source` names the level that won, so the panel can label the mounts honestly. An empty workspace set is "nothing mounted", not "mounted with zero entries" (`:704-709`).

**Override replaces, it never merges.** `setEffectiveMounts` (`:722-769`) writes the whole set at one level: channel rows via `channelGate.update`, category rows via `channelGate.updateCategory`, workspace level via `writeWorkspaceRuntimeConfig`. There is no merge path in the resolver — the first level whose mode is `override` returns its set wholesale. `mode: "default"` is **rejected** on a channel or category (`:739-741`) because the resolver only honours `override` below workspace, so such a write would be dead data. A mount with no source or target is dropped at normalization rather than surfaced as a phantom entry (`:636-662`).

**Two guards on every mount path.** `refuseWorkspaceVfs(candidate)` (`:189-207`) walks up to four levels looking for a `vfs` directory that belongs to a workspace (identified by a `.crowdos` marker or a sibling `workspace.json`). Such a path is refused *even when it is inside the jail*, so a mount can never point at the workspace's own runtime state. The check is repeated after `realpath` so a symlink inside the jail cannot land in `vfs/` (`:172-174`). The mount jail is `getAllowedRoots(workspaceId)` (`:47-77`): the per-workspace `allowedMountRoots` record field wins; otherwise the default policy is the sandbox base plus the user's home directory. A corrupt registry **fails closed** to the sandbox base alone (`:63-67`) rather than widening the jail. `isInsideAllowedRoots` (`:79-95`) normalises case and trailing separators on Windows. The ownership guard `ownsMountTarget(kind, id, callerWorkspaceId)` (`:109-132`) stops any reachable client from rewriting another workspace's mount columns by id. `validateMountPath` (`:134-180`) is the single validator: null-byte fast path, `path.resolve`, `refuseWorkspaceVfs`, directory stat, `realpath` (cached 60 s, `:23-31`), `refuseWorkspaceVfs` again, then the jail check.

**Workspace isolation.** Isolation is **structural**, not a filter: each workspace is a separate folder tree, and the local stores resolve a path *through* the owning workspace. `resolveWorkspaceLocalRoot` and `resolveWorkspaceFolder` (`workspace-registry.ts:162-180`) are the entry points; `resolveWorkspaceAgentsDir` (`shared/core/local-file.ts:161-163`) and the message log resolver (`local-file.ts:247-273`) are built on them.

The relational tier carries the same scoping: `agents.workspace_id` is a nullable FK with a `agents_workspace_name_idx` unique index (`db/schema.ts:219`, `:250`); `messages` gained `workspace_id` in migration `0016`; `channels` gained `fs_mounts` in `0021`; `agents` gained `context_token_cap` in `0027`. The tenant hook reads `x-workspace-id` per request and fails closed with `503 WORKSPACE_DB_OFFLINE` when the workspace's database cannot be resolved (`re-docs/Backend Docs/Domain Spec/Workspace.md:54`).

On the client, switching workspace **wipes the tenant slices** before loading the new ones: `clearTenantSlices` empties `agents`, `messages`, all module caches and `archivedChannels`, and removes the eight corresponding `crowdos_*` mirror keys from `localStorage` (`crowdOsStore.ts:2771-2788`). `enterWorkspace` calls it before the new tenant fetch (`crowdOsStore.ts:2798`). A failed required tenant fetch clears the slices again (`:2263-2270`), so a half-loaded workspace never renders.

**Message and agent persistence.**

| Data | Local tier (truth) | Replica tier | Key |
|---|---|---|---|
| Channel messages | `<folder>/vfs/.crowdos/messages/<channelId>.jsonl` (append-only, locked) | Postgres `messages` | `local-file.ts:10`, `:488-494` |
| Agent profile | `<folder>/vfs/agents/<agentId>.json` (one file, filename == id) | Postgres `agents` | `local-file.ts:15`, `:160-162`; `agent-local-store.ts:111` |
| Categories / channels / settings | `<folder>/vfs/.crowdos/*.json` | Postgres tables | `Workspace.md:13-19` |
| Artifacts | `<folder>/vfs/artifacts/<runId>/<artifactId>.<ext>` | Postgres `artifacts` row | `artifacts-repository.ts:26-34` |

The model is **local-first**: the file write plus the local index *are* the commit, and the database is a best-effort replica (`artifacts-repository.ts:146-151`). `tierContextFor` resolves registry-first, then the matching per-workspace env key, and a `dbSync.state === "conflict"` record resolves local-only so no replica write is ever attempted (`workspace-registry.ts:290-309`). Convergence is a local → PG push, never the reverse (`Workspace.md:189`).

**Client-local storage mirrors.** `src/config/desktop-storage.ts` classifies every renderer key into three kinds — `ui-pref` (never evicted), `cursor` (evictable restart-survival state), `unknown` (server-mirror cache, safe to drop) — and `safeSet` implements a quota guard that evicts the largest `CURSOR_KEYS` mirror and retries once (`desktop-storage.ts:110-156`).

| Key | Kind | Scope | Source |
|---|---|---|---|
| `crowdos_pin` | ui-pref | device (global PIN) | `desktop-storage.ts:46`; `src/config/pin.ts:66` |
| `crowdos_active_channel` | ui-pref | device | `desktop-storage.ts:47`; `crowdOsStore.ts:452` |
| `crowdos_active_workspace` | ui-pref | device | `desktop-storage.ts:48`; `crowdOsStore.ts:2813` |
| `crowdos_pinned_modes` | ui-pref | device, per-channel map | `desktop-storage.ts:49`; `crowdOsStore.ts:826` |
| `crowdos_selected_mode`, `crowdos_is_pinned` | legacy | device | `desktop-storage.ts:50-51` (superseded) |
| `crowdos_muted_channels`, `crowdos_mute_<channelId>` | ui-pref | device, per-channel | `desktop-storage.ts:52-53`, `:57`; `MainChatArea.tsx:673-675` |
| `crowdos_quick_access` | ui-pref | device, capped at 8 portal recents | `desktop-storage.ts:54` |
| `crowdos_seq_cursors`, `crowdos_messages`, `crowdos_drafts`, `crowdos_outbox` | cursor | device (per-channel); `crowdos_messages` is the largest mirror | `desktop-storage.ts:64-67`; `crowdOsStore.ts:167-178`, `:459`, `:250`, `:311` |
| `crowdos_workspaces`, `crowdos_agents`, `crowdos_model_profiles`, `crowdos_instruction_modules`, `crowdos_model_modules`, `crowdos_toolkit_modules`, `crowdos_constraints_modules`, `crowdos_capabilities_modules` | unknown | device, server mirror | `desktop-storage.ts:20-27`; `crowdOsStore.ts:2784` |

**Keys the registry does not list** (they exist in code but are absent from `UI_PREF_KEYS` / `CURSOR_KEYS`): `crowdos_theme` (`src/config/theme.ts:8`), `crowdos_operator` (`components/workspace/operator-profile-model.ts:10`), `crowdos_sidebar_favorites` (`WorkspaceSidebar.tsx:67`), `crowdos_palette_recent` (`modals/palette-verbs.ts:37`), `crowdos_notification_history` and `crowdos_notification_dnd` (`ui/notification-history-model.ts:46-47`), `crowdos_jobs_by_run` (`crowdOsStore.ts:199`), `crowdos_portal_last_opened` and `crowdos_portal_hidden` (`components/portal/portal-support.ts:8-9`), `crowdos_api_key` (`src/config/socket.ts:9`), and the three per-workspace `crowdos_drawer_*` keys (`BottomDrawer.tsx:24-32`).

**Media handling today.** The media path is **broken end to end, and this is the gap the profile-picture feature must close**.

1. **Attach.** The composer reads the file with a `FileReader` and produces a **base64 data URL**: `reader.readAsDataURL(file)` (`MainChatArea.tsx:313-331`). The `Attachment` type stores it as `url: string // Data URL or object URL` (`types/crowdOs.ts:49-55`). Caps are enforced client-side: 5 MB per file (`MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024`, `MainChatArea.tsx:129`, enforced at `:305-308`) and 10 attachments per message (`:309-312`).
2. **Send.** The composer passes `attachments` into `addMessage` (`MainChatArea.tsx:606`).
3. **Drop.** The store's `addMessage` builds the socket payload and **does not include `attachments`** — the emitted `user:message` carries `channelId`, `content`, `mentions`, `mode`/`runtimeMode`, `authorName`, `authorTag`, `userPreference` and nothing else (`crowdOsStore.ts:2980-2989`).
4. **No server storage.** The server has no attachment table, no attachment column on `messages`, and no attachment route. A repo-wide search for `attachment` in `packages/server/src` returns exactly one hit, and it is a comment about an *adjacent context row* in `message-service.ts:380`.
5. **Render.** `AttachmentsView.tsx` renders whatever `file.url` holds — an image grid, a generic file card, a download link, and a lightbox (`AttachmentsView.tsx:9-157`). Because the URL is a data URL, it only works **in the session that attached it**; after a reload the attachment is gone from the message entirely.

**The only server-side binary persistence in the product is the artifact store.** `writeArtifactFile` (`artifacts-repository.ts:76-100`) writes to `<folder>/<artifactDir>/<runId>/<artifactId>.<ext>`, decodes a `data:<mime>;base64,<payload>` body into a `Buffer` before writing (`:90-92`), and returns the **folder-relative** path so the record survives a workspace-folder move (`:96`). The extension is derived from the artifact type or the caller's path (`:37-59`). The DB row is best-effort: a filesystem failure does not fail artifact creation, because the row stays a valid pointer (`:69-74`, `:172-176`). Retention is `RETENTION_DAYS` (default 30) with `0` meaning "purge everything" (`artifacts-repository.ts:316-336`); `purgeExpiredArtifacts` deletes in batches of 500 to avoid pinning locks (`:296-314`). **The purge deletes the DB row only — it does not remove the file from disk.**

**No upload endpoint and no binary-serving route exist.** `LocalFilesystem.readBinary(path)` exists (`packages/server/src/Filesystem/local-filesystem.ts:100`) but is referenced by **no route**: `routes/filesystem.ts` exposes only `GET /api/workspace/mount`, `GET /api/workspace/files`, `GET /api/workspace/files/content` (text), `POST /api/workspace/files/content` (text) and `DELETE /api/workspace/files` (`routes/filesystem.ts:78-193`). `routes/artifacts.ts` serves artifact **metadata** rows only (`routes/artifacts.ts:32`, `:54`, `:61`) — never the bytes.

**The landing zone for a profile picture.**

- **Blob path:** `vfs/agents/media/<sha256>.<ext>` — content-addressed, inside the owning workspace's Zone A, so one blob is reusable by many agents in that workspace and no blob crosses a workspace boundary. This is a **new** directory under `vfs/agents/`, which today contains only `<agentId>.json` files (`local-file.ts:160-163`).
- **Reference:** a **new additive nullable column `agents.avatar_path`** carrying the **folder-relative** path (the same convention artifacts use, `artifacts-repository.ts:31-33`). It MUST be additive: `ALTER TABLE agents ADD COLUMN avatar_path text` with no backfill and no rewrite of existing rows, and it MUST NOT be overloaded onto the existing `avatar` column.
- **Why not the existing `avatar` column.** `agents.avatar` is a nullable `text` column (`db/schema.ts:223`) that today holds **a single emoji glyph derived from the agent's level**: `newAgentLevel === 0 ? '🦅' : newAgentLevel === 1 ? '🐦' : newAgentLevel === 2 ? '🦉' : '🤖'` on create and on edit (`WorkspaceSettingsModal.tsx:641`, `:721`), preserved verbatim on a partial update (`:740`). Three renderers print it **raw**, with no image handling at all: `AgentRow.tsx:83` (`{avatar || <Bot …/>}`), `AgentProfileModal.tsx:221` (`{agent.avatar || '🤖'}`), `AgentStudioModal.tsx:189` (`{agent.avatar || '🤖'}`). Overloading it with a path would break all three renderers and the level-emoji derivation, and would silently change the meaning of an existing column — a breaking change under `AGENTS.md` §5.
- **New binary-serving route.** A `GET /api/agents/:id/avatar` (or equivalent) that resolves `avatar_path` **relative to the owning workspace folder**, verifies the resolved path stays inside that folder, and streams the bytes with a content type derived from the extension. It MUST be workspace-scoped: the tenant hook resolves the caller's workspace, and the row is read through `agentGate.getById(id, db, workspaceId)` so a foreign-workspace agent id resolves to nothing (`re-docs/Backend Docs/Domain Spec/Agents.md`, "cross-tenant fallback fix").
- **New upload leg.** A `PUT`/`POST` on the same surface that accepts the bytes, writes them to `vfs/agents/media/<sha256>.<ext>`, and sets `agents.avatar_path` to the folder-relative path. The write MUST go through `agentGate.update` so reference validation and roster-cache invalidation still run (`Agents.md` Target Contract: "All agent FK writes go through agentGate.update validation").
- **Read guard.** The read path MUST refuse any resolved path outside the owning workspace folder, and MUST refuse a path that escapes via `..` or a symlink — the same discipline `validateMountPath` applies to mounts (`channel-mount-service.ts:134-180`).

## Structural inventory

| Surface | File:line | Role | Key state |
|---|---|---|---|
| Workspace folder path layer | `server/src/workspace/workspace-paths.ts:39-108` | Folder-name sanitisation; `vfs` / `.crowdos` / `agents` / `src` / `artifacts` resolution | `DEFAULT_ARTIFACT_DIR = "vfs/artifacts"` |
| Workspace registry | `server/src/workspace/workspace-registry.ts:114-351` | `workspaces.json` CRUD, folder mirror, sandbox base, tenant context | `WorkspaceRecord` (`rootPath`, `mountPath`, `allowedMountRoots`, `folderName`, `artifactDir`) |
| Workspace runtime object | `server/src/workspace/workspace-runtime.ts` | `vfs/.crowdos/workspace.json`: permissions, constraints, `artifactDir`, `fsMounts` | `fsMounts` (workspace-level default set) |
| Mount resolver | `server/src/channel-mounts/channel-mount-service.ts:435-494` | Channel → category → workspace → none | `MountInfo { workspaceId, mountedPath, source, reason }` |
| Effective root | `channel-mount-service.ts:308-367` | One answer for the panel and the tools | `EffectiveRoot { path, zone, source, reason }`, `MountScope` |
| Virtual mount chain | `channel-mount-service.ts:636-769` | channel override → category override → workspace default | `FsMounts { scope, mode, mounts[] }` |
| Mount jail | `channel-mount-service.ts:47-95` | `allowedMountRoots` → default (sandbox + home) | `getAllowedRootsList` port |
| VFS refusal | `channel-mount-service.ts:189-207` | Refuses any workspace `vfs/` as a mount target | — |
| Filesystem routes | `server/src/routes/filesystem.ts:78-193` | Mount scope, directory listing, text read/write, delete | `root: 'effective' \| 'workspace-local'` |
| Local file primitives | `server/src/shared/core/local-file.ts:129-560` | Per-workspace path resolution, JSONL append, locks | `resolveWorkspaceFolderSync`, `appendJsonl` |
| Message + agent local stores | `server/src/messages/message-local-store.ts:88-95`; `server/src/agents/agent-local-store.ts:111-121` | `messages/<channelId>.jsonl` append; `agents/<agentId>.json` read/write/list | `localAppendMessage`, `safeAgentFileId` |
| Artifact repository + retention | `server/src/artifacts/artifacts-repository.ts:76-100`, `:296-336` | The only binary write path (`data:` URI decode) + batched age purge | `writeArtifactFile` → folder-relative path; `RETENTION_DAYS` (default 30) |
| `agents` table | `server/src/db/schema.ts:215-250` | `avatar: text("avatar")` (emoji glyph), `workspace_id` FK | `agents_workspace_name_idx` |
| Client storage registry | `client/src/config/desktop-storage.ts:42-157` | Key classification, quota guard, eviction | `UI_PREF_KEYS`, `CURSOR_KEYS`, `MUTE_KEY_PREFIX` |
| Composer attach | `client/components/workspace/MainChatArea.tsx:297-336` | `FileReader` → base64 data URL; 5 MB / 10 file caps | `attachments` (component state) |
| Message emit | `client/stores/crowdOsStore.ts:2969-2990` | `user:message` — **no attachments field** | `socket.emit('user:message', …)` |
| Attachment renderer | `client/components/workspace/messages/AttachmentsView.tsx:9-157` | Image grid, file card, download link, lightbox | `lightboxImage` |
| Tenant slice wipe | `client/stores/crowdOsStore.ts:2771-2788` | Cross-workspace state teardown | `clearTenantSlices` |

## Implementation details

**Zone separation is enforced in the resolver, not by convention.** `resolveWorkspaceMountFromRecord` reads `record.mountPath` and explicitly refuses to read `rootPath` as a mount: "Zone B only. `rootPath` is Zone A (workspace-local state) and is NEVER a mount — reading it here is what made the panel and the agent tools resolve different roots the moment a mount was set" (`channel-mount-service.ts:209-228`). `attachWorkspaceMount` mirrors the same split on write (`:369-433`), and it also back-fills the registry mirror from the PG metadata and vice-versa so a tier flip does not make the mount disappear (`:246-256`, `:274-283`).

**The `fsMounts` chain and the `folderPath` chain are different mechanisms.** `folderPath` is a single absolute directory per level; `fsMounts` is a *list of virtual mounts* with `source`/`target`/`type`/`readOnly` fields, declared in virtual paths and resolved by walking the same channel → category → workspace order (`channel-mount-service.ts:629-713`). Both are "override replaces", but they are separate stores and separate resolvers.

**A configured-but-unusable mount is reported, never silently replaced.** Every level that fails validation contributes a `reason`, and the reason survives to the panel: `resolveEffectiveRoot` copies `mount.reason` onto the workspace-local answer (`channel-mount-service.ts:322-329`), and `FileExplorer.tsx:372` turns it into an amber notice with a Retry (`FileExplorer.tsx:79-99`).

**Local-first ordering in the artifact path.** `createArtifact` writes the file first (`artifacts-repository.ts:152`), then the local index (`:174-176`), then the PG row (`:183-197`). A connection-class PG failure returns the local row rather than throwing, because the local commit already stands (`:201-209`).

**The artifact body is the one place a base64 data URI is decoded.** `writeArtifactFile` matches `/^data:[^;,]+;base64,(.*)$/s` and writes `Buffer.from(payload, "base64")`; anything else is written as UTF-8 text (`artifacts-repository.ts:90-95`). This is the exact mechanism an avatar upload would reuse — and the reason a `data:` payload can be stored as bytes rather than as base64 text.

**Client mirrors are write-through caches, not sources.** The store writes `crowdos_messages` on every message change (`crowdOsStore.ts:459`), `crowdos_drafts` and `crowdos_outbox` through their own writers (`:250`, `:311`), and `crowdos_jobs_by_run` for the run projection (`:199`). The `StorageTab.tsx` settings surface enumerates the same keys for its "clear" action (`settings/StorageTab.tsx:41-57`), which is the closest thing to an authoritative key list in the client.

**Message content is text-only on the wire.** The `Message` type carries `attachments?: Attachment[]` (`types/crowdOs.ts:85`), but the emit path drops it (`crowdOsStore.ts:2980-2989`), so the server never receives attachment metadata at all — there is no partial persistence, there is **none**.

## Interaction model

| Action | Target | Result | Evidence |
|---|---|---|---|
| Attach a file | Composer attach menu | 5 MB / 10-file caps checked; data URL stored in component state | `MainChatArea.tsx:303-331` |
| Send a message with attachments | Composer send | `addMessage` emits `user:message` **without** the attachments; the local list is cleared | `MainChatArea.tsx:600-615`; `crowdOsStore.ts:2980-2989` |
| Reload | App boot | Attachments are gone — the bytes were never persisted | `crowdOsStore.ts:2980-2989` |
| Switch workspace | Portal / dropdown | Tenant slices wiped; local mirrors for agents/messages/modules removed | `crowdOsStore.ts:2771-2788`, `:2798` |
| Set a channel mount | Repo panel OPEN FOLDER | Native dialog → `setMount('channel', …)`; server validates against the jail | `FileExplorer.tsx:392-412`; `channel-mount-service.ts:532-547` |
| Clear a channel mount | Repo panel Clear | `setMount('channel', id, null)` → inheritance returns | `FileExplorer.tsx:495-511` |
| Inherit a mount | Any channel without an override | Resolver falls to category, then workspace, then `none` | `channel-mount-service.ts:435-494` |
| Point a mount at `vfs/` | Folder picker | Refused with "Path is inside the workspace config sandbox (vfs/), which is never a mount target" | `channel-mount-service.ts:189-207` |
| Point a mount outside the jail | Folder picker | Refused with "Path outside allowed roots: …" | `channel-mount-service.ts:175-178` |
| Create an artifact | Runtime | File written under `vfs/artifacts/<runId>/`, DB row is a best-effort replica | `artifacts-repository.ts:137-210` |
| Expire an artifact | Retention sweep | DB row purged in batches of 500; **the file stays on disk** | `artifacts-repository.ts:300-314` |
| Set the agent avatar glyph | Settings → Agents Board | `avatar` is overwritten with the level emoji on create/edit | `WorkspaceSettingsModal.tsx:641`, `:721` |

## Performance notes

| Aspect | Approach | Evidence |
|---|---|---|
| Registry reads | 60 s TTL cache per workspace id, invalidated on save/remove | `workspace-registry.ts:29`, `:329` |
| Registry writes | Serialized through an in-process promise chain | `workspace-registry.ts:108-112` |
| Mount realpath | 60 s TTL cache, 200 entries | `channel-mount-service.ts:23-31` |
| Message appends | Per-file lock + append-only JSONL; `appendJsonlIfAbsentById` for idempotent replay | `local-file.ts:488-494`, `:498-516` |
| Artifact listing | Explicit column projection with `substring(…, 1 for 500)` truncation of `patch` / `contentRef` | `artifacts-repository.ts:259-267` |
| Artifact purge | Batched deletes, 500 ids per statement | `artifacts-repository.ts:296-314` |
| Client quota | Largest `CURSOR_KEYS` mirror evicted first, then one retry | `desktop-storage.ts:110-156` |
| Message mirror | Capped per-channel mirror; largest mirror evicted first under quota pressure | `desktop-storage.ts:65`; `:110-140` |
| Deep-link / tenant fetch | Parallel REST fetch of 5 independent endpoints with a 30 s abort signal | `crowdOsStore.ts:2226-2240` |

## Evidence

| ID / pointer | What it shows |
|---|---|
| `re-docs/Backend Docs/Domain Spec/Workspace.md:9-26`, `:60-132` | Canonical on-disk tree, Zone A/B split, gate ports |
| `packages/server/src/workspace/workspace-paths.ts:39-108` | Folder sanitisation and the `vfs` path helpers |
| `packages/server/src/workspace/workspace-registry.ts:44-206` | `WorkspaceRecord` shape, sandbox base, folder mirror, lock |
| `packages/server/src/channel-mounts/channel-mount-service.ts:47-213` | Jail, ownership guard, `validateMountPath`, `refuseWorkspaceVfs` |
| `packages/server/src/channel-mounts/channel-mount-service.ts:308-367` | `resolveEffectiveRoot` / `resolveMountScope` |
| `packages/server/src/channel-mounts/channel-mount-service.ts:435-494` | The channel → category → workspace mount chain |
| `packages/server/src/channel-mounts/channel-mount-service.ts:636-769` | The virtual `fsMounts` chain and the replace-not-merge writer |
| `packages/server/src/routes/filesystem.ts:72-193` | Every filesystem route — all text, no binary |
| `packages/server/src/shared/core/local-file.ts:10-15`, `:160-163`, `:488-494` | Message log path, agents dir, JSONL append |
| `packages/server/src/artifacts/artifacts-repository.ts:26-100` | The only binary write path and its `data:` decode |
| `packages/server/src/artifacts/artifacts-repository.ts:296-336` | Batched purge and `RETENTION_DAYS` |
| `packages/server/src/db/schema.ts:215-250` | `agents.avatar` (emoji) and `agents.workspace_id` |
| `packages/server/src/Filesystem/local-filesystem.ts:100` | `readBinary` — defined, referenced by no route |
| `packages/client/src/config/desktop-storage.ts:42-157` | Key classification, quota guard, eviction |
| `packages/client/components/workspace/MainChatArea.tsx:297-336`, `:600-615` | The attach path and the send that drops the attachments |
| `packages/client/stores/crowdOsStore.ts:2969-2990` | The `user:message` emit — no attachment field |
| `packages/client/components/workspace/messages/AttachmentsView.tsx:9-157` | Render + lightbox for data-URL attachments |
| `packages/client/stores/crowdOsStore.ts:2771-2788` | `clearTenantSlices` — the client tenant wipe |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:641`, `:721`, `:740` | The level→emoji derivation and its preservation on edit |
| `packages/client/components/workspace/AgentRow.tsx:83`; `modals/AgentProfileModal.tsx:221`; `components/studio/AgentStudioModal.tsx:189` | The three renderers that print `avatar` raw |

## Gaps

- **Composer attachments are never persisted.** `addMessage` emits `user:message` without the `attachments` field (`crowdOsStore.ts:2980-2989`), and the server has no attachment storage. The bytes live only in the component's `useState` until the component unmounts (`MainChatArea.tsx:233`, `:613`). The 5 MB / 10-file caps (`MainChatArea.tsx:129`, `:305-312`) are therefore **client-only** and enforce nothing durable.
- **`AttachmentsView` renders data URLs it will never see again.** It is written to render `file.url` as an image source and a download `href` (`AttachmentsView.tsx:53-57`, `:70-79`, `:119-126`), which only works for the session that attached the file. There is no server URL, no content-addressed handle, and no rehydration path.
- **There is no upload endpoint and no route that serves file bytes.** No route in `packages/server/src/routes/` accepts binary; the only binary write in the product is `writeArtifactFile` (`artifacts-repository.ts:76-100`), reached through the artifact domain, not through a generic upload surface. `LocalFilesystem.readBinary` (`local-filesystem.ts:100`) has **no caller**; `routes/filesystem.ts` serves text content only (`:128-150`); `routes/artifacts.ts` serves metadata rows only (`routes/artifacts.ts:32-64`). Any binary feature needs both legs.
- **Artifact retention deletes rows, not files.** `purgeExpiredArtifacts` issues only `db.delete(artifacts)` (`artifacts-repository.ts:310`). The files under `vfs/artifacts/<runId>/` are orphaned on disk and are never reclaimed. A binary-avatar feature must not copy this pattern.
- **The artifact directory is not a general binary store.** It is namespaced by `runId` and indexed by the `artifacts` table (`artifacts-repository.ts:84-87`); there is no content-addressed, workspace-scoped blob area. The proposed `vfs/agents/media/<sha256>.<ext>` would be the first.
- **The client storage registry is incomplete.** `desktop-storage.ts` enumerates 21 keys; at least twelve more exist in code (`crowdos_theme`, `crowdos_operator`, `crowdos_sidebar_favorites`, `crowdos_palette_recent`, `crowdos_notification_history`, `crowdos_notification_dnd`, `crowdos_jobs_by_run`, `crowdos_portal_last_opened`, `crowdos_portal_hidden`, `crowdos_api_key`, and the three `crowdos_drawer_*` families). Unregistered keys are classified `unknown` by `getStorageKind` (`desktop-storage.ts:74-80`), so they are **never quota-evicted** and are not covered by the Storage tab's inventory in a single place.
- **`crowdos_api_key` is a credential in `localStorage`.** `src/config/socket.ts:9`, `:137-138` read and write it. It is outside the documented `ui-pref` set and outside the `crowdos_pin` "MUST stay in localStorage" note, and it has no separate treatment in `desktop-storage.ts`.
- **`vfs/` is not a mount target, but it is not a *write* target either.** `refuseWorkspaceVfs` only guards the mount path (`channel-mount-service.ts:189-207`). `routes/filesystem.ts:153-168` writes through `LocalFilesystem.write` with the workspace root as the jail, and the agent file tools write into the same tree. Whether an agent can write into `vfs/agents/media/` — where the proposed avatar blob would live — is **not verified**; the tool guard's rules for the workspace-local zone were not traced here.
- **The `agents.avatar` column is a level-derived emoji with no provenance.** It is recomputed on every create and every edit (`WorkspaceSettingsModal.tsx:641`, `:721`) and preserved only on a partial update that omits it (`:740`). It is a *derived presentation value stored as data*, which is why it must not be overloaded with a path. A dedicated `avatar_path` column is the additive shape.
- **The agents table has no `avatar_path` column today.** `db/schema.ts:215-250` shows only `avatar`. The next migration slot is `0030` (`packages/server/src/db/migrations/` ends at `0029_model_module_endpoint_thinking.sql`); the migration must also be added to `meta/_journal.json`, or drizzle will not apply it — the same failure mode recorded for `0027` in `re-docs/Backend Docs/Domain Spec/Agents.md` ("0027 was missing from `meta/_journal.json` … the column existed solely in `schema.ts` on migrated DBs").
- **No blob garbage collection exists for agent media.** Content-addressed blobs are never swept, and a workspace delete removes the folder only when it holds nothing CrowdOS did not create (`Workspace.md:186`). Whether a shared blob referenced by two agents survives a single agent's deletion is **not verified**.
- **`readBinary` has no caller and therefore no path-containment review.** The jail logic that `LocalFilesystem.read`/`write`/`list` use is not applied to any binary route because no binary route exists. A new avatar-serving route must reuse that containment, not invent its own.

## User Decision:

## Target Contract

> Status: Target. CrowdOS's locked design contract (`AGENTS.md` §3, §5, `UX_GUIDELINE.md` §1, §10) takes precedence over anything observed here. The avatar-pictures feature is planned; this contract states the invariants it must not break.

* **Workspace is the isolation boundary.** Same-named agents in different workspaces share nothing — memory, history, config, mounts (`AGENTS.md` §5.10). A blob must be stored inside the owning workspace folder and MUST NOT be readable from another workspace.
* **Every query touching agents, channels, history or memory is workspace-scoped.** A new avatar read MUST resolve the agent through `agentGate.getById(id, db, workspaceId)` and MUST NOT use the unscoped local fan-out read.
* **Mounts inherit Workspace → Category → Channel, and an override REPLACES, never merges** (`AGENTS.md` §5.11). A new blob area inside `vfs/` is workspace-local state, never a mount target, and MUST be refused by `refuseWorkspaceVfs` like the rest of `vfs/`.
* **Local-first.** The local filesystem is the source of truth; Redis and pgvector stay optional and the app degrades gracefully (`AGENTS.md` §5.12). An avatar blob write MUST succeed locally even with no database configured, and the database row MUST be a best-effort replica.
* **Gate discipline.** Nothing outside a domain folder may import past its `*-gate.ts` (`AGENTS.md` §3). A new upload/read route MUST call the owning domain's gate, not its internals.
* **Schema changes are a breaking-change surface** (`AGENTS.md` §5). `agents.avatar_path` MUST be additive, nullable, and MUST NOT reshape or reinterpret `agents.avatar`. The migration MUST be journal-listed.
* **An existing column's meaning MUST NOT change.** `agents.avatar` continues to hold the level-derived emoji that `AgentRow.tsx:83`, `AgentProfileModal.tsx:221` and `AgentStudioModal.tsx:189` print raw.
* **No mock data, ever** (`UX_GUIDELINE.md:141`). A missing avatar MUST render the existing fallback, never a placeholder image.
* **Attachments MUST have a server-authoritative size cap and MUST surface upload progress** (`../Discord Findings/Composer.md`, Target Contract). The current 5 MB / 10-file caps are client-only and MUST be re-asserted server-side once a binary path exists.
* **Every destructive or irreversible path confirms with scope preview** (`UX_GUIDELINE.md:126`). Replacing or clearing an avatar MUST name the file being replaced.
* **Instrumentation is counts and latencies only** — never message content, file contents, secrets, or memory writes (`UX_GUIDELINE.md:144`).

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| Per-workspace on-disk tree, Zone A vs Zone B | Discord's server-side storage is entirely opaque to the client; the a11y tree exposes no filesystem concept | `../Discord Findings/Shell and Navigation.md` | CrowdOS's isolation is *structural on the local disk* — a workspace is a folder. Discord's server boundaries are invisible to the renderer, so the isolation model has no counterpart to compare against. |
| Mount chain channel → category → workspace, override replaces; `vfs/` refused as a target; per-workspace mount jail | Guild/channel permission overwrites are a different mechanism entirely; Discord has no user-mounted folders | `../Discord Findings/Roles and Authority.md`; `../Discord Findings/Composer.md` | Discord's authority stack is three layers (guild roles → channel overwrites → owner) resolved at render time. CrowdOS's mount chain is a *path* resolution, not an authority stack, and the two must not be conflated: `AGENTS.md` §5.3 keeps authority on the tier, §5.11 keeps paths on the mount chain. Discord has no filesystem surface at all; the closest is the external-link guard in `../Discord Findings/Desktop Shell Delta.md`. |
| Content-addressed local blob (proposed `vfs/agents/media/<sha256>.<ext>`) | Discord stores user avatars and uploads server-side behind CDN URLs, never as client-visible paths | `../Discord Findings/Right Panel and Members.md` | Discord's avatar is a CDN URL rendered into an `<img>`; CrowdOS's proposed model is a local, workspace-scoped, content-addressed file referenced by a folder-relative path. Discord's contract ("Every right-panel row MUST carry the same accessibility contract") says nothing about storage, so the CrowdOS model is unconstrained by it. |
| Composer attachment → base64 data URL → **dropped on emit** (`crowdOsStore.ts:2980-2989`) | Hidden `<input type=file multiple>` + per-channel upload store + 50 ms-throttled progress + server-driven perk size caps (50/100/250 MB) | `../Discord Findings/Composer.md` | Discord's upload path is first-class: `getUploads(channelId, draftType)`, `UPLOAD_CANCEL_REQUEST` restores the draft, and the cap is server-driven per perk. CrowdOS's path stops at the emit — the bytes are lost. CrowdOS's client-side 5 MB / 10-file caps are the opposite of Discord's server-driven caps. |
| One composer for every surface, attachments strip separate from the input | `chatInputType` registry with 24 type records, each with its own `attachments` / `hideAttachmentBar` / `hideAttachmentArea` flags | `../Discord Findings/Composer.md` | Discord parameterises the composer by *type* and each type declares its own attachment capabilities. CrowdOS has one composer shape and one attachment strip. Discord's contract ("one text input, one accessory bar, one send affordance, one attachment strip") is satisfied by CrowdOS. |
| Draft mirror `crowdos_drafts` (per-channel, restart-survival) | `DRAFT_SAVE` / `DRAFT_CHANGE` / `DRAFT_CLEAR` actions, keyed `userId → channelId → draftType`, autosave throttled to 500 ms | `../Discord Findings/Composer.md` | Discord's draft store is a persisted, per-user, per-draft-type key; CrowdOS's is a single `crowdos_drafts` localStorage blob keyed by channel. CrowdOS's throttle is not verified here. |
| Message history `messages/<channelId>.jsonl` + a `crowdos_messages` client mirror | Discord's message list is paginated over REST, non-virtualised, held in a store | `../Discord Findings/Message List.md`, `../Discord Findings/Performance Model.md` | CrowdOS persists history to disk as append-only JSONL *and* mirrors a capped copy into `localStorage` — two copies of the same data with different lifecycles. Discord keeps one authoritative store and pages over REST. CrowdOS's `crowdos_messages` mirror is the largest evictable key, which is the cost of the duplication. |
| Notification history `crowdos_notification_history` (device-local) | Discord's notification centre is a server-backed inbox surface | `../Discord Findings/Shell and Navigation.md` | CrowdOS's notification history is a device-local journal with a local DND schedule; Discord's is server state. Nothing CrowdOS records on one machine is visible to another. |
| Local-first dual tier: file write is the commit, Postgres is a best-effort replica | Discord's server is the only tier; there is no local-first path | `../Discord Findings/Desktop Shell Delta.md` | CrowdOS's whole storage model — local truth, optional replica, registry-first routing, conflict quarantine — has no Discord counterpart. Discord's contract ("the lock screen belongs to the shell, not to a remote session") is orthogonal. |
| Workspace-scoped read guard for a new binary route | Discord's own navigation guard blocks external URLs and popups in the main process | `../Discord Findings/Desktop Shell Delta.md` | Discord's analogue is an *outbound* guard (fail-closed URL parsing, origin equality). CrowdOS's analogue would be an *inbound* guard: resolve the blob path inside the owning workspace folder and refuse anything that escapes it. Discord's contract requires the fail-closed posture on both sides. |

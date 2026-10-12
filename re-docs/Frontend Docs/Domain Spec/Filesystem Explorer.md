# Filesystem Explorer

## Purpose

The Repo panel: browse the **effective root** for the active channel, mount or clear the working directory it points at, open a file into the chat code popup, and review run diffs with apply/revert. Four surfaces live in this area — the tree panel (`FileExplorer`), the mount editor (`FolderMountPicker`), the diff viewer (`DiffViewer`), and the checkpoint row (`CheckpointRow`) — and every copy decision (which folder, why that folder, what to say when there is nothing) is delegated to one pure view model, `explorer-model.ts`, so the honest-state rules are not scattered across JSX.

## Feature Scope

In-scope: the panel header (folder name, mount-source badge, root path, Refresh, Close), the `OPEN FOLDER` mount entry point with the native OS dialog and its in-app fallback, the manual-path plus in-app-navigator editor, mount clear with scope-preview confirm, the VS Code–style lazy tree with keyboard navigation and its distinct loading/failure/empty states, the separate openable read-only `Workspace Local` (Zone A) root shown only to L0 rosters, and the diff viewer with unified/side-by-side views plus per-file apply/revert, Apply-all, per-file Copy/Download, real-payload hunk notes, a pre-apply conflict notice, and the checkpoint row with file-listed Restore — all diff mutations under one shared busy lock.
Non-goals: the chat code editor popup itself (see Chat Area — `SandboxCodeViewer`), the roster side of the right panel (see Workspace Shell), workspace settings tabs and DB provisioning (see Modals / Portal), approval-gated writes, and the server-side mount jail and validation rules (see Backend `ChannelMounts.md` and `Filesystem.md`).

## Expect

- `[Observed]` The panel renders the **effective root** for the active channel. One root request returns both the scope (`path`, `zone`, `source`, `reason`, `workspaceRoot`, `displayName`) and the root listing, so the header and the tree cannot disagree about which directory is on screen (`FileExplorer.tsx:180-187`; `routes/filesystem.ts:91-125`).
- `[Observed]` The header names the folder (`displayName`), the inheritance source as a badge — Channel mount / Category mount / Workspace mount / Workspace sandbox / Not mounted — with a tooltip explaining *why* that source won (§16 chain), and the absolute path with a drive icon.
- `[Observed]` `OPEN FOLDER` is the mount entry point. With the desktop bridge present it opens the native OS folder dialog; without it, it toggles the in-app picker. A picked folder is saved to the active channel immediately; cancel or an empty result returns silently. The button is disabled when no channel is active (`FileExplorer.tsx:391-411,468-483`).
- `[Observed]` `Manual…` is offered only when the native bridge exists (it would be redundant otherwise), and reveals the editor: type a path, or browse the host filesystem in-app — directories only, allowed-root chips, parent-up, refresh, and "Mount this directory".
- `[Observed]` `Clear` appears only while a mount is set, and returns the channel to its category/workspace inheritance.
 - `[Observed]` `Clear` appears only while a mount is set, and returns the channel to its category/workspace inheritance. The composer preflight mirrors the same effective root as a short-path chip with the source badge + why-tooltip (reusing `sourceLabel/sourceHint`); the chip is a real button that opens this panel (`setRightPanelView('repo')`) — entry affordance only; the full matrix lives in the Settings Mounts tab (`MountsInspector`).
- `[Observed]` Mounts matrix (2026-10-04): the Settings Mounts tab renders Workspace, Category, and Channel cards side by side with the effective winner badged Winner and why-explained via `sourceHint`, each card browsing through the same `FolderMountPicker` used by the panel header; Clear stays confirm-guarded and only-while-set; override replaces, never merges, with no virtual filesystem (`MountsInspector.tsx:236-334,496-511`; readers `api/client.ts:516-545`).
- `[Observed]` Mounts matrix (2026-10-04): the Settings Mounts tab renders Workspace, Category, and Channel cards side by side with the effective winner badged Winner and why-explained via `sourceHint`, each card browsing through the same `FolderMountPicker` used by the panel header; Clear stays confirm-guarded and only-while-set; override replaces, never merges, with no virtual filesystem (`MountsInspector.tsx:236-334,496-511`; readers `api/client.ts:516-545`). Verify polish: per-card read failures render cause plus Retry and Browse next to the jail-aware browse-allowed-folder path.
- `[Observed]` Folders expand lazily with a spinner; children are cached per path and re-read only on Refresh or a `filesystemRevision` bump; a file click hands the path to the chat code popup.
- `[Observed]` The tree is keyboard-navigable: Arrow Down/Up move, Arrow Right expands then steps in, Arrow Left collapses or jumps to the parent, Home/End jump to the ends, Enter/Space activate.
- `[Observed]` Rows follow VS Code’s metrics — 22px line height, 12px indent step, 16px disclosure gutter, 14px muted icons, and a flat full-width selection band rather than a rounded pill (`FileExplorer.tsx:29-34,70-76`).
- `[Observed]` Rows expose the ARIA tree contract: `role="tree"` / `role="treeitem"`, `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`, `aria-selected`, and `tabIndex={-1}` with focus moved programmatically by `.focus()`.
- `[Observed]` `Workspace Local` renders as a **separate, labelled, openable read-only root** below the tree — own collapsible header, `L0` badge, its own load/failure/empty state, file activation carrying the `workspace-local` root — and is never merged into the repository tree (`FileExplorer.tsx:559-607`).
- `[Observed]` A configured-but-unusable mount renders an amber notice naming the reason, instead of silently falling back to the sandbox and looking like an empty repository.
- `[Observed]` Diff viewer fetches artifacts per run, renders unified or side-by-side, shows short before/after hashes, and offers per-file Apply/Revert plus Apply-all (runId, more than one diff), per-file Copy/Download, real-payload hunk notes (honest empty when the run recorded none), and a pre-apply conflict notice (live file vs before/after image via `getWorkspaceFileContent`, Apply-anyway/Dismiss) — all under the shared `diffBusy`/`diffError` store lock with error-with-cause-and-retry.
- `[Observed]` Checkpoint row (`CheckpointRow { runId; runtime }`) renders above the inline diff for Coding/Swarm runs: snapshot time (min `createdAt` across run artifacts — no snapshot endpoint exists, so the minimum is the honest derivation), diff count, distinct files-touched list, Restore under the shared busy lock, and the confirmed-restore audit line (`restoreAuditByRun`) when one exists.
- `[Observed]` Clearing a mount confirms first: the `ConfirmDialog` names the current path and the resulting effective change (channel inherits category/workspace; category falls back to workspace; workspace resets to the sandbox) before the existing `handleClear` runs.

## Flow

1. Open panel: `FileExplorer` reads `activeWorkspaceId`, `activeChannelId`, `agents`, `selectedSandboxFile`, `filesystemRevision` from the store (`FileExplorer.tsx:342-355`) and drives two `useDirectoryTree` instances — `effective` always, `workspace-local` only when `hasL0Agent(agents)` (`:364-365`).
2. Load root: each instance fetches `GET /api/workspace/files?path=/&workspaceId=…&channelId=…&root=…` on mount, on workspace/channel change, and on every `filesystemRevision` bump (`FileExplorer.tsx:176-202`). The route resolves the root through `channelMountGate.scope` and answers `{ …scope, root, nodes }`; a missing root is a 404, not an empty list.
3. Expand folder: the first toggle fetches `GET /api/workspace/files?path=<dir>&…` once and caches the children under that path; later toggles reuse the cache and Refresh is the explicit re-read (`FileExplorer.tsx:204-238`).
4. Select file: `setSelectedSandboxFile(entry.path, root)` with the tree's own root (`effective` for the repository, `workspace-local` for Zone A); the chat popup renders `SandboxCodeViewer` for that path with that root, so a Zone A path is never read through the effective root (`SandboxCodeViewer.tsx`). Zone A files open read-only with an `L0` badge and a no-save guard (Save/Revert disabled, editing locked).
5. Mount via `OPEN FOLDER`: `pickDirectoryNative(repo.scope?.path)` → `PUT /api/channels/:id/mount { folderPath }` → `incrementFilesystemRevision()` plus a success toast (`FileExplorer.tsx:378-411`). No bridge → `setPickerOpen(true)` instead, because a browser tab cannot open a native dialog at all.
6. Mount via the editor: `FolderMountPicker` saves through `apiClient.setMount(…)` (`:53-68`), clears with `null` (`:70-83`), and its own native button auto-saves on selection (`:85-111`).
7. In-app browse: `loadDirectory` GETs `/api/fs/browse` scoped to `workspaceId` so the jail matches what attach validates against; entries drill down, allowed-root chips switch roots, and "Mount this directory" saves the browsing path (`FolderMountPicker.tsx:117-135,217-304`).
8. Refresh / close: Refresh re-runs the root fetch (`FileExplorer.tsx:422-429`); Close calls `setRightPanelView('roster')` to return the panel to the agent roster (`:430-437`).
9. Review diff: `DiffViewer` fetches per `runId`, toggles unified/side-by-side, applies/reverts per file through the store under the shared `diffBusy` lock, applies all diffs for the run via `applyAllDiffs`, and guards each apply with a `getWorkspaceFileContent` conflict read (`DiffViewer.tsx`).
10. Checkpoint + restore: the chat mounts `CheckpointRow` above the inline diff for the latest Coding/Swarm run (`MainChatArea.tsx`); Restore previews the file list in a `ConfirmDialog` and calls store `restoreRun`, which sequences the existing per-artifact revert transport and records `restoreAuditByRun[runId]`; the row renders that entry back.

## Current Implementation

| Component | Role |
|---|---|
| `workspace/FileExplorer.tsx` (`FileExplorer`, default export) | Panel host: header + scope line, `OPEN FOLDER` / `Manual…` / `Clear` row, picker host, mount warning, repository tree, Zone A section |
| `workspace/FileExplorer.tsx` (`useDirectoryTree`) | One root’s state: root fetch, lazy children cache, expanded/loading sets, failure, scope |
| `workspace/FileExplorer.tsx` (`TreeView`, `TreeRow`, `NoticePanel`, `entryIcon`, `rowClasses`) | Roving-focus tree, one row, amber notice, extension icon map, row class helper |
| `workspace/explorer-model.ts` | Pure view model — entry mapping, source label/hint, mount warning, empty copy, fetch-failure mapping, L0 detection, `flattenTree`. No React, no fetch |
| `workspace/desktop-bridge.ts` | Typed `window.crowdos.pickDirectory` wrapper: presence probe plus payload normalization |
| `workspace/FolderMountPicker.tsx` | Mount editor: native picker button, manual path, in-app navigator, clear, error display |
| `workspace/DiffViewer.tsx` (`DiffViewer`) | Run/artifact diff list with view toggle + apply/revert |
| `workspace/DiffViewer.tsx` (`UnifiedView`, `SideBySideView`, `parsePatchLines`, `splitHunks`, `HunkNotes`) | Patch line classifier, the two render layouts, hunk splitter, and the real-payload hunk-notes slot |
| `workspace/CheckpointRow.tsx` (`CheckpointRow`, default export) | Checkpoint row: snapshot/files/count + Restore with file-list scope preview + audit render-back |
| `workspace/MountsInspector.tsx` (`MountsInspector`, named + default export) | Settings Mounts tab matrix: Workspace/Category/Channel cards, effective Winner plus why, per-level `FolderMountPicker` browse, confirm-guarded Clear, live reads with no sample data |

`RepositorySelector.tsx` was deleted in this pass: it was imported by nothing, and it was the only host `FolderMountPicker` had. The mount entry point then lived in the panel header — and since 2026-10-04 the picker has two hosts: the `FileExplorer` header (channel level) and the Settings Mounts tab `MountsInspector` (one `FolderMountPicker` per Workspace/Category/Channel card).

## Props & Store

- `FileExplorer()` takes **no props**. It reads `activeWorkspaceId, activeChannelId, agents, selectedSandboxFile, selectedSandboxRoot, setSelectedSandboxFile, filesystemRevision, incrementFilesystemRevision` from `crowdOsStore` via `useShallow`.
- `selectedSandboxFile` holds the open path and `selectedSandboxRoot` names its root (`effective` for Zone B, `workspace-local` for Zone A). Each tree passes its own root on activation and only marks selection when its root matches, so the highlight never bleeds across zones. `SandboxCodeViewer` reads with that root (optional `root` prop falling back to the store value) and renders Zone A read-only: `Workspace Local — read-only` strip with an `L0` badge, editing locked, Save/Revert disabled.
- Internal (not exported) components: `useDirectoryTree(root, workspaceId, channelId, enabled, revision)` → `{ scope, rows, childrenByPath, expanded, loadingPaths, isLoading, failure, reload, toggle }`; `TreeView { rows, childrenByPath, loadingPaths, selectedPath, onActivate, onToggle, ariaLabel }`; `TreeRow { row, selected, loading, childCount, onActivate, onToggle, registerRef, onKeyDown }`; `NoticePanel { failure, onRetry? }`.
- `explorer-model.ts` exports the types `repoEntry`, `mountSource`, `mountScopeView`, `scopeFailure`, `treeRow`, `sandboxRoot` and the functions `extensionOf`, `toRepoEntry`, `toRepoEntries`, `sourceLabel`, `sourceHint`, `mountWarning`, `emptyTreeMessage`, `describeFetchFailure`, `hasL0Agent`, `isWorkspaceLocalRoot`, `sandboxRootLabel`, `parentPathOf`, `flattenTree`.
- `desktop-bridge.ts` exports `type pickDirectoryOutcome = { canceled; path }`, `canPickDirectoryNative()`, and `pickDirectoryNative(initialPath?)` — which normalizes a bare string, `{ path }`, and Electron’s `{ filePaths }`, and never throws.
- `FolderMountPicker { targetType: channel|category|workspace; targetId; workspaceId?; initialPath?; onClose?; onSaved?(path|null) }` — fully prop-driven; path, browser, allowed roots, saving, and error state are local; no store import. `workspaceId` scopes the in-app navigator's `/api/fs/browse` call to the workspace's own mount jail, so the folders the browser offers are the same ones attach will validate; `FileExplorer` passes `activeWorkspaceId`; `MountsInspector` passes `activeWorkspaceId` plus per-level `targetType`/`targetId` with `initialPath` from the live snapshot and `onSaved` re-reading that level.
- `DiffViewer { runId?; artifactId? }` reads `artifactsByRun, diffBusy, diffError, clearDiffError, activeWorkspaceId` plus `fetchArtifacts, applyDiff, revertDiff, applyAllDiffs` from the store; `viewMode`, copy feedback, per-file conflict notices, and the last-mutation record (for Retry) are local. Ports equal exports: shared `diffBusy`/`diffError` replace the old local busy.
- `CheckpointRow { runId; runtime }` reads `artifactsByRun, fetchArtifacts, restoreRun, diffBusy, restoreAuditByRun` from the store; confirm-open and restoring flags are local. Ports equal exports.
- `FolderMountPicker` clear is scope-preview guarded: the button arms a `ConfirmDialog` naming the current path and the resulting inheritance change; `handleClear` itself is unchanged.

## Relations

- Parents: `RightSidebar` lazy-hosts `FileExplorer` when `rightPanelView === 'repo'` (see Workspace Shell). `FolderMountPicker` is hosted by the `FileExplorer` header (channel level) and by each `MountsInspector` level card (workspace/category/channel). Chat embeds `DiffViewer` for the latest run.
- Children: `FileExplorer` → `FolderMountPicker`; `MountsInspector` → `FolderMountPicker` (one per level card). Nothing else.
- Store: `selectedSandboxFile` (file → chat handoff), `filesystemRevision` (refresh signal, bumped by `sandbox:updated` and by diff apply/revert), `artifactsByRun` + artifact actions.
- REST: `GET /api/workspace/files` (root listing carries the scope; nested listings are a bare array; `root=effective|workspace-local`), `GET/POST /api/workspace/files/content`, `DELETE /api/workspace/files`, `GET /api/workspace/mount`, `GET/PUT /api/channels/:id/mount`, `GET/PUT /api/categories/:id/mount`, `GET/PUT /api/workspaces/:id/mount`, `GET /api/fs/browse`, `GET /api/fs/allowed-roots`, and artifacts via the store (`GET /api/artifacts?runId=`).
- Removed: `POST /api/fs/pick-folder` is a hard 410 — the desktop shell owns `dialog.showOpenDialog`, so the client no longer calls it and no longer pretends a browser tab can reach it.

## Emits-Listens

- No socket calls in these files. The store listens for `sandbox:updated` → `incrementFilesystemRevision()` (`crowdOsStore.ts:1322-1331`), which re-fetches every tree root, and for `artifact.created/updated` + `diff.created`, which refresh diffs.
- File content save/delete and diff apply/revert go over REST via the store / `apiClient`, not sockets.

## Owns

- Per root: root entries, children cache, expanded set, per-path loading set, loading flag, failure, and scope. Zone A gets its own instance, so its state never mixes with the repository’s.
- Panel: picker open, Zone A expanded, native-picking flag.
- Picker: path, browser open, browsing path/parent/entries/allowed roots, saving and picking flags, error.
- Diff: view mode, copy feedback, per-file conflict notices, last-mutation record; busy and error are the shared store slots.
- Checkpoint: confirm-open + restoring flags; snapshot/files/count derive from `artifactsByRun` each render.
- Drawer diff tab renders the same `DiffViewer` for the latest run (see Workspace Shell slot).
- No localStorage. Selection and revision are shared through the store.

## Flags

- No env vars and no feature toggles in these files. `BACKEND_URL = ''` was deleted from `FileExplorer.tsx` — it was a dead constant that nothing read; all calls go through `apiClient`.
- One runtime capability probe: `canPickDirectoryNative()` (presence of `window.crowdos.pickDirectory`). It is not a build flag — it selects which mount path the button takes.
- Responsive behavior is inherited from the host panel (fixed 260px panel — see Workspace Shell).

## Decisions

- `[Observed]` 2026-09-23 the picker browses the workspace's jail, not the default one. `browseFilesystem(dir, null)` used the default roots (sandbox + home), which could offer folders a workspace with narrow `allowedMountRoots` would then refuse on attach — the picker and the saver disagreed about what is mountable.

- `[Observed]` One root request answers both "which folder" and "what is in it". The listing carries the whole scope, so the header and the tree can never disagree — the earlier design fetched them separately and could.
- `[Observed]` Folders fetch children lazily and cache per path; later toggles reuse the cache and Refresh is the explicit re-read. Cheap initial load, with manual plus revision-triggered refresh as the staleness backstop.
- `[Observed]` Zone A is a separate labelled root, never a folder merged into the repository tree, and openable read-only — the two zones have different owners and different authority, and the viewer carries the root so a Zone A path is never read through the effective root.
- `[Observed]` Native dialog first, manual path and in-app navigator second — and `OPEN FOLDER` degrades to the in-app navigator rather than calling a route that can only 410 (`FileExplorer.tsx:388-411`; `FolderMountPicker.tsx:100-104`).
- `[Observed]` The mount is saved through `apiClient.setMount(…)` and the panel then bumps `filesystemRevision` instead of trusting an optimistic local copy: the server owns the mount, so every reader re-resolves.
- `[Observed]` Flat full-width selection and 22px rows — VS Code’s row model, chosen so a deep tree stays scannable rather than reading as a stack of cards.
- `[Inferred]` A directory that vanishes between listing and expanding is reported inline (amber notice, cached as empty) rather than as a toast, because build output and git operations make that routine rather than exceptional.

## User Decision:

## Architectural Standard (Target)
> Status: Target. The tree, the mount ordering, and the single-busy diff lock stay; cache invalidation, diff failure paths, and the remaining dead exports are the gaps.
Lazy folder fetch with a per-path cache stays. Staleness is bounded by manual plus filesystemRevision-triggered refresh.
Native dialog first, manual path second, in-app navigator third stays as the mount ordering.
Diff apply and revert share one busy lock. Concurrent mutations on one artifact are forbidden.
Decorative or static state MUST NOT be rendered as live state. The "Filesystem Connected" / "Sandbox live sync" labels and their fake avatar chips were removed in this pass; re-introducing perceived-liveness text is forbidden.
The mount entry point MUST be reachable from the panel itself. An orphaned picker with no importer is forbidden — this is what `OPEN FOLDER` fixes and what `RepositorySelector` violated.
Dead exports alongside live tree code are forbidden. `mockFileContent` / `SimpleSyntaxHighlighter` were removed in this pass.
Tree children cache MUST invalidate on filesystemRevision plus move and rename events, not root re-fetch only. Silent mid-session desync is forbidden.
Tree operation scope MUST stay explicit: this panel is a read-only browser (mount set/clear excepted). Upload, delete, rename, create, and search are out of scope and MUST NOT be implied by the UI.
Diff apply MUST surface failures, define conflict and 3-way behavior, and document post-apply refresh. Silent apply-failure is forbidden.
Mount permission, allowed-roots, and traversal guards MUST defer to the server contract documented in the ChannelMounts and Filesystem domains. Client-side-only enforcement claims are forbidden.
The two zones MUST render as distinct roots. Zone A MUST NOT be shown to an L1–L3 roster, and MUST NOT be folded into the repository tree.

## Failure + Resume

- Tree: `Loading…` with a spinner while the root loads; failure renders an amber `NoticePanel` whose headline and detail come from `describeFetchFailure` (404 → "Folder not found", 403 → "Outside the allowed folders", ≥500 → "The server could not read this folder", else "Could not load the repository") with a "Try again" action; empty renders `emptyTreeMessage(scope)`, which names the zone instead of saying "empty".
- Mount warning: `mountWarning(repo.scope)` renders above the tree when a configured mount could not be used, showing `scope.reason` — so a broken mount explains itself rather than looking like an empty repository.
- `OPEN FOLDER`: disabled without an active channel (tooltip says so); a native cancel or empty result returns silently; a server rejection (outside the jail, not a directory, missing) surfaces the route’s own message through `showError`.
- Picker: inline rose error banner (`FolderMountPicker.tsx:314-319`); a native-picker failure auto-opens the in-app navigator instead of dead-ending; Clear is always available.
- Diff: no-run/no-artifact states render explicit empty/loading cards; a missing patch falls back to a `contentRef` slice or "No patch available"; store failures render error-with-cause-and-retry from `diffError`; pre-apply conflicts render an amber notice with Apply-anyway/Dismiss instead of a silent overwrite.
- Checkpoint: renders nothing when the run has no diffs; Restore without files previews "no files listed" instead of inventing a scope.

## Gaps

- Tree children cache still invalidates only on root re-fetch or `filesystemRevision`; a mid-session move/rename can desync expanded nodes.
- No upload, delete, rename, create, or search affordances in the tree. Read-only is the intended scope, but the scope decision is not yet stated in the UI itself.
- Diff conflict/3-way notes: the pre-apply guard now surfaces live-vs-snapshot conflicts with Apply-anyway/Dismiss and failures land in `diffError` with Retry; true 3-way merge is still out of scope and recorded as such — no merge UI is implied.
- Resolved: dead `parentPathOf` export removed from `explorer-model.ts` — every export now has a consumer.
- `explorer-model.ts` has no test file, and no component tests exist for this panel (`vitest` runs `environment: 'node'`). The honest-state rules are verified by reading, not by a test.
- 2026-10-04 resolved: the unused `FolderOpen` import is removed from `FolderMountPicker.tsx`; the file now imports only used icons, scopes browse reloads on `workspaceId`, and uses `motion-safe:animate-spin` spinners.
- The L0 proxy is the agent roster (`hasL0Agent`), not operator identity. With an empty roster Zone A is hidden even when the operator is L0.
- Zone A opens read-only with the `workspace-local` root discriminator (`selectedSandboxRoot`) threaded through the existing content transport — no invented backends. Known gap: `BottomDrawer` persists preview/pinned paths to localStorage without the root, so a stale Zone A preview after reload can resolve through the wrong root; deliberately left out of scope for this patch (documented, not fixed).

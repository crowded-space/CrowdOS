# Panels, Drawers, Overlays

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding of every secondary surface: the right operations column and its five views, the bottom drawer, the narrow-width operations sheet, the run-thread drawer, and the modal/floating overlays. The canonical CrowdOS docs remain `re-docs/Frontend Docs/`; this document records what the code actually does today.

## Purpose

Describe each secondary surface in CrowdOS as implemented: what triggers it, what it renders, where its data comes from, how it refreshes, and how it handles focus. Visual style is out of scope.

Scope: `packages/client/components/workspace/` (panels, drawers, overlays), `packages/client/components/ui/` (notification centre, focus trap), `packages/client/components/lockscreen/`, and the store projections they consume.

## How it works

CrowdOS has **no permanent tabbed right column in the Discord sense**; it has a single 260 px column whose *content* is selected by a named enum, plus a set of modal and drawer overlays that mount independently of the column.

**The right operations column.** `rightPanelView` is a five-member enum — `'roster' | 'repo' | 'jobs' | 'telemetry' | 'browser'` (`types/crowdOs.ts:323`). `RightSidebar` reads it and renders exactly one branch (`RightSidebar.tsx:276-357`). The tab strip that changes it lives in the chat header, `MainChatArea.tsx:942-1000`, as a `role="tablist"` with `aria-label="Right panel view"` and one `role="tab"` per enum member; it is `hidden xl:flex`, so it exists only where the column exists. The column itself is `hidden xl:flex` (`App.tsx:243`) and each branch is a fixed `w-[260px]` `role="tabpanel"` with `aria-labelledby` pointing at its tab id (`RightSidebar.tsx:236`, `:245`, `:255`, `:262`, `:270`).

**Transition.** Animated branches use `motion/react`'s `AnimatePresence mode="wait"` with an x-slide: `initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0,x:-20}} transition={{duration:0.15}}` (`RightSidebar.tsx:279-284` and the four sibling branches). Under `prefers-reduced-motion` the component short-circuits to plain `div`s with no `AnimatePresence` at all — `RightSidebar.tsx:232-274` returns early on `useReducedMotion()`.

**Roster view.** Agents are grouped into four tier bands L0–L3 by `ag.level` (`RightSidebar.tsx:179-182`), rendered as `h2`/`h3` headings with per-tier counts (`:377-498`). Owl/librarian rows are filtered out by `isServiceAgentRow` (`:27-31`) because the heartbeat indexing service is not conversational (`UX_GUIDELINE.md:22`). Each row is an `AgentRow` receiving `id, name, species, status, level, avatar, isOmniscient` plus live-run fields (`RightSidebar.tsx:388-400`). `AgentRow` renders avatar-or-bot, a presence indicator, the `L{level}` chip, and an elapsed · cost pair (`AgentRow.tsx:82-122`). Elapsed ticks once a second from the run's `firstSeenAt` wall clock while the run is live, and renders a static snapshot otherwise; the tick is frozen under reduced motion and is never a live region (`AgentRow.tsx:56-66`). Stop appears only when `canStop` is true — derived from `isStoppableRunStatus(job.status)` — and the run id is present (`AgentRow.tsx:68`, `RightSidebar.tsx:213`). The `presenceByAgent` map (`RightSidebar.tsx:194-229`) picks the newest non-terminal job naming an agent, falling back to the newest job of any status, and reads the *same* `jobsByRun` projection `JobsView` and `RunHeader` use — never a second run model.

**Telemetry view.** A `role="tablist"` with `Channel` / `Global` tabs (`RightSidebar.tsx:535-557`) over a `role="tabpanel"` grid of four tiles (`:559-602`). The global scope polls `GET /api/observability/cost/dashboard` with the `x-workspace-id` header every 30 s (`RightSidebar.tsx:76-107`); a 401 whose body is a screenlock error re-locks the shell instead of degrading (`:79-87`). The ledger state is a tri-state — `'loading' | 'ready' | 'offline'` — because a single nullable ledger could not distinguish "still fetching" from "fetch failed" (`RightSidebar.tsx:50-53`). When the ledger is unavailable the view falls back to local sums over in-memory messages (`RightSidebar.tsx:110-174`) and says so in the tile: "Ledger offline, showing local totals." (`:568-570`). Cost is derived from real `metadata.usage` only, never from a text-length estimate (`RightSidebar.tsx:119-127`). The channel-scoped participant set is derived from the messages of the active channel (`RightSidebar.tsx:139-152`).

**Repo view.** `FileExplorer.tsx` renders a real ARIA tree: `role="tree"` with `role="treeitem"` children carrying `aria-level`, `aria-posinset`, `aria-setsize`, `aria-selected` and `aria-expanded` (`FileExplorer.tsx:121-152`, `:324`). Row metrics are locked constants — `ROW_HEIGHT = 22`, `INDENT = 12`, `CHEVRON_GUTTER = 16` (`FileExplorer.tsx:32-34`). Keyboard support is Down/Up/Right/Left/Enter/Space/Home/End (`FileExplorer.tsx:280-318`). One request answers both "which folder" and "what is in it": `getWorkspaceRoot` returns the scope *and* the root listing, so the header and the tree can never disagree (`FileExplorer.tsx:180-187`). Children are fetched lazily on first expand and cached per path; Refresh re-reads explicitly (`FileExplorer.tsx:216-222`, `:424`). A directory that vanishes between listing and expanding reports inline rather than as a toast (`FileExplorer.tsx:223-228`). Configured-but-unusable mounts render an amber notice with a Retry (`FileExplorer.tsx:79-99`, `:372`, `:533`). Zone A (workspace-local) is a separate labelled root, reachable only when an L0 agent exists (`FileExplorer.tsx:363`, `:565-610`).

**Jobs view.** `JobsView.tsx` is a cross-channel table projected from the same `jobsByRun` ingestion the header uses (`JobsView.tsx:52-95`). Filters are status / channel / agent name (`:96-115`). Stop is enabled only for live stoppable states, Retry only for `resumable` rows (`JobsView.tsx:234-237`, `:258`, `:267`) — there is no Pause because the server exposes no pause endpoint (`:48-50`, `:315-317`). Missing values render as a dash, unknown runtimes render as `"unknown"` (`:247-251`).

**Operations inbox.** `OperationsInbox.tsx` renders three sections — pending approvals, failures, mentions — plus a **Later** section for deferred approvals (`:104`, `:164`, `:207`, `:240`). Approvals come from `approvalRequests` (pending only), failures from messages whose turn status is failed/cancelled, mentions from channels with `hasMention` (`:9-13`). "Later" is **local only** via `deferLater`, and the footer states it: "Later is local-only (no server defer endpoint). Deep-links jump to the channel only." (`:278-280`). The header badge counts pending + failures + mentions — deferred approvals are excluded from it (`:48-49`, `:89`).

**Browser view.** `BrowserPanel.tsx` mounts the watch lifecycle on mount and tears it down on unmount (`:26-30`). Frames arrive over the socket as `browser:frame` events (server `browser-stream.ts`, 1 fps cadence asserted in `browser-stream.test.ts:97`). The frame is an `<img>`; clicks are scaled from rendered pixels to viewport pixels before being posted to `/api/browser/action` as `clickAt` (`:64-71`). Credentials never reach the agent — the empty state says so (`:133`).

**Bottom drawer.** `BottomDrawer.tsx` is a named-enum surface: `bottomDrawerView = 'file' | 'diff' | 'log'` (`:11`). The splitter is a `role="slider"` with `aria-valuemin/max/now`, draggable by pointer and adjustable by ArrowUp/Down (±20 px), Home (max) and End (min) (`:258-271`, `:151-190`). Height is clamped to 120–640 px with a 280 px default (`:19-21`) and persisted **per workspace** under `crowdos_drawer_height_<workspaceId>` (`:23-25`, `:139-149`). The pinned-file and preview-file paths persist the same way under `crowdos_drawer_pinned_file_*` and `crowdos_drawer_preview_file_*` (`:27-33`). The file tab renders the pinned file when one is kept, otherwise the live preview selection, and the header states which (`:237-238`, `:329-331`). The diff tab renders the latest run's `DiffViewer`; the log tab is a read-only tail of the current channel's last 100 messages (`:118-137`, `:362-379`).

**Operations sheet.** `OperationsSheet.tsx` is the below-`xl` replacement for the right column. It has its own enum `operationsSheetView = 'jobs' | 'approvals' | 'repo'` (`:11`) and reuses the *same* store projections and the same components as the desktop panel — `JobsView`, `OperationsInbox`, `FileExplorer` — with no second model and no new endpoints (`:26-34`). Tabs use roving tabindex with Arrow/Home/End (`:100-114`, `:169`). Dismissal is backdrop, Escape, or channel selection (`:75-90`).

**Focus management.** `components/ui/use-overlay-focus.ts:52-135` is the shared trap. It records the pre-open `document.activeElement`, focuses `initialFocusRef` (or the first visible focusable) inside a `requestAnimationFrame`, intercepts `Tab`/`Shift+Tab` in the capture phase to wrap inside the container, and on close restores focus to the recorded element or a `fallbackFocusSelector` (`:65-70`, `:72-87`, `:89-117`, `:126-132`). Overlays that use it: `OmniSearchModal` (`:45-48`), `QuickAsk` (`:27`), `NotificationCenter` (`components/ui/NotificationCenter.tsx:142-145`), `AgentProfileModal` (`:40`), `WorkspaceSettingsModal` (`components/workspace/modals/WorkspaceSettingsModal.tsx:343`), `InlineChannelModal` (`:28`), `OperatorProfileModal` (`:30`), `WorkspaceDropdown` (`:19`).

## Structural inventory

| Surface | File:line | Trigger | Content | Refresh mechanism |
|---|---|---|---|---|
| Right ops column | `components/workspace/RightSidebar.tsx:33` | Chat header tab strip (`MainChatArea.tsx:942`) | One of five views, 260 px | Socket (`jobsByRun`, `agents`) + 30 s ledger poll |
| — Roster view | `RightSidebar.tsx:359-513` | `rightPanelView === 'roster'` | L0–L3 tier groups of `AgentRow` | Socket-driven store projection; 1 s local elapsed tick |
| — Telemetry view | `RightSidebar.tsx:515-606` | `rightPanelView === 'telemetry'` | Channel/Global tabs, four metric tiles | 30 s ledger poll (`RightSidebar.tsx:105`) + local-sum fallback |
| — Repo view | `components/workspace/FileExplorer.tsx:342` | `rightPanelView === 'repo'` | ARIA file tree, mount header, OPEN FOLDER | Lazy per-directory fetch, cached; explicit Refresh |
| — Jobs view | `components/workspace/JobsView.tsx:52` | `rightPanelView === 'jobs'` | Cross-channel run table with filters | Socket (`jobsByRun`) |
| — Operations inbox | `components/workspace/OperationsInbox.tsx:15` | Inside the jobs branch; also its own sheet tab | Approvals / failures / mentions / Later | Store projection (`approvalRequests`, `inboxItems`) |
| — Browser view | `components/workspace/BrowserPanel.tsx:13` | `rightPanelView === 'browser'` | Live frame image, URL + text input | Socket `browser:frame`, 1 fps |
| Bottom drawer | `components/workspace/BottomDrawer.tsx:82` | `data-slot="bottom-drawer"`; "Open drawer" button | file / diff / log tabs, resizable | Store + `fetchArtifacts` on latest run id |
| Operations sheet | `components/workspace/OperationsSheet.tsx:36` | `data-slot="ops-sheet"` trigger bar; below `xl` | jobs / approvals / repo | Same projections as the desktop panel |
| Thread drawer (run branch) | `components/workspace/ThreadDrawer.tsx:260-375` | Run card "Open thread" | Pinned parent prompt, branch steps, approvals, diff, "also send" | Store messages filtered by run id |
| Thread drawer (channel threads) | `components/workspace/ThreadDrawer.tsx:377-457` | Thread affordance | Thread list, messages, composer | `GET /api/channels/:id/threads`; socket `message:new` |
| QuickAsk | `components/workspace/QuickAsk.tsx:19` | `Ctrl/Cmd+Shift+K` or palette verb | Floating scope line + textarea + Ask/Full | Store `addMessage` / `queueSend` |
| Omni palette | `components/workspace/modals/OmniSearchModal.tsx:19` | `Ctrl/Cmd+K` | Search tab + Commands tab (16 verbs) | Local verb registry + 200 ms server search debounce |
| Palette verb registry | `components/workspace/modals/palette-verbs.ts:80-99` | Commands tab | 16 verbs, fuzzy subsequence scoring | Local; recents mirrored in `crowdos_palette_recent` (cap 10) |
| Notification centre | `components/ui/NotificationCenter.tsx:131` | Header bell | History list, DND schedule, mute toggle | 60 s poll + `subscribeNotificationHistory` |
| Notification badge hook | `components/ui/NotificationCenter.tsx:110-129` | Header badge | Unread count, DND state | 60 s interval + history subscription |
| Lock screen | `components/lockscreen/LockScreen.tsx:11` | Idle timeout | PIN gate | Store `unlockWithPin` |
| Agent profile dossier | `components/workspace/modals/AgentProfileModal.tsx:14` | Roster row click | Identity, level, memory/context indicators | Store |
| Agent Studio | `components/studio/AgentStudioModal.tsx:17` | Profile → Studio | Modular slot manifest (`rack`) + prompt x-ray | `GET` agent detail; save via the studio route |
| Workspace settings | `components/workspace/modals/WorkspaceSettingsModal.tsx:284` | Workspace dropdown → Settings | 13 tabs (`WorkspaceSettingsModal.tsx:960-972`) | REST per tab |
| Focus trap | `components/ui/use-overlay-focus.ts:52` | Any overlay that opts in | Focus trap + restore | n/a |

## Implementation details

**The five views are one enum, not five components with their own state.** `rightPanelView` lives in the store and every writer goes through `setRightPanelView` — the header strip (`MainChatArea.tsx:948-996`), the palette verbs (`palette-verbs.ts:89-95`), the repo panel's own "close" button (`FileExplorer.tsx:432`), the run header (`RunHeader.tsx:81`), the run card (`RunCard.tsx:63`), and the delegation message (`DelegationMessage.tsx:19`). There is no boolean that flips meaning, which is the defect `UX_GUIDELINE.md:96` asked to be removed.

**Roster presence is a derivation, not a store.** `presenceByAgent` (`RightSidebar.tsx:194-229`) sorts `jobsByRun` newest-first and, for each agent, keeps the first live job; a terminal job only fills the slot if no live job named that agent. `stopping` is derived from `cancellingByAgent` keys prefixed with the job's channel id (`:200`) — the same projection `JobsView.tsx:239` uses. `cost` is `job.cost ?? null` and renders a dash when the server has no cost yet (`:196`, `AgentRow.tsx:41-43`).

**Telemetry honesty.** Three rules are enforced in code rather than in copy:
1. `ledgerStatus` is tri-state, so a failing poll never renders a permanent skeleton (`RightSidebar.tsx:50-53`).
2. Token counts come from `metadata.usage.totalTokens` (or prompt+completion); when absent the contribution is 0, not a length estimate (`RightSidebar.tsx:119-125`).
3. Global totals prefer the ledger when it has answered; otherwise `totalTokensConsumed` from the store plus the local sum, and the offline case is labelled in the tile (`RightSidebar.tsx:154-173`, `:568-570`).

**The repo panel never re-derives the root.** `getWorkspaceRoot(workspaceId, channelId, 'effective')` returns a `MountScopeDto` carrying `path`, `zone`, `source`, `workspaceRoot` and `displayName`; the header reads `displayName` and `source`, the tree reads `nodes` from the same response (`FileExplorer.tsx:183-186`, `:444-456`). `workspace-local` is a *selector*, not a bypass — it re-points the scope at Zone A and is available only when `hasL0Agent(agents)` is true (`FileExplorer.tsx:363-366`; server `routes/filesystem.ts:60-70`).

**Mount writes go through the server.** `OPEN FOLDER` prefers the native OS dialog via the desktop bridge and falls back to the in-app picker when no bridge exists (`FileExplorer.tsx:392-412`). Either way the write is `apiClient.setMount('channel', channelId, path)`, and the panel bumps `filesystemRevision` so every reader re-resolves instead of trusting an optimistic local copy (`FileExplorer.tsx:379-387`). Clearing calls `setMount('channel', channelId, null)` and returns the channel to inheritance (`:495-511`).

**Drawer persistence keys are workspace-scoped.** `heightKey`, `pinKey` and `previewKey` interpolate the workspace id (`BottomDrawer.tsx:23-33`), and the component reloads all three on a workspace switch (`:99-103`). Every read and write is wrapped in `try/catch` — persistence is best-effort and the session still applies (`:35-66`, `:139-149`).

**Operations sheet reuses the desktop panel's components verbatim.** `JobsView`, `OperationsInbox` and `FileExplorer` are imported, not re-implemented (`OperationsSheet.tsx:5-8`, `:190-208`). The sheet adds no endpoint and no second run/approval/repo model (`:26-34`).

**Overlay focus coverage.** Six of the seven modal/dialog surfaces call `useOverlayFocus`. `ThreadDrawer` does **not** — it is a 320 px inline column, not a `role="dialog"`, and it has no focus trap, no initial-focus target and no restore-on-close (`ThreadDrawer.tsx:263`, `:378`). It is the one overlay that can be left behind with focus still inside it after it unmounts.

**Notification centre.** The badge hook reads the persisted history, subscribes to history changes and polls every 60 s (`NotificationCenter.tsx:113-125`). During DND the badge reports 0 so it hides, while the raw count stays available in the centre and history keeps recording (`NotificationCenter.tsx:126-128`, `:193-197`, `:486`). The DND schedule is a device-local quiet-hours range (`NotificationCenter.tsx:199-213`, `:339-378`). Clearing the history requires a `ConfirmDialog` (`NotificationCenter.tsx:487-498`).

**Palette verbs.** `buildVerbs()` returns 16 verbs (`palette-verbs.ts:80-99`). Each carries `id`, `title`, `scope` (`channel` | `workspace` | `run` | `global`), `risk` (`safe` | `confirm` | `destructive`) and an optional `shortcut`. `filterVerbs` scores by subsequence and orders recently used verbs first (`:56-66`); recents live in `crowdos_palette_recent` with a cap of 10 (`:37-53`). Destructive verbs arm on the first press and run on the second (`OmniSearchModal.tsx:43`, `:223-236`).

## Interaction model

| Action | Target | Result | Evidence |
|---|---|---|---|
| Switch right-panel view | Header tab (`role="tab"`) | `rightPanelView` changes; column swaps with an x-slide | `MainChatArea.tsx:945-1000`; `RightSidebar.tsx:277-356` |
| Open an agent dossier | Roster row | `openAgentProfileModal(id)` | `RightSidebar.tsx:185`, `:391` |
| Stop a run | Roster row / Jobs row | `stopRun(runId)`; button only when `isStoppableRunStatus` | `AgentRow.tsx:68`, `:111-120`; `RightSidebar.tsx:213` |
| Expand a directory | Tree row / ArrowRight | Lazy child fetch, then cached | `FileExplorer.tsx:204-238` |
| Open a file | Tree row / Enter | `setSelectedSandboxFile(path, 'effective')` → drawer preview | `FileExplorer.tsx:554` |
| Mount a folder | OPEN FOLDER | Native dialog → `setMount('channel', …)` → revision bump | `FileExplorer.tsx:392-412` |
| Clear a mount | Clear button (only when mounted) | `setMount('channel', id, null)` → inheritance returns | `FileExplorer.tsx:495-511` |
| Approve / deny | Inbox row | `decideApproval(id, 'approved' \| 'denied')` | `OperationsInbox.tsx:54-67` |
| Defer to Later | Inbox row | `deferLater(id)`; local only, badge count excludes it | `OperationsInbox.tsx:148-155`, `:48` |
| Open a run thread | Run card | `ThreadDrawer` in run mode; branch filtered by run id | `ThreadDrawer.tsx:54`, `:61-69` |
| Post the final answer | "Also send final answer to channel" checkbox + button | `addMessage` into the parent channel | `ThreadDrawer.tsx:89-110`, `:348-369` |
| Resize the drawer | Splitter (`role="slider"`) / Arrow keys | Height clamped 120–640, persisted per workspace | `BottomDrawer.tsx:151-190`, `:321` |
| Pin the previewed file | Pin button | Pinned path persisted per workspace | `BottomDrawer.tsx:214-222` |
| Change drawer tab | Tab / Arrow / Home / End | `bottomDrawerView` changes; roving tabindex | `BottomDrawer.tsx:198-212`, `:274-289` |
| Open the ops sheet | Ops trigger bar | Sheet opens; active tab focused; trigger regains focus on close | `OperationsSheet.tsx:63-71`, `:124-137` |
| Run a destructive verb | Palette Commands row | First press arms, second press runs | `OmniSearchModal.tsx:223-236` |
| Ask in place | QuickAsk | `addMessage` (or `queueSend` when offline) | `QuickAsk.tsx:60-78` |
| Expand QuickAsk | Shift+Enter | Draft copied to the main composer, composer focused | `QuickAsk.tsx:55-59`, `:84-88` |
| Open a notification | Notification row | `applyDeepLink({channelId, runId})` | `NotificationCenter.tsx:225-245` |
| Unlock | PIN input | `unlockWithPin(pin)`; failure shows an inline alert | `LockScreen.tsx:22-34` |

## Performance notes

| Aspect | Approach | Evidence |
|---|---|---|
| View swap | `AnimatePresence mode="wait"` with a 150 ms x-slide; one branch mounted at a time | `RightSidebar.tsx:277`, `:284` |
| Reduced motion | Early return with plain `div`s; no `AnimatePresence` mounted | `RightSidebar.tsx:232-274` |
| Ledger cost | 30 s interval, workspace-scoped, cleared on workspace change | `RightSidebar.tsx:105-106` |
| Elapsed tick | 1 s `setInterval` per live agent row, frozen under reduced motion, never a live region | `AgentRow.tsx:56-63` |
| Tree cost | Children fetched once per path and cached; `Refresh` is the explicit re-read | `FileExplorer.tsx:216-222` |
| Drawer artifacts | `fetchArtifacts` fires only when the latest run id changes | `BottomDrawer.tsx:118-132` |
| Browser frames | 1 fps server-side cadence; the panel holds only the latest frame per workspace | `browser-stream.test.ts:97`; `crowdOsStore.ts:1711-1718` |
| Palette search | 200 ms debounce on the server path; verbs are local-only | `OmniSearchModal.tsx:103-118`, `:201-206` |
| Notification badge | 60 s poll plus a push subscription | `NotificationCenter.tsx:113-125` |
| Ops sheet | Reuses the desktop components — no duplicate subscription or fetch | `OperationsSheet.tsx:26-34` |

## Evidence

| ID / pointer | What it shows |
|---|---|
| `packages/client/types/crowdOs.ts:323` | The five-member `rightPanelView` enum |
| `packages/client/components/workspace/RightSidebar.tsx:33-607` | Column root, ledger poll, roster derivation, telemetry tiles, per-branch panels |
| `packages/client/components/workspace/MainChatArea.tsx:942-1000` | Header tab strip bound to the enum |
| `packages/client/components/workspace/FileExplorer.tsx:32-34`, `:121-152`, `:161-246` | Row metrics, ARIA tree markup, lazy tree loader |
| `packages/client/components/workspace/JobsView.tsx:52-135` | Cross-channel job projection and filters |
| `packages/client/components/workspace/OperationsInbox.tsx:15-283` | Approvals / failures / mentions / Later, local-only defer |
| `packages/client/components/workspace/BrowserPanel.tsx:13-175` | Watch lifecycle, click scaling, frame rendering |
| `packages/client/components/workspace/BottomDrawer.tsx:11-386` | Named views, splitter, per-workspace persistence |
| `packages/client/components/workspace/OperationsSheet.tsx:10-216` | Narrow-width sheet and its roving tabindex |
| `packages/client/components/workspace/ThreadDrawer.tsx:38-458` | Run branch and channel-thread modes; the missing focus trap |
| `packages/client/components/workspace/modals/palette-verbs.ts:37-99` | 16-verb registry, recents mirror, risk levels |
| `packages/client/components/ui/use-overlay-focus.ts:52-135` | The shared focus trap and restore |
| `packages/client/components/ui/NotificationCenter.tsx:110-131` | Badge hook, DND gating, history subscription |
| `packages/server/src/browser/browser-stream.test.ts:97` | 1 fps frame cadence |

## Gaps

- **`ThreadDrawer` has no focus trap and no focus restore.** It never calls `useOverlayFocus` and is not a `role="dialog"` (`ThreadDrawer.tsx:263`, `:378`). Keyboard focus can remain inside the drawer after it unmounts, and Tab is not confined while it is open. This is the one overlay in the set that does not honour the trap contract.
- **`ThreadDrawer` is not mounted inside an `ErrorBoundary`.** It is rendered from `MainChatArea`, so a throw inside the branch takes down the chat column rather than one slot. Not verified at runtime — inferred from the absence of an `ErrorBoundary` wrapper in `MainChatArea.tsx`.
- **The right column has no width control.** It is a hard-coded `w-[260px]` in every branch (`RightSidebar.tsx:236`, `:245`, `:255`, `:262`, `:270`). `UX_GUIDELINE.md:67` specifies "Right ops 260–320px"; the 320 end of that range is unreachable.
- **The below-`xl` ops sheet has no browser view.** `operationsSheetView` is `jobs | approvals | repo` (`OperationsSheet.tsx:11`) while the desktop enum also has `browser` (`types/crowdOs.ts:323`). Below `xl` the browser panel is unreachable except through the palette (and no palette verb opens it).
- **The telemetry Channel tab has no ledger.** The 30 s poll is only consumed when `telemetryTab === 'global'` (`RightSidebar.tsx:155`); the Channel tab always uses the local sum and never says whether it is authoritative. `UX_GUIDELINE.md:101` requires ledger-backed totals with an honest offline note — the note only exists on the Global tile.
- **Cost is a synthetic rate when the ledger is offline.** The local fallback multiplies tokens by `0.000003` (`RightSidebar.tsx:127`, `:165`). The tile is labelled "Est. cost" (`:576`) but the rate constant is not surfaced anywhere, so two workspaces on the same token count will always agree and neither number is traceable to a provider price.
- **The Operations inbox badge semantics are only half-implemented.** `UX_GUIDELINE.md:109` requires a distinct approval badge versus a mention badge in the sidebar, rail, tray and status strip. The inbox header shows a single combined count of pending + failures + mentions (`OperationsInbox.tsx:89`); no separate approval badge exists anywhere in the client.
- **The Later section has no server contract and no expiry.** `deferLater` is local-only (`OperationsInbox.tsx:149`, `:278-280`), so a deferred approval does not survive a cache clear and there is no path for another surface to see it.
- **The repo panel has no "Clear only while a mount is set" audit.** The Clear button is conditionally rendered only when `mounted` is true (`FileExplorer.tsx:495`), which matches the contract, but the clear path is not audited server-side — no mount-change event is emitted.
- **The browser panel's 1 fps stream is not rate-limited client-side.** The server paces frames at 1 fps (`browser-stream.test.ts:97`), but the client replaces the whole `dataUrl` on every frame event (`crowdOsStore.ts:1711-1718`); a faster server or a replayed event would re-decode the image on every event.
- **Notification history is device-local only.** `crowdos_notification_history` and the DND schedule live in the renderer's local storage; the tray badge and OS quiet hours are explicitly not bridged (`NotificationCenter.tsx:486`). Nothing reaches another surface.

## User Decision:

## Target Contract

> Status: Target. CrowdOS's locked design contract (`UX_GUIDELINE.md` §4–§11, `AGENTS.md` §5) takes precedence over anything observed here.

* A panel MUST be addressed by a **named view enum**, never a boolean that flips meaning (`UX_GUIDELINE.md:32`). `rightPanelView` is that enum and every writer MUST go through `setRightPanelView`.
* The right ops panel MUST expose four named views with a header tab strip bound to the same enum so palette verbs, notifications, deep links and tests all name the view (`UX_GUIDELINE.md:67`). `browser` is a fifth member and MUST remain addressable from every width.
* Below `xl`, ops MUST never be fully hidden (`UX_GUIDELINE.md:68`): the ops sheet MUST expose the same projections the desktop panel exposes.
* Every panel MUST render skeleton / empty-with-next-action / error-with-cause-and-retry, and MUST never show mock data (`UX_GUIDELINE.md:34`, `:141`).
* A telemetry figure MUST be traceable to a source or the surface MUST say so. Ledger-backed totals MUST carry an honest offline note when the ledger is unavailable (`UX_GUIDELINE.md:101`, `:142`). The channel-scoped telemetry MUST be labelled the same way the global one is.
* The repo panel MUST resolve **one effective root per channel from a single request** (`UX_GUIDELINE.md:99`) and MUST show the source badge (Channel/Category/Workspace/sandbox/not-mounted) with a why-it-won tooltip.
* Mount overrides REPLACE, they never merge (`UX_GUIDELINE.md:23`). Clear MUST be available only while a mount is set and MUST return the channel to inheritance (`UX_GUIDELINE.md:99`).
* Every right-panel row MUST carry an accessible name, `aria-posinset`/`aria-setsize` within its group, `selected` state and keyboard handlers. Roster rows MUST show the tier chip; authority MUST come from the tier alone and never from a name or a badge (`AGENTS.md` §5.3).
* A **focus trap and focus restore** are mandatory for every overlay that takes focus (`../Discord Findings/Keyboard and Accessibility.md`, Target Contract). `ThreadDrawer` MUST adopt `useOverlayFocus` or be explicitly reclassified as a non-modal region with its own documented focus contract.
* The approval badge MUST be distinct from the mention badge in the sidebar, rail, tray and status strip (`UX_GUIDELINE.md:109`).
* The notification centre MUST deep-link each row to its channel and run (`NotificationCenter.tsx:225-245`), and the DND schedule MUST gate the badge without suppressing history (`NotificationCenter.tsx:126-128`).
* Destructive palette verbs MUST require a second, explicit confirmation (`OmniSearchModal.tsx:223-236`); a risk badge alone is not a confirmation.
* The drawer MUST stay the multi-file home with file/diff/log tabs, a resizable splitter and per-workspace memory (`UX_GUIDELINE.md:124`).

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| 260 px right column with a 5-view tab strip (`RightSidebar.tsx:33`) | Optional member-list column, no tab strip | `../Discord Findings/Right Panel and Members.md` | Discord's right side is one optional column plus header popovers; CrowdOS's is a permanent column whose content swaps by enum. Discord's contract explicitly says "If CrowdOS ever adds tabs, the tab set MUST be server-authoritative and declared" — CrowdOS's enum is declared in `types/crowdOs.ts:323`, not server-authoritative. |
| Roster grouping L0–L3 (`RightSidebar.tsx:179-182`) | Member-list grouping by hoisted role id, then a synthetic `offline` group | `../Discord Findings/Right Panel and Members.md` | Discord groups role-first, status-second; CrowdOS groups by tier only and has no offline group. Discord's contract forbids role-based grouping in CrowdOS — CrowdOS's tier grouping satisfies it. |
| Agent row presence + elapsed + cost + Stop (`AgentRow.tsx:82-122`) | Member row presence mask + activity sub-text | `../Discord Findings/Right Panel and Members.md` | Discord's presence is a static status mask plus free-text activities ("Playing Spotify", "In a Voice Channel"); CrowdOS's is a live elapsed counter plus a cost figure plus a Stop affordance — a *durational* presence, per `UX_GUIDELINE.md:98`. Discord has no per-row cost concept at all. |
| Stop-on-row / Retry-in-jobs (`AgentRow.tsx:68`, `JobsView.tsx:258-274`) | Member context-menu moderation actions, gated by role position | `../Discord Findings/Roles and Authority.md` | Discord expresses authority refusal as an *explanatory reason on a disabled control* ("This person has a higher role than you…"); CrowdOS expresses it by *omitting* the button unless the run is stoppable. Discord's contract requires CrowdOS to surface the reason instead of hiding the action. |
| Telemetry Channel/Global tabs + 30 s ledger poll (`RightSidebar.tsx:66-107`) | No equivalent — Discord has no cost or usage panel | `../Discord Findings/Performance Model.md` | CrowdOS adds a metered-operations surface Discord does not have. The honest-offline pattern (tri-state ledger, local-sum fallback, labelled tile) is CrowdOS-specific and has no Discord counterpart to compare against. |
| Repo ARIA tree, 22/12/16 px metrics (`FileExplorer.tsx:32-34`, `:121-152`) | Guild/channel lists as flat `list` with `listitem` rows | `../Discord Findings/Shell and Navigation.md` | Discord's sidebar is a flat list of interleaved channel/category rows, not a tree; its *guild rail* is a real ARIA `tree`. CrowdOS's repo tree is a proper `tree` with `aria-level`/`aria-posinset`/`aria-setsize` and roving focus — closer to Discord's rail semantics than to Discord's sidebar semantics. |
| Operations inbox with Later (`OperationsInbox.tsx:15`) | Inbox popover in the chrome bar + `mod+i` toggle | `../Discord Findings/Shell and Navigation.md` | Discord's inbox is a title-bar/rail popover with an experiment-selected placement (`"server-rail-top"`, `"title-bar-left"`); CrowdOS's is a section inside the jobs panel plus a separate notification centre. Discord's contract asks for a distinct approval badge, which CrowdOS has not implemented. |
| Bottom drawer with file/diff/log tabs + `role="slider"` splitter (`BottomDrawer.tsx:82-385`) | No equivalent — Discord has no bottom artifact drawer | `../Discord Findings/Composer.md` | Discord's composer accessory bar is the only lower-edge surface, and it carries uploads/emoji/apps. CrowdOS's bottom drawer is a workspace-artifact home with per-workspace persistence. `UX_GUIDELINE.md:124` calls for exactly this; Discord offers no precedent to copy. |
| Operations sheet below `xl` (`OperationsSheet.tsx:36`) | Narrow-width member list uses **swipe gestures** with telemetry, not a breakpoint | `../Discord Findings/Right Panel and Members.md` | Discord's narrow behaviour is `member_list_swipe_peek` / `member_list_swipe_toggled`; CrowdOS's is a CSS breakpoint plus a bottom sheet. Discord's contract requires the narrow behaviour to be an explicit, tested contract — CrowdOS's is explicit but the telemetry it would need does not exist. |
| Run-thread drawer, 320 px (`ThreadDrawer.tsx:260-375`) | Thread **sidebar panel** next to the chat, parent channel stays live | `../Discord Findings/Threads.md` | Discord's thread is a real channel with its own id, URL, scroll state and composer; it renders as a side panel beside the parent. CrowdOS's ThreadDrawer in run mode is a *filtered projection of the parent's messages* by run id, with no separate store, no separate composer and no separate read state. Discord's contract ("a thread is its own conversation, not a message sub-tree") is **not** satisfied by the run-mode branch. |
| ThreadDrawer channel mode (`ThreadDrawer.tsx:377-457`) | Thread list inside the channel sidebar, active vs archived split | `../Discord Findings/Threads.md` | CrowdOS's channel-thread mode does use real thread rows and a thread message API, but the thread list is not in the sidebar — it opens in a drawer. Discord's counts are approximate and locally derived; CrowdOS's `messageCount` is a server-maintained field on the thread row (`ThreadDrawer.tsx:19`). |
| Palette with 16 verbs + arming (`palette-verbs.ts:80-99`, `OmniSearchModal.tsx:223-236`) | `mod+k` quick switcher + a "Search, members, media, pins, threads, and more" command palette | `../Discord Findings/Shell and Navigation.md` | Discord's palette is a single search surface; CrowdOS's is a two-tab surface (Search / Commands) with a local verb registry, a recent-verbs mirror and two-stage arming for destructive verbs. Discord has no arming concept; CrowdOS's is a deliberate safety addition. |
| Notification centre + DND (`NotificationCenter.tsx:131`) | Inbox popover; `mod+e` marks the top inbox channel read | `../Discord Findings/Keyboard and Accessibility.md` | Discord has no do-not-disturb schedule in the analysed surface; CrowdOS adds a device-local quiet-hours range that gates the badge but not history. Discord's read-marking is an explicit keybinding with a debounce; CrowdOS's is a "Mark all read" button. |
| Overlay focus trap (`use-overlay-focus.ts:52-135`) | `role:"dialog"` ×8 in the bundle; trap implementation not traced | `../Discord Findings/Keyboard and Accessibility.md` | Discord's dialog trap was **not** observed live. CrowdOS's shared hook implements trap + restore explicitly, and six overlays use it — but `ThreadDrawer` does not, so the one surface Discord documents as a right-hand column is CrowdOS's least-guarded overlay. |
| `useOverlayFocus` initial-focus + restore model | Discord uses **virtual focus** (`useVirtualFocus:!0` + `aria-activedescendant`) for lists | `../Discord Findings/Keyboard and Accessibility.md` | CrowdOS's trap moves real DOM focus; Discord's list navigation keeps DOM focus on the container and publishes the active row via `aria-activedescendant`. CrowdOS's tree and palette use roving tabindex plus `aria-activedescendant` in places, so the two models coexist. |
| Roster cost + Stop + elapsed in one row | Member row sub-text (activities, voice status) | `../Discord Findings/Right Panel and Members.md` | Discord's member row presents *ambient* facts; CrowdOS's presents *decision-relevant* spend facts (cost) and a destructive action (Stop) inline, per `UX_GUIDELINE.md:35`. Discord's contract requires the tier to be rendered alongside any authority-looking element — CrowdOS's `L{level}` chip does that. |
| Browser panel (1 fps frame stream) | No equivalent — Discord has no in-app browser takeover panel | `../Discord Findings/Interaction Vocabulary.md` | CrowdOS's browser panel is a per-workspace operator takeover with click-coordinate scaling and a deliberate credential boundary. Discord's interaction vocabulary has no counterpart; the closest surface is Discord's own external-link guard. |

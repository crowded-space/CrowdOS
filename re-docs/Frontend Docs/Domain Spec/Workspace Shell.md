# Workspace Shell

## Purpose

App chrome around the chat: left channel navigation, workspace menu, right roster/sandbox panel, composer mode control, presence/status primitives. Composition root is `src/App.tsx`.

## Feature Scope

In-scope: 3-panel desktop layout, channel list + category collapse, channel filter input, personal favorites/recent-activity overlay on top of the sidebar (never mutates the shared tree), workspace dropdown menu (settings / copy ID / leave), channel unread/mention/approval-waiting/live-run badges plus draft preview, mode selector + pin, operations roster grouped by tier with telemetry footer, file-explorer/sandbox-hosting slot when roster closed, bottom artifact drawer (`BottomDrawer`) in the center column below the chat, narrow-width ops bottom sheet (`OperationsSheet`: Jobs / Approvals / Repo below `xl`), avatar presence dots, status pills, emoji quick grid.
Non-goals: message rendering and composer behavior (see Chat Area), file tree / mounts / diffs internals (see Filesystem Explorer), settings/search/profile/channel-creation dialog internals (see Modals), workspace onboarding and DB provisioning (see Portal), thread drawer / repository selector / safety panels (undocumented areas).

## Expect

- `[Observed]` Left sidebar shows a filter input, then a personal navigation overlay (Favorites + Recent activity), then top-level channels, then one block per category with collapse toggle and per-category create button.
- `[Observed]` Selecting a channel marks it active.
- `[Observed]` Active channel shows an indigo rail + highlighted row; unread counts cap at `99+`; mentioned channels show a rose dot with a single bounded pulse on arrival (`pulse-once` 1.2s, then static; `motion-reduce:animate-none`), never a loop.
- `[Observed]` Favorites are a local-only overlay (`crowdos_sidebar_favorites`): star toggles resolve against the live tree and never mutate the shared workspace tree. Recent activity is honest live signals only (unread, mention, draft, open channel, top 5) with an explanatory caption, never fake visit history.
- `[Observed]` Channel rows carry an amber shield approval-waiting badge (icon + text, `N approvals` / `approval`) distinct from the rose mention dot, fed by pending non-deferred `approvalRequests` with a channelId; plus an indigo live-run affordance (icon + `live` + runtime) fed by the shared `jobsByRun`/`runRuntimeByRun` projection (terminal rows excluded, absent when no live row).
- `[Observed]` `OfflineBanner` shows one restrained recovery action: Retry connection for browser/socket loss, Database settings for database-degraded local mode.
- `[Observed]` Workspace header opens an animated dropdown: Workspace Settings, Create Category (opens settings channels tab), Copy Workspace ID, Leave Portal (confirm-guarded).
 `[Observed]` Right panel is addressed by the `rightPanelView: roster | repo | jobs | telemetry` enum (`crowdOsStore.ts`, `types/crowdOs.ts`). `roster` renders the agent roster (tiers L0–L3 + telemetry); `repo` renders the Repo panel (`FileExplorer`); `jobs` renders the jobs branch (`OperationsInbox` above `JobsView`); `telemetry` renders graduated telemetry. The header 4-tab segmented control binds to the same enum with `aria-selected`/`aria-controls` so palette verbs, notifications, deep-links, and tests can name the view. The panel header reads “Repository” and its Suspense fallback now reads “Loading repository…”, matching what it actually shows.
- `[Observed]` Roster telemetry has Channel/Global tabs; global tokens prefer the ledger endpoint when it answers, else honest local sums.
- `[Observed]` Roster telemetry has Channel/Global tabs wired as tab/tabpanel (`telemetry-tab-channel`, `telemetry-tab-global`, `telemetry-panel`); switching recomputes tokens, cost, active counts, and channel counts from the selected scope (`RightSidebar.tsx:79-135,298-328`). Global tokens prefer the ledger endpoint when it answers, else honest local sums with a "Ledger offline — showing local totals" note (`RightSidebar.tsx:331-338`).
- `[Observed]` Roster headings are landmark-safe: `Operations roster` is an h2 (`roster-heading`), tier groups are h3, and the telemetry footer is a labelled `section` (`telemetry-heading`); decorative tier dots and telemetry icons are `aria-hidden` (`RightSidebar.tsx:219,234-276,289-364`).
- `[Observed]` The ledger poll is workspace-scoped and re-runs when the active workspace changes; a 401 carrying the screenlock message locks the shell, any other failure marks the panel offline so the honest local sums render instead of a permanent skeleton (`RightSidebar.tsx:28-75`).
- `[Observed]` Mode selector offers Auto/Chat/Agentic/Coding/Research with keyboard cycling and a cross-channel pin toggle.
  - `[Observed]` Mode selector offers Auto/Chat/Agentic/Coding/Research with keyboard cycling and a cross-channel pin toggle.
  - `[Observed]` Phase D strip placement: `StatusStrip` mounts directly above `ComposerPreflight` inside the composer box (`MainChatArea.tsx`), adjacent the composer; toasts are capped at 3 stacked (oldest drops) with quiet `role=status` auto-dismiss vs persisted assertive `role=alert` errors (`ToastProvider.tsx`).
- `[Observed]` Mode selector offers Auto/Chat/Agentic/Coding/Research/Swarm with keyboard cycling and a cross-channel pin toggle; the trigger is named "Execution mode" for assistive tech (`ModeSelector.tsx:90-99`).
 - `[Observed]` Mode selector offers Auto/Chat/Agentic/Coding/Research/Swarm with keyboard cycling and a cross-channel pin toggle; the trigger is named "Execution mode" for assistive tech (`ModeSelector.tsx:90-99`). Each option renders latency/cost/scope hint lines from `COMPOSER_MODE_META` (qualitative copy only, no measured budgets) plus an honest Auto resolved-to slot (`autoResolvedTo`, hidden while null). Cycling, `aria-pressed` pin, and listbox roles are unchanged.
- `[Observed]` Below `xl`, the left sidebar mounts as an off-canvas drawer with backdrop/Escape/channel-selection dismissal and the chat uses the full viewport; the full-screen backdrop dismisses the drawer and returns the nav to `-translate-x-full invisible`; the right roster is desktop-only at `xl+`.
- `[Observed]` Bottom drawer (`BottomDrawer`, `bottomDrawerView: file | diff | log`) is slotted in the center column below the chat as `div[data-slot="bottom-drawer"]` with its own `ErrorBoundary` (`src/App.tsx`); it never reorders the nav/chat/roster row and the dock stays default. Tabs use `tablist`/`tab`/`tabpanel` with roving tabindex, Arrow/Home/End keys, and auto-activate; the splitter is a `role="slider"` with Arrow/Home/End keys; height (120–640px) and the preview-vs-pinned file choice persist per workspace in localStorage (`crowdos_drawer_height_<ws>`, `crowdos_drawer_pinned_file_<ws>`, `crowdos_drawer_preview_file_<ws>`); the log tab is read-only channel state. Ports equal exports: the named `bottomDrawerView` enum is the view address, never a boolean.
- `[Observed]` Ops bottom sheet (`OperationsSheet`, `operationsSheetView: jobs | approvals | repo`) is slotted in the center column below the bottom drawer as `div[data-slot="ops-sheet"]` with its own `ErrorBoundary` (`src/App.tsx`); the `Ops` trigger bar always renders where mounted so ops are never fully hidden, and the dialog is `xl:hidden` so the desktop roster stays the single ops surface at `xl+`. Tabs use `tablist`/`tab`/`tabpanel` with roving tabindex, Arrow/Home/End keys, and auto-activate; Jobs reuses `JobsView`, Approvals reuses `OperationsInbox`, Repo lazy-loads `FileExplorer` (same store projections, no second models); dismissal is backdrop, Escape, or channel selection; counts are icon+text with a polite live region; the sheet is static (no motion). Ports equal exports: the named `operationsSheetView` enum is the sheet tab address, never a boolean.
- `[Observed]` Operator profile block is a local-only sourced profile (`workspace/operator-profile-model.ts` over `crowdos_operator` via `safeGet`/`safeSet`, default `Local operator` with honest empty email shown as `Single-user shell`); inline Edit persists name/email locally with labelled inputs and focus-visible rings. No session endpoint exists, so identity is never claimed as server-resolved.
- `[Inferred]` Telemetry cost math (`tokens * 0.000003`) is a display estimate, not billed cost.

## Flow

1. Boot: `App.tsx:124-135` gates on `activeWorkspaceId`; none renders `WorkspacePortal`, otherwise the 3-panel shell.
2. Navigate channels: `WorkspaceSidebar.tsx:40-43` `handleSelectChannel` calls `setActiveChannel`, then closes the responsive drawer; rows render via `ChannelButton.tsx:11-41`.
3. Collapse category: `WorkspaceSidebar.tsx:94-104` toggles `toggleCategoryCollapse`; chevron + `aria-expanded` update.
4. Create channel (inline): `WorkspaceSidebar.tsx:106-116` stores `selectedCatId`, opens `InlineChannelModal` (`WorkspaceSidebar.tsx:148-155`).
5. Workspace menu: `WorkspaceDropdown.tsx:47-64` trigger → menu items `WorkspaceDropdown.tsx:78-137`; opening moves focus to the first menu item and closing by Escape/outside click restores the trigger focus; Leave arms `ConfirmDialog` → `leaveWorkspace()` (`WorkspaceDropdown.tsx:142-154`).
6. Status recovery: `OfflineBanner.tsx` → disconnected state calls `socket.connect()`; database-degraded mode opens settings overview through `App.tsx`.
7. Responsive navigation: below `xl`, the chat header menu opens the sidebar drawer; pointer-down or click on the full-screen backdrop labeled `Close workspace menu`, Escape, or channel selection closes it (`App.tsx`). The backdrop does not extend beneath the drawer, so its center target remains clickable and clear of the drawer hit area. While a modal dialog or workspace menu is open, Escape is owned by that overlay instead of also collapsing the drawer.
8. Right panel switch: header segmented control in chat (`MainChatArea.tsx`) sets `rightPanelView` (`roster | repo | jobs | telemetry`); `RightSidebar.tsx` cross-fades all four branches with matching `tabpanel` roles (`right-panel-roster/repo/jobs/telemetry`) and is visible at `xl+`. The jobs branch renders `OperationsInbox` above `JobsView` in both reduced-motion and animated paths; empty jobs/inbox states use honest copy (no fake rows).
9. Agent inspect: `AgentRow.tsx` click → `openAgentProfileModal(id)` (`RightSidebar.tsx`).
10. Mode change: `ModeSelector.tsx` `onChange` + close; pin toggles cross-channel persistence.

## Current Implementation

| Component | Role |
|---|---|
| `src/App.tsx` | Shell composition: portal gate, responsive drawer/backdrop, desktop panels, lazy modals, error boundaries, Cmd+K + hash routing |
| `workspace/BottomDrawer.tsx` (`BottomDrawer`, default export; `bottomDrawerView`) | Bottom artifact drawer: named file/diff/log tabs, resizable persisted splitter, per-workspace height + preview/pinned memory, latest-run diff tab, read-only channel log |
| `ui/OfflineBanner.tsx` | Degraded-state strip with retry-or-settings recovery action |
| `workspace/WorkspaceSidebar.tsx` | Channel nav: dropdown, offline banner, filter input, personal Favorites/Recent-activity overlay (local-only, tree read-only), top-level + categorized channels, inline-create modal host, operator footer |
| `workspace/WorkspaceDropdown.tsx` | Workspace menu: settings entry points, copy ID + toast, leave-with-confirm |
| `workspace/ChannelButton.tsx` | Memoized channel row: active rail, mention dot, unread badge, draft preview, amber shield approval-waiting badge (icon + text, distinct from mention), indigo live-run affordance (icon + text) |
| `workspace/ModeSelector.tsx` | Composer mode listbox + cross-channel pin toggle |
| `workspace/RightSidebar.tsx` | Roster-or-sandbox switch, tier groups L0–L3, channel/global telemetry footer, ledger poll |
| `workspace/JobsView.tsx` (`JobsView`, default export) | Cross-channel run table (channel/agents/runtime/step/elapsed/tokens/cost/status) with Stop/Retry/Jump/Open-diff/Open-logs, local status/channel/agent filters, honest empty; step/tokens/cost render a dash until a real source exists; resumable rows persist via the store jobs mirror; Stop is enabled only for live stoppable run states (created/queued/starting/running/waiting_for_tool/waiting_for_approval/retrying/compacting/completing/verifying), parked resumable/orphaned rows disable Stop and use Retry (POST /api/runs/:id/resume), and cancelling is already stopping |
| `workspace/OperationsInbox.tsx` (`OperationsInbox`, default export) | Pending approvals (Approve/Jump/Later) + failures (Retry/Jump) + mentions (Jump) + Later-deferred restore; amber approval vs rose mention badges with icon+text, never color-only; honest empty |
| `workspace/StatusStrip.tsx` (`StatusStrip`, default export; presentational, props-only) | Thin run-status line adjacent the composer (runtime/pin + mount + context + cost + elapsed + degraded dots); every navigable segment is a real button to its source view; unknown segments hide; elapsed ticks locally at 1/s only with a start time |
| `workspace/AgentRow.tsx` | Memoized agent row: avatar + presence dot, level chip, OMNI tag |
| `workspace/ui/StatusBadge.tsx` | Pill for 9 `AgentStatus` values, pulsing variants for thinking/working |
| `workspace/ui/PresenceIndicator.tsx` | Presence dot (sm/md/lg) with optional label |
| `workspace/EmojiPickerPopover.tsx` | 24-emoji quick grid popover, `onSelect` + `onClose` |

## Props & Store

- `ChannelButton { channel: Channel; isActive: boolean; onSelect(id); draftPreview?; approvalCount?; isLive?; liveRuntime? }` — badges: rose mention dot (unchanged) + `unreadCount` cap 99+ (unchanged) + amber shield approval-waiting badge (icon + text, pending non-deferred `approvalRequests` with channelId) + indigo live-run affordance (icon + `live` + runtime from shared `jobsByRun`/`runRuntimeByRun`, terminal rows excluded) + italic draft preview line.
- `ModeSelector { value: ComposerMode; onChange; isPinned; onTogglePin; disabled? }` — stateless; mode/pin state lives in store (`selectedMode`, `isPinned`, `setMode`, `togglePin`).
- `AgentRow { id, name, species, status, level, avatar?, isOmniscient?, onOpen(id) }` — stateless; avatar box contains the presence badge without overflow.
- `AgentRow { id, name, species, status, level, avatar?, isOmniscient?, onOpen(id) }` — stateless; missing avatars render a `Bot` icon (no decorative emoji), and the avatar box contains the presence badge without overflow (`AgentRow.tsx:28-31`).
- `OfflineBanner { dbDegraded; onOpenDatabaseSettings() }` — chooses retry versus settings recovery from connectivity state.
- `EmojiPickerPopover { open; onSelect; onClose }` — quick grid only: 24 fixed emoji with per-emoji `Insert emoji …` labels and an icon close button (`EmojiPickerPopover.tsx:5-50`).
- `StatusBadge { status: AgentStatus }`, `PresenceIndicator { status; size?; showLabel? }`, `EmojiPickerPopover { open; onSelect; onClose }` — all stateless.
- Store slices read: `workspaces, activeWorkspaceId, activeChannelId, setActiveChannel, toggleCategoryCollapse, setSettingsModalOpen, setWorkspaceSettingsTab, isDatabaseOffline, databaseErrorMessage, fetchWorkspaces, leaveWorkspace` (sidebar/dropdown); `agents, messages, openAgentProfileModal, rightPanelView, totalTokensConsumed` (roster); `selectedMode` family consumed in Chat Area composer, not here.
  - Store slices read: `workspaces, activeWorkspaceId, activeChannelId, setActiveChannel, toggleCategoryCollapse, setSettingsModalOpen, setWorkspaceSettingsTab, isDatabaseOffline, databaseErrorMessage, fetchWorkspaces, leaveWorkspace` (sidebar/dropdown); `agents, messages, openAgentProfileModal, rightPanelView, totalTokensConsumed` (roster); `selectedMode` family + `StatusStrip` props consumed in Chat Area composer, not here. Ports equal exports: `JobsView`, `OperationsInbox`, and `StatusStrip` each export a named component plus a default; the four-view `rightPanelView` enum is the panel address, never a boolean.

## Relations

- Parents: `App.tsx` mounts `WorkspaceSidebar` as an off-canvas drawer below `xl` and a fixed panel at `xl+`; `RightSidebar` is desktop-only at `xl+`; the center column hosts `MainChatArea` plus the `BottomDrawer` named slot below it.
- Children: center column → `MainChatArea` (Chat Area) + `BottomDrawer` (file/diff/log tabs; file tab hands paths back via `setSelectedSandboxFile`; diff tab reuses `DiffViewer`; log tab reads the message list read-only).
- Children: sidebar → `WorkspaceDropdown`, `ChannelButton`, `InlineChannelModal` (see Modals), `ConfirmDialog` (see Modals) via dropdown; roster → `AgentRow` → `PresenceIndicator`; panel → lazy `FileExplorer` (the Repo panel — see Filesystem Explorer), which hosts the mount entry point itself; composer → `ModeSelector`, `EmojiPickerPopover` (see Chat Area).
- Store: `crowdOsStore` for nav/selection/roster/telemetry; `ToastProvider` for copy-ID feedback.
- API: roster polls `GET /api/observability/cost/dashboard` directly, workspace-scoped via `x-workspace-id` and resolved through `resolveApiUrl` so the packaged renderer hits the embedded backend (`RightSidebar.tsx:28-75`); sidebar retry delegates to store `fetchWorkspaces`.

## Emits-Listens

- Shell components emit no socket events directly; channel join is debounced via `emitChannelJoin` in `src/config/socket.ts:45-80`, driven by store `setActiveChannel`.
- Store socket subscriptions backing shell state: `agent:status`, `agent:thinking`, `agent:spawned`, `agent:paused/resumed`, `workspace:sync`, `budget:exceeded/warning` (`stores/crowdOsStore.ts:1016-1095,1183-1200`).
- Store actions touched: `setActiveChannel`, `toggleCategoryCollapse`, `setRightPanelView`, `leaveWorkspace`, `fetchWorkspaces`, `openAgentProfileModal`.

## Owns

- Local state only: dropdown open, create-modal open + selected category, category/mode/emoji UI state, telemetry tab, ledger snapshot, sidebar channel filter, local-only favorite ids (`crowdos_sidebar_favorites`), operator-profile modal open flag (profile `{name; tag; preference|null}` persisted as `crowdos_operator` via `workspace/operator-profile-model.ts`, edited in `workspace/modals/OperatorProfileModal.tsx`).
- Caches: ledger totals (30s poll); `lastJoinAt` debounce map in `src/config/socket.ts:45-57`. Favorites persist via `safeSet`/`safeGet` and never mutate the shared workspace tree; recents are derived live (unread/mention/draft/active) with no separate persistence.

## Flags

- No env vars; `BACKEND_URL = ''` constants are Chat/Filesystem/Portal scope, not shell.
- Responsive: left panel is a drawer below `xl` and `xl:static` at desktop; right panel is `hidden xl:flex`; the chat header owns an `xl:hidden` menu trigger; `sm:` density tweaks remain in rows.
- Motion: `useReducedMotion` disables roster cross-fade spring (`RightSidebar.tsx:22,161-165`). Single-pulse rule (Phase G): roster rows tick elapsed time without pulsing (frozen under reduced motion), the channel mention dot pulses once on arrival, and only pending approval cards loop (`animate-pulse-slow`, static once decided); all collapse to static under `prefers-reduced-motion` (`index.css`).
- `[Observed]` Roster labels are sentence-case (`L0 · Surveillance`), tier/count/level chips are square `rounded` + `tnum`; category headers are 13px medium sentence-case; telemetry tabs are square with 200ms transitions.
- `[Observed]` `ThemeToggle` (auto/light/dark cycle, Sun/Moon/Monitor) mounted in sidebar footer and portal card; no user-visible em-dashes in shell strings.
- `[Observed]` The estimated-cost value uses `text-emerald-300` (`#047857` in the light theme), meeting WCAG AA for 13px normal text on its rendered surface without changing the telemetry card hierarchy or dimensions.

## Decisions

- `[Observed]` Roster-closed state hosts the sandbox explorer instead of empty space — one panel, two modes.
- `[Observed]` Danger action focuses Cancel by default via shared `ConfirmDialog`.
- `[Observed]` Telemetry falls back to honest local sums with a skeleton while ledger loads — no fake baseline.
- `[Observed]` The poll is workspace-scoped because an untargeted read makes the PIN gate ask "is a screenlock configured in ANY workspace", which 401s an unlocked workspace whenever a sibling is locked. Targeting it makes only this workspace's lock decide (`RightSidebar.tsx:35-44`).
- `[Inferred]` Hardcoded operator identity is a stub awaiting real session/user domain.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Three-panel shell plus roster-or-sandbox switch plus honest telemetry fallback stay; identity, naming honesty, and uncovered-surface mapping are the gaps.
Roster-closed hosting the sandbox explorer stays as one panel with two modes.
Danger actions stay default-focus Cancel via shared ConfirmDialog.
Telemetry stays honest local sums with skeleton while ledger loads. Fake baselines are forbidden.
Operator identity MUST be server-resolved session identity. Hardcoded Juan Hamzah name, email, avatar, and presence are forbidden in production paths.
Create Category MUST either create inline or be renamed to Manage Channels. Naming-versus-behavior mismatch is forbidden.
Telemetry MUST declare the math: ledger billed cost versus local token estimate with the 0.000003 factor labeled estimate-only. Silent estimate-as-bill is forbidden.
Emoji grid scope MUST be explicit: quick grid only or full picker with search, skin tones, and recents. Silent missing picker behavior is forbidden.
ThreadDrawer plus ScreenLockSettingsPanel plus settings editors MUST be documented in an assigned area or explicitly out of scope with a pointer. Silent uncovered components are forbidden.
Ledger totals poll stays 30s with workspace match before roster touch. Untagged snapshot roster clobber is forbidden.
## Failure + Resume

- No workspace: sidebar returns skeleton rows (`WorkspaceSidebar.tsx:72-77`); dropdown returns null (`WorkspaceDropdown.tsx:43`); empty categories show "No channels" (`WorkspaceSidebar.tsx:122-129`) and full-empty shows onboarding copy (`WorkspaceSidebar.tsx:134-142`); empty roster points to Settings → Agents Board (`RightSidebar.tsx:244-252`).
- DB offline: amber banner with retry + settings shortcut; no crash.
- Panel failures isolated by `ErrorBoundary` per panel in `src/App.tsx`.
- Socket disconnect surfaces via store `reconnectDigest`; rejoin re-emits `channel:join` from persisted `crowdos_active_channel` (`src/config/socket.ts:98-105`).

## Gaps

- Operator profile is local-only (`crowdos_operator` via `workspace/operator-profile-model.ts`, default `Local operator`, honest empty email as `Single-user shell` with inline Edit + persist); avatar initials derive from the stored name and presence dot is decorative only. No live session/me endpoint exists in scope, so profile is never claimed as server-resolved; no logout action beyond opening settings.
- "Create Category" menu item opens the settings channels tab rather than creating inline — naming vs behavior mismatch.
- Telemetry per-provider budget vs displayed global/channel sums relationship unverified.
- Telemetry distinguishes "loading", "ledger ready", and "poll failed" but NOT "no spend recorded" from "database unreachable" — both render as zeros once the server degrades.
- Telemetry distinguishes "loading" (skeleton), "ledger ready", and "poll failed" (local totals plus an explicit offline note); "no spend recorded" versus "database unreachable" still both render as zeros once the server degrades.
- Emoji grid is quick-grid-only by contract (no search, skin tones, or recent-use); the composer appends the chosen glyph, so caret placement is append-only.
- `ThreadDrawer.tsx`, `ScreenLockSettingsPanel.tsx`, settings/* editors not covered by any of the 5 assigned docs (`SafetySettingsPanel.tsx` deleted 2026-10-05 - unwired, safety tab inline in settings modal). (`RepositorySelector.tsx` was on this list and is now deleted — it was imported by nothing, and the mount entry point it was meant to host now lives in the Repo panel header as `OPEN FOLDER`.)

- [Observed] Header and operator bar are solid surfaces (no backdrop blur); dialog backdrops keep the single blur accent.

# Shell and Layout

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding of the desktop client shell: the composition root, the named layout slots, the navigation model, and the boot surfaces. The canonical CrowdOS docs remain `re-docs/Frontend Docs/`; this document records what the code actually does today.

## Purpose

Describe the CrowdOS client shell as implemented: which component owns which layout slot, how the workspace shell is gated behind the portal, how navigation state is encoded and applied, and which global behaviours (shortcuts, screen lock, deep links, error isolation, toasts) live at the shell level rather than in a surface.

Scope: `packages/client/src/App.tsx`, `packages/client/src/main.tsx`, the components mounted by them, and the client-side config modules they call. Visual style is out of scope.

## How it works

The shell has **two mutually exclusive roots**, selected by one boolean — `activeWorkspaceId`:

- **Portal gate.** When `activeWorkspaceId` is `null`, `App.tsx:165-175` returns a centred `WorkspacePortal` inside `ToastProvider`, wrapped in an `ErrorBoundary`. No workspace chrome exists in this state.
- **Workspace shell.** When a workspace is active, `App.tsx:177-262` renders a flex column: skip link → grain overlay → `OfflineBanner` → the **3-panel row** (`App.tsx:190`) → the lazy overlay stack → `LockScreen`.

The 3-panel row is `flex-1 flex overflow-hidden` and contains, in DOM order:

1. A backdrop button (only when the off-canvas nav is open) — `App.tsx:192-200`.
2. `<nav aria-label="Workspace channels">` — `App.tsx:203-212`.
3. `<main>` — the center column: `MainChatArea`, then the bottom-drawer slot, then the ops-sheet slot — `App.tsx:215-240`.
4. `<aside aria-label="Operations panel: roster, repository, jobs, and telemetry">` — `App.tsx:243-247`.

Two **named slots** exist as `data-slot` attributes so a surface can be addressed without a DOM query:

| Slot / region | Element | Width | Breakpoint | Holds |
|---|---|---|---|---|
| Left nav | `<nav aria-label="Workspace channels">` (`App.tsx:203-212`) | `min(86vw,300px)` off-canvas; `clamp(240px,20vw,280px)` at `xl` | `absolute` + translated below `xl`; `xl:static` at `xl+` | `WorkspaceSidebar` inside an `ErrorBoundary` |
| Center chat | `<main>` (`App.tsx:215`) | `flex-1 min-w-0` (fluid) | always | `MainChatArea`, then the two named slots below it |
| `data-slot="bottom-drawer"` | `<div data-slot="bottom-drawer">` (`App.tsx:225-229`) | `shrink-0`; inner height 120–640 px | always | `BottomDrawer` (file / diff / log) |
| `data-slot="ops-sheet"` | `<div data-slot="ops-sheet">` (`App.tsx:235-239`) | full width of the center column | `xl:hidden` | `OperationsSheet` (jobs / approvals / repo) |
| Right ops | `<aside>` (`App.tsx:243-247`) | fixed `260px` inside the panel | `hidden xl:flex` | `RightSidebar` (5 views) |

Because the drawer and the ops sheet live **inside** `<main>`, the shell row keeps the nav / chat / ops reading order, and the ops sheet sits under the drawer rather than beside it.

**Navigation model.** Two mechanisms, one resolution path:

- *Hash router* (web): `App.tsx:103-135` listens to both `popstate` and `hashchange`. The hash body is split on `/`; the first segment is a workspace id, the last is a channel id. A workspace switch calls `enterWorkspace` only when the id exists in `workspaces`; a channel switch calls `setActiveChannel` only when the channel is in the visible set (top-level channels + all category channels) — `App.tsx:112-127`. Anything else is ignored. The store writes the hash back in exactly one shape: `pushChannelHistory` emits `#<workspaceId>/<channelId>` through `history.pushState`/`replaceState` (`crowdOsStore.ts:439-448`), called on channel change (`:2889`), workspace enter (`:2816`), workspace switch (`:2758`) and boot (`:876`).
- *Query-shaped hashes*: `#channel=<id>`, `#run=<id>`, `#inbox=<id>`, `#view=jobs|inbox|telemetry` are parsed by `deep-link.ts:45-86`. Note that this parser is reached through `parseDeepLink`, **not** through the hash router — see Gaps.
- *`crowdos://` deep links*: `crowdos://w/<ws>/<channel>`, `crowdos://c/<channel>`, `crowdos://run/<id>`, `crowdos://inbox[/<id>]`, `crowdos://jobs`, `crowdos://telemetry` — `deep-link.ts:88-134`. Parsing is a pure function; application goes through `applyDeepLink` (`deep-link.ts:169-210`), which mirrors the hash router's visibility checks: an unknown workspace is not entered, an invisible channel is not activated, `inbox` maps to the `jobs` panel view, and a run id only triggers the existing `fetchArtifacts` transport. The whole body is wrapped in a `try/catch` — a deep link can never break the shell.

**Responsive behaviour.** Below `xl` the left nav is off-canvas: it is `absolute inset-y-0 left-0` with `translate-x-full` + `invisible`, and `sidebarOpen` flips it in (`App.tsx:205-207`). A backdrop button covers the remainder (`App.tsx:192-200`) and `Escape` closes the nav when no `[role="dialog"][aria-modal="true"], [role="menu"]` is present (`App.tsx:140-146`). The right ops column is `hidden xl:flex`, so below `xl` the ops surface exists only as the `data-slot="ops-sheet"` bottom sheet, whose trigger bar always renders — ops are never fully hidden. The right-panel view tab strip in the chat header is itself `hidden xl:flex` (`MainChatArea.tsx:942`).

**Theme handling.** `main.tsx:13,17` calls `initTheme()` before the first render. `theme.ts:49-64` reads the persisted preference (`crowdos_theme`, `auto|light|dark`), resolves `auto` through `matchMedia('(prefers-color-scheme: light)')`, writes `documentElement.dataset.theme` and `style.colorScheme`, then subscribes to the media-query `change` event and the cross-tab `storage` event. Dark is the untouched default — the light override layer lives in `src/light-theme.css`, imported once in `main.tsx:5`.

## Structural inventory

| Surface | File:line | Role | Key state |
|---|---|---|---|
| `App` (composition root) | `packages/client/src/App.tsx:38` | Portal gate vs workspace shell; 3-panel row; overlay stack; global key handling | `activeWorkspaceId`, `searchOpen`, `sidebarOpen`, `quickAskOpen`, `locked` |
| `main` (entry) | `packages/client/src/main.tsx:23` | Mounts `<App/>` in StrictMode; runs theme init, log forwarder, deep-link subscription before render | — |
| `WorkspacePortal` | `packages/client/components/portal/WorkspacePortal.tsx:54` | Boot surface: workspace list, create, enter; `role="listbox"` list of workspaces | `workspaces`, `isCreatingWorkspace`, `workspaceError` |
| `WorkspaceSidebar` | `packages/client/components/workspace/WorkspaceSidebar.tsx:18` | Channel nav: workspace header, filter, favorites/recents, categories + channels, per-channel create | `toggleCategoryCollapse`, active workspace channels |
| `WorkspaceDropdown` | `packages/client/components/workspace/WorkspaceDropdown.tsx:10` | Workspace header menu: Settings / Create Category / Copy ID / Leave | `dropdownOpen`; `aria-haspopup="menu"`, `aria-expanded` |
| `MainChatArea` | `packages/client/components/workspace/MainChatArea.tsx:100` | Center chat: header, transcript, composer, right-panel view tab strip | `rightPanelView` (bind target of the header tab strip, `MainChatArea.tsx:942`) |
| `RightSidebar` | `packages/client/components/workspace/RightSidebar.tsx:33` | Right ops column: 5 named views | `rightPanelView: 'roster' \| 'repo' \| 'jobs' \| 'telemetry' \| 'browser'` |
| `BottomDrawer` | `packages/client/components/workspace/BottomDrawer.tsx:82` | Named slot `bottom-drawer`: file / diff / log tabs | `bottomDrawerView`, `open`, `height`, `pinnedFile`, `previewFile` |
| `OperationsSheet` | `packages/client/components/workspace/OperationsSheet.tsx:36` | Named slot `ops-sheet`: narrow-width jobs / approvals / repo | `operationsSheetView`, `open` |
| `AgentProfileModal` | `packages/client/components/workspace/modals/AgentProfileModal.tsx:14` | Agent dossier overlay; one of the four lazy modules in `App.tsx:23-26` | `agentProfileModalOpen`, `agentProfileModalId` |
| `AgentStudioModal` | `packages/client/components/studio/AgentStudioModal.tsx:17` | Modular slot manifest + prompt x-ray; a **child** of `AgentProfileModal` (`AgentProfileModal.tsx:634`) and `WorkspaceSettingsModal` (`WorkspaceSettingsModal.tsx:16`), **not** a top-level overlay in `App.tsx` | `agentId`, `open`, `activeTab: 'rack' \| 'xray'` |
| `WorkspaceSettingsModal` | `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:284` | 13-tab settings surface (lazy) | `settingsModalOpen`, `workspaceSettingsTab` |
| `OmniSearchModal` | `packages/client/components/workspace/modals/OmniSearchModal.tsx:19` | Dual Search/Commands palette (lazy) | `open`, `tab: 'search' \| 'commands'`, `armedVerbId` |
| `QuickAsk` | `packages/client/components/workspace/QuickAsk.tsx:19` | Floating capture-tier ask surface (lazy) | `open`, `text` |
| `LockScreen` | `packages/client/components/lockscreen/LockScreen.tsx:11` | Non-dismissible PIN veil over portal and shell alike | `pin`, `unlocking`, `failed` |
| `OfflineBanner` | `packages/client/components/ui/OfflineBanner.tsx:69` | Degraded/queued banner; hidden when everything is healthy | `dbDegraded`, `queuedCount`, socket state |
| `NotificationCenter` | `packages/client/components/ui/NotificationCenter.tsx:131` | Reviewable notification history + DND schedule | `open`, `entries`, `dnd`, `phase` |
| `ThreadDrawer` | `packages/client/components/workspace/ThreadDrawer.tsx:38` | Run-branch thread surface (320 px) | `runId`, `channelId`, `selectedThread`, `alsoSend` |
| `ErrorBoundary` | `packages/client/components/ui/ErrorBoundary.tsx:13` | Per-panel error isolation with a Retry reset | `hasError`, `error` |
| `ToastProvider` | `packages/client/components/ui/ToastProvider.tsx:31` | Global toast stack (max 3) + notification-history append | `toasts` |

## Implementation details

**Composition root.** `App.tsx:46-53` reads the shell's store slice through a single `useShallow` selector so unrelated store writes do not re-render the root. `dbDegraded` is *derived*, not stored: it is true when the active workspace's `database.configured` is `false` (`App.tsx:48`), which is how a DB-less workspace renders as a degraded shell rather than a portal bounce.

**Per-panel error isolation.** Six `ErrorBoundary` instances bracket the shell: portal (`App.tsx:169`), sidebar (`App.tsx:209`), chat (`App.tsx:216`), bottom drawer (`App.tsx:226`), ops sheet (`App.tsx:236`), right sidebar (`App.tsx:244`). Each supplies a distinct fallback string, so a crash in one slot never blanks the others. `ErrorBoundary.tsx:16-22` uses `getDerivedStateFromError` + `componentDidCatch` (console error only, no remote reporting); the default fallback renders the error message plus a Retry button that resets `hasError` (`ErrorBoundary.tsx:31-36`). Custom fallbacks replace the default entirely.

**Lazy overlay stack.** The four overlay surfaces are `React.lazy` at module scope (`App.tsx:23-26`) so they are not in the initial chunk; they are mounted inside one `<Suspense fallback={<SpinnerFallback/>}>` (`App.tsx:252-257`) with `SpinnerFallback` declaring `role="status"` and `aria-label="Loading dialog"` (`App.tsx:28-36`). `AgentProfileModal` and `WorkspaceSettingsModal` take no props — they read their own open state from the store, so they can be mounted unconditionally.

**Global shortcuts.** One `keydown` listener on `window` (`App.tsx:138-162`):
- `Ctrl/Cmd + Shift + K` toggles QuickAsk; the explicit Shift guard keeps `Ctrl/Cmd + K` for the palette — `App.tsx:149-154`.
- `Ctrl/Cmd + K` toggles the palette — `App.tsx:155-158`.
- `Escape` closes the off-canvas nav, but only when no modal dialog or menu is mounted — the overlay check is `document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')` (`App.tsx:140-146`).

The palette verb registry cannot hold React state, so the QuickAsk verb dispatches a window event `crowdos:quick-ask-open`, which `App.tsx:70-77` listens for and converts into `setQuickAskOpen(true)`.

**Screen lock.** `App.tsx:80-100` polls every 10 s and reads `screenLockEnabled` from the *active workspace*; `mousemove`, `keydown` and `focus` all call `touchActivity()`. `SCREENLOCK_IDLE_MS` lives in `stores/screenLockStore.ts`. `LockScreen` renders at the App root (`App.tsx:258`) so the same veil covers both the portal and the shell; it has no close control and ignores Escape (`LockScreen.tsx:8-10`).

**Toasts.** `ToastProvider.tsx:28-29` caps the stack at 3 (oldest dropped) and auto-dismisses quiet toasts after 4 s while assertive (error) toasts persist until dismissed. Every toast is also appended to the notification history journal (`ToastProvider.tsx:54-67`), best-effort — a storage failure never breaks the live stack. Rendering uses `role="status"` + `aria-live="polite"` for quiet and `role="alert"` + `aria-live="assertive"` for errors (`ToastProvider.tsx:98-99`).

**Deep links.** `main.tsx:15,21` subscribes before the first render so a `crowdos://` click that arrives during boot is not lost (`deep-link.ts:217-248`; the module doc comment states this ordering requirement). The Electron preload bridge is `window.crowdos.on('crowdos:deep-link', handler)`; when the bridge is absent the subscription is a no-op.

**Focus management.** `use-overlay-focus.ts:52-135` is the shared trap: it records `document.activeElement` before opening, moves focus to `initialFocusRef` (or the first visible focusable) inside a `requestAnimationFrame`, intercepts `Tab`/`Shift+Tab` in the capture phase to wrap within the container, and on close restores focus to the recorded element (falling back to a `fallbackFocusSelector`). The shell itself does not trap focus — that is the overlay surfaces' responsibility, tracked in `Panels, Drawers, Overlays.md`.

**Boot ordering.** `main.tsx:13-21` runs `initTheme()`, `installDesktopLogForwarder()` and `subscribeDesktopDeepLinks()` before `createRoot(...).render(...)`, so theme, logging and deep links are live before first paint.

## Interaction model

| Action | Target | Result | Evidence |
|---|---|---|---|
| First launch, no workspace | shell root | Portal gate renders; no workspace chrome | `App.tsx:165-175` |
| Enter a workspace | portal row | `enterWorkspace(id)`; shell replaces the portal | `WorkspacePortal.tsx:156`; `crowdOsStore.ts:2790` |
| Open a palette | `Ctrl/Cmd + K` | `searchOpen` toggles; `OmniSearchModal` opens | `App.tsx:155-158` |
| Open QuickAsk | `Ctrl/Cmd + Shift + K` | `quickAskOpen` toggles | `App.tsx:149-154` |
| Run a QuickAsk verb | palette Commands tab | verb dispatches `crowdos:quick-ask-open`; QuickAsk opens | `App.tsx:70-77`; `palette-verbs.ts:97` |
| Open the nav below `xl` | chat header hamburger | `sidebarOpen = true`; nav translates in; backdrop appears | `App.tsx:192-212` |
| Close the nav | Escape (no overlay open) | `sidebarOpen = false` | `App.tsx:143-146` |
| Back / forward | browser history | `popstate` + `hashchange` re-resolve workspace + channel | `App.tsx:103-135` |
| Deep link | `crowdos://…` | parsed, visibility-checked, applied | `deep-link.ts:147-210` |
| Idle past the threshold | any input | `screenLockStore.lock()`; `LockScreen` mounts over everything | `App.tsx:83-88`, `App.tsx:258` |
| Unlock | PIN field | `unlockWithPin(pin)`; failure shows an inline alert | `LockScreen.tsx:22-34`, `:69-73` |
| A panel throws | any slot | that slot's `ErrorBoundary` fallback; other slots keep working | `App.tsx:169-247`; `ErrorBoundary.tsx:24-39` |

## Performance notes

| Aspect | Approach | Evidence |
|---|---|---|
| Initial bundle | Overlay modals are `React.lazy` at module scope, so the workspace shell downloads without them | `App.tsx:23-26` |
| Overlay mount | One `<Suspense>` boundary for the whole overlay stack, with a single labelled skeleton | `App.tsx:252-257`, `:28-36` |
| Store subscriptions | The shell reads one shallow-compared slice; panel components use their own `useShallow` selectors | `App.tsx:46-53`; `RightSidebar.tsx:34-46` |
| Screen-lock polling | 10 s interval, cleared on workspace change | `App.tsx:90`, `:94-99` |
| Ledger polling | 30 s interval, workspace-scoped, never blocks send | `RightSidebar.tsx:105` |
| Deep-link parsing | Pure string work; the store is imported dynamically to avoid a static cycle | `deep-link.ts:178` |
| Toast stack | Capped at 3 so the stack cannot grow unbounded | `ToastProvider.tsx:48` |

## Evidence

| ID / pointer | What it shows |
|---|---|
| `packages/client/src/App.tsx:38-263` | Composition root: portal gate, 3-panel row, named slots, lazy overlay stack, key handling, screen-lock poll, hash router |
| `packages/client/src/main.tsx:13-27` | Boot order: theme, log forwarder, deep links before render |
| `packages/client/src/config/deep-link.ts:45-210` | Hash + `crowdos://` parsing and the visibility-checked apply path |
| `packages/client/src/config/theme.ts:20-64` | Theme resolution, `data-theme` write, media-query and storage listeners |
| `packages/client/components/ui/ErrorBoundary.tsx:13-42` | Error isolation primitive and its Retry reset |
| `packages/client/components/ui/ToastProvider.tsx:28-99` | Toast cap, auto-dismiss policy, live-region roles, history append |
| `packages/client/components/portal/WorkspacePortal.tsx:54-323` | Portal boot surface and its `role="listbox"` workspace list |
| `packages/client/components/workspace/WorkspaceSidebar.tsx:197-307` | Channel nav composition: header, filter, favorites/recents, categories |
| `packages/client/components/workspace/MainChatArea.tsx:942-1000` | Right-panel view tab strip, `hidden xl:flex`, bound to `rightPanelView` |
| `re-docs/Frontend Docs/Domain Spec/Workspace Shell.md` | Canonical CrowdOS shell spec (source of intent, not of current behaviour) |
| `UX_GUIDELINE.md:56-68` | Locked slot map — the normative contract this document measures against |

## Gaps

- **`UX_GUIDELINE.md:59` describes a "Workspace rail 56px" that does not exist in code.** There is no rail element anywhere in `App.tsx`; the shell row has exactly three children (nav, main, aside) at `App.tsx:190-249`. The guideline also promises a rail with "icons, unread pills, mention badges, Add, Portal home" (`UX_GUIDELINE.md:64`). This is specification drift, not an implementation gap. It needs a decision: build the rail, or amend the guideline.
- **`UX_GUIDELINE.md:66` promises a "segmented control bound to `rightPanelView` enum" in the chat header, and it exists** (`MainChatArea.tsx:942-1000`) — but it is `hidden xl:flex`, so below `xl` the only way to change the right-panel view is the palette verb (`palette-verbs.ts:89-95`) or the ops sheet. There is no narrow-width equivalent of the view strip.
- **The query-shaped hashes are not honoured by the hash router.** `App.tsx:103-135` parses the hash by splitting on `/` and treating the last segment as a channel id (`App.tsx:107-108`); it understands the path form `#<workspaceId>/<channelId>` and, only by accident, `#channel=<id>` (which arrives as a single segment and fails the visible-id check, so it is actually dropped). The `#run=` / `#inbox=` / `#view=` forms are parsed by `deep-link.ts:61-81` but that parser is reached only through `parseDeepLink` — i.e. from a `crowdos://` URL or from `applyDeepLink` in the notification centre. A user who types `#run=abc` into the address bar gets no reaction. Verified: `handlePopState` never calls `parseDeepLink`.
- **The hash is written back, but only in one shape.** `pushChannelHistory(workspaceId, channelId, replace)` writes `#<workspaceId>/<channelId>` through `history.pushState`/`replaceState` (`crowdOsStore.ts:439-448`) and is called on channel change (`:2889`), workspace enter (`:2816`), workspace switch (`:2758`) and boot (`:876`). The query forms are never written, so they are hand-typed-only. `pushState` also means the `popstate` listener in `App.tsx:129` is what drives back/forward, while `hashchange` (`App.tsx:130`) covers hand-edited hashes.
- **`AgentStudioModal` is eagerly imported by both of its hosts.** `AgentProfileModal.tsx:11` and `WorkspaceSettingsModal.tsx:16` use static imports, so the studio modal's code is in those chunks rather than in its own lazy module. It stays out of the *initial* bundle, but opening the profile modal also downloads the studio editor. `UX_GUIDELINE.md:162` requires overlay modals to stay out of the initial bundle — satisfied — but not to be independently split.
- **No `banner` / `contentinfo` landmarks.** The shell renders `nav` and `main` and an `aside` with an `aria-label`, but there is no top-level banner or footer region (`App.tsx:177-249`). The Discord corpus explicitly flags Discord's omission of those landmarks as a thing not to copy (`../Discord Findings/Keyboard and Accessibility.md`, Target Contract).
- **The `aside` label does not mention the browser view.** `App.tsx:243` labels the region "roster, repository, jobs, and telemetry", but `rightPanelView` also has a `browser` member (`types/crowdOs.ts:323`) and `RightSidebar.tsx:325-340` renders it. The landmark name is out of date.
- **Backdrop dismissal is pointer-only.** The nav backdrop is a `<button>` (`App.tsx:193-199`) and is reachable by keyboard, but no test asserts the Escape path is reachable when a modal is open — the guard at `App.tsx:140-142` is a DOM query evaluated per keystroke, not verified.
- **Screen-lock idle detection polls, it does not observe.** A 10 s `setInterval` (`App.tsx:90`) means the lock can fire up to 10 s after the true idle deadline. Not verified against `SCREENLOCK_IDLE_MS`.
- **`ThreadDrawer` is mounted by `MainChatArea`, not by the shell**, so it has no shell-level ErrorBoundary. A throw inside the thread branch takes down the whole chat column rather than one slot. Not verified at runtime; inferred from the absence of an `ErrorBoundary` in `MainChatArea.tsx`.

## User Decision:

## Target Contract

> Status: Target. CrowdOS's locked design contract (`UX_GUIDELINE.md` §1–§14, `AGENTS.md` §5) takes precedence over anything observed here. The gaps above are the gap between contract and code, not a description of an intended end state.

* The shell MUST keep one composition root and one named-slot map. Slots MUST NOT reorder or swap meaning, and each slot MUST be addressable by a stable attribute — `data-slot="bottom-drawer"` and `data-slot="ops-sheet"` are the current names (`App.tsx:225`, `:235`).
* "One shell, stable slots." A panel MUST be addressed by a named view enum, never a boolean that flips meaning (`UX_GUIDELINE.md:32`).
* The shell MUST have exactly one portal gate: the portal is the boot surface, and the workspace shell MUST NOT render before a workspace is entered (`App.tsx:165-175`).
* Below `xl`, ops MUST never be fully hidden (`UX_GUIDELINE.md:68`). The `data-slot="ops-sheet"` trigger bar always renders; the right column is `hidden xl:flex` (`App.tsx:235`, `:243`).
* Every slot MUST be isolated by an `ErrorBoundary` so a failure in one surface cannot blank the others (`App.tsx:169-247`).
* Overlay surfaces that are not needed for the workspace shell MUST stay out of the initial bundle (`UX_GUIDELINE.md:162`; `App.tsx:23-26`).
* Navigation state MUST be resolvable from the URL, and a deep link MUST NOT be able to activate a workspace or channel the user cannot see. The visibility checks in `App.tsx:112-127` and `deep-link.ts:187-197` are the reference behaviour.
* Deep links MUST be best-effort: a malformed or unknown target MUST NOT break the shell (`deep-link.ts:207-209`).
* Keyboard completeness is mandatory: every verb, switch, mount, diff, approve and cancel MUST be reachable without a pointer, and a dismissed modal MUST restore focus to its trigger (`UX_GUIDELINE.md:150`; `use-overlay-focus.ts:65-70`, `:126-132`).
* Skip-to-chat MUST exist (`UX_GUIDELINE.md:150`; `App.tsx:180-185`).
* Theme MUST be resolved before first paint so no flash of the wrong layer is possible (`main.tsx:13,17`).
* The workspace rail described in `UX_GUIDELINE.md:59,64` MUST either be implemented or the guideline MUST be amended in the same task. Leaving the two documents contradicting each other is forbidden by `AGENTS.md` §6.

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| `<nav aria-label="Workspace channels">` off-canvas below `xl` (`App.tsx:203-212`) | Guild rail + channel sidebar, two separate columns | `../Discord Findings/Shell and Navigation.md` | Discord has a dedicated guild rail (`navigation "Servers sidebar"` → ARIA `tree`) plus a channel sidebar; CrowdOS has one nav column and no rail — the rail in `UX_GUIDELINE.md:59` is unimplemented. Discord's rail is a real `tree` with `level`/`selected`; CrowdOS's nav is a flat list of categories and channels. |
| Hash router `App.tsx:103-135` | Regex route table (`/channels/<guild>/<channel>[/threads/<t>[/<m>]]`) plus an `isAppRoute` allowlist | `../Discord Findings/Shell and Navigation.md` | CrowdOS parses a hash string by hand and writes back only `#<workspaceId>/<channelId>` (`crowdOsStore.ts:439-448`); Discord uses path builders, validates against an allowlist, and its URLs are the single source of truth for navigation. CrowdOS's query-shaped hashes (`#run=`, `#view=`) are parsed by a different module than the router that reads the hash. CrowdOS's `crowdos://` scheme is an additional scheme Discord does not have (`disclip` is Discord's closest analogue, in `../Discord Findings/Desktop Shell Delta.md`). |
| `crowdos://` deep links (`deep-link.ts:88-134`) | `disclip` privileged custom protocol registered before `app.whenReady()` | `../Discord Findings/Desktop Shell Delta.md` | Both register a custom scheme before ready. CrowdOS's protocol surface is `w/c/run/inbox/jobs/telemetry`; Discord's is a single clipboard scheme with `standard,secure,corsEnabled,supportFetchAPI,stream` privileges. |
| Portal gate `WorkspacePortal.tsx:54` | Guild rail "Add a Server" affordance + `Direct Messages` tree entry | `../Discord Findings/Shell and Navigation.md` | Discord's workspace switcher is a rail entry inside the shell; CrowdOS's is a separate full-screen portal that replaces the shell entirely. CrowdOS keeps the shell mounted and hides the portal; Discord never unmounts the shell. |
| Workspace header dropdown `WorkspaceDropdown.tsx:56-60` | Guild context menu (`"Edit Your Server List"`, `"Add a Server"`, `"Customize"`) | `../Discord Findings/Shell and Navigation.md` | CrowdOS's dropdown is a `role="menu"` popover with `aria-haspopup`/`aria-expanded`/`aria-controls`; Discord's is a context menu opened from the rail. Both are per-workspace commands in one place. |
| Right-panel view tab strip `MainChatArea.tsx:942-1000` | Channel-header `button "Show Member List"` + four header popovers | `../Discord Findings/Right Panel and Members.md` | Discord has **no** right-pane tab strip — one optional column plus header popovers. CrowdOS has a permanent 5-view tab strip bound to `rightPanelView`. The Discord contract for the right pane is a single toggle, which CrowdOS deliberately does not follow. |
| Skip-to-chat link `App.tsx:180-185` | Not present in Discord's landmark set | `../Discord Findings/Keyboard and Accessibility.md` | Discord exposes `navigation` ×2, `main` ×1, `region` ×2 and no `banner`/`contentinfo`/`complementary`; CrowdOS adds an explicit skip link and a named `aside` landmark. Discord's contract warns that its landmark omission is not a pattern to copy. |
| Per-panel `ErrorBoundary` (`App.tsx:169-247`) | `role="dialog"` ×8 in the bundle, trap implementation not traced | `../Discord Findings/Keyboard and Accessibility.md` | CrowdOS isolates *layout slots* with error boundaries; Discord isolates *overlays* with a focus-trap layer. Neither is a like-for-like mechanism. |
| Toast stack `ToastProvider.tsx:93-137` | Two unnamed `log` live regions (`live=assertive`, `live=polite`) | `../Discord Findings/Shell and Navigation.md` | CrowdOS renders per-toast `role="status"`/`role="alert"` elements with a 3-item cap and a 4 s auto-dismiss; Discord uses two persistent `log` regions and the browser's announcement queue. CrowdOS's cap matches `UX_GUIDELINE.md:49`. |
| Global shortcuts `App.tsx:138-162` | One global shortcut registry (module `938812`) with per-binding scope | `../Discord Findings/Keyboard and Accessibility.md` | Discord centralises every binding in a single enum-keyed map with explicit `comboKeysBindGlobal` scope and a dispatch bus that unwinds layers on Escape. CrowdOS has a single `keydown` listener with three hard-coded chords, and the palette verb registry is a separate mechanism. CrowdOS's contract forbids per-component ad-hoc handlers — the current shell listener is the shell-level exception, not a violation. |
| Lazy overlay stack `App.tsx:23-26` | 4,479 lazy chunk ids from 41,855 dynamic-import sites; main chunk 12.5 MB | `../Discord Findings/Performance Model.md` | CrowdOS lazy-loads 4 overlays via `React.lazy`; Discord lazy-loads at chunk granularity including the emoji dataset (`vnd-emoji` chunk). Discord's contract explicitly does not require visual or bundle parity. |
| Screen lock `App.tsx:80-100`, `LockScreen.tsx:11` | No equivalent; Discord's Mute/Deafen are voice switches in the user area | `../Discord Findings/Shell and Navigation.md` | CrowdOS has a workspace-scoped idle lock with a non-dismissible PIN veil covering portal and shell; Discord has no idle lock in the analysed shell. Discord's `switch "Mute"` / `"Deafen"` are the only comparable always-visible state switches. |
| Theme `theme.ts:28-37` | `nativeTheme` = 0 occurrences in the analysed shell | `../Discord Findings/Desktop Shell Delta.md` | CrowdOS resolves the theme in the renderer before first paint and writes `data-theme`; Discord's shell does not touch `nativeTheme` at all. |

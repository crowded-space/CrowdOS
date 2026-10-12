# Client Infra

## Purpose

Application boot, shell composition, and cross-cutting plumbing: entry point, API layer, socket setup, PIN injection, desktop storage taxonomy, deep-link parsing, and shared UI primitives (toasts, error boundaries, brand icons).

## Feature Scope

In-scope: `main.tsx`/`App.tsx` boot and layout shell, typed API client, socket.io instantiation + join debounce, PIN storage + header injection, storage classification + quota guard, deep-link parse/apply/subscribe, desktop log forwarder + autostart helper, `OfflineBanner`, `ToastProvider`, `ErrorBoundary`, `CrowIcon`, `Primitives` kit.

Non-goals (other areas): feature rendering inside the shell panels (each UI doc), state shapes and ingestion (Stores), lock triggers/UX (LockScreen), server implementations of the REST/socket contracts.

## Expect

- `[Observed]` Boot mounts `App` under `StrictMode` with no providers, router, or auth gate at the entry (`main.tsx:22-26`).
- `[Observed]` `App` fetches workspaces once on mount; with no active workspace it renders only the portal, otherwise the 3-panel shell (`App.tsx:49-52,124-135`).
- `[Observed]` Shell panels are independently guarded: sidebar, chat, and roster each sit in their own `ErrorBoundary` with inline fallbacks (`App.tsx:153-171`).
- `[Observed]` Overlay-only modals (profile, workspace settings, omni-search) lazy-load outside the initial bundle (`App.tsx:21-23,176-180`).
- `[Observed]` Every `/api/` (and `/socket.io`) `fetch` carries the PIN automatically via a global patch; `apiClient` additionally sets `x-workspace-id` per request (`src/config/pin.ts:148-165`, `src/api/client.ts:72-89`).
- `[Observed]` The PIN merge preserves the caller's headers for all three `HeadersInit` arms — `withPinHeaders` normalizes through `new Headers()` and adds `x-pin`/`Authorization` only when absent, so a `Headers` instance passed by `apiClient` survives intact (`src/config/pin.ts:107-127`).
- `[Observed]` Socket auto-connects same-origin with infinite retry (1 s → 5 s backoff) and rejoins the persisted channel on every connect (`src/config/socket.ts:16-28,98-105`).
- `[Observed]` Rapid channel switches collapse to one `channel:join` per channel via 400 ms per-channel debounce; join cache pruned to 100 (`src/config/socket.ts:45-80`).
- `[Observed]` Toasts auto-dismiss in 4 s and stack from the bottom, and `useToast` outside a provider degrades to `console.log` (`ToastProvider.tsx:41-43,108-118`).
  - `[Observed]` Workspace fetch is measured with `performance.mark`/`performance.measure('fetchWorkspaces')` (`crowdOsStore.ts:2432-2433`); the Settings Diagnostics tab (`settings/DiagnosticsTab.tsx`) reads those entries plus navigation timing for its measured-only S12 rows and reports unmeasured budgets as no-data rather than inventing numbers.
- `[Observed]` Toasts stack max 3 (oldest drops beyond 3) from the bottom, and `useToast` outside a provider degrades to `console.log` (`ToastProvider.tsx`). Every toast/show call also appends to `notification-history-model` (kind toast, errors assertive, cap 100) best-effort; the header bell in `MainChatArea` (a dedicated notification-center trigger, never the mute control) opens `NotificationCenter` and carries the DND-gated unread badge (count hidden/frozen during DND with an explicit DND label), while mute stays a per-channel toggle inside the center. Quiet toasts (success/info) render `role=status aria-live=polite` with 4 s auto-dismiss; assertive errors render `role=alert` and persist until dismissed so need-me events survive. The `useToast` API is unchanged.
  - `[Observed]` Deep links extend the `crowdos://w/<ws>/<ch>` + `crowdos://c/<ch>` shapes with run/inbox/view targets: `crowdos://run/<runId>` (alias `r`), `crowdos://inbox/<inboxId?>`, `crowdos://jobs`, `crowdos://telemetry`, plus `#run=<id>` / `#inbox=<id>` / `#view=jobs|inbox|telemetry` hash forms (`deep-link.ts`). `applyDeepLink` activates the channel, then maps `inbox→jobs` view and loads run diffs via the existing `fetchArtifacts` transport (best-effort); existing shapes are byte-identical. Renderer run-completion `Notification` clicks route to `applyDeepLink({ channelId, runId })` best-effort (`crowdOsStore.ts`). No native notify bridge is used: `window.crowdos` exposes `invoke`/`on` + `pickDirectory` only.
- `[Inferred]` Desktop (Electron) features are additive and inert on web: bridge detection guards the backend-URL sniff and deep-link subscription.

## Flow

1. Entry: `createRoot` renders `<StrictMode><App/></>` plus global CSS (`main.tsx:22-26`).
2. Bootstrap: `App` calls `fetchWorkspaces()` once (`App.tsx:49-52`); portal gate decides portal vs shell (`App.tsx:124-135`).
3. Shell: left sidebar (`md+`), center chat, right roster (`md+`), lazy modals, lock veil on top (`App.tsx:137-181`).
4. Navigation: hash (`#ws/ch`, `#ch`, `#channel=`) is the URL contract — store pushes history on channel change; `App` handles `popstate`/`hashchange` with visibility checks before entering/activating (`App.tsx:77-110`); `Cmd/Ctrl+K` toggles omni-search (`App.tsx:112-122`).
5. API: callers use `apiClient` methods or the exported `fetchJsonOrThrow`/`fetchNoContentOrThrow`; headers inject `x-workspace-id` + `x-pin`; errors surface as `Error(message || error || fallback)` (`src/api/client.ts:72-104`).
6. Realtime: shared `socket` instance; `emitChannelJoin` debounced per channel; store registers domain handlers (Stores).
7. Deep-link (desktop): `parseDeepLink` accepts `crowdos://w/<ws>/<ch?>`, `crowdos://c/<ch>`, bare forms, and hash forms; `applyDeepLink` reuses the visibility checks via dynamic store import; `subscribeDesktopDeepLinks` listens on `window.crowdos` `crowdos:deep-link` (`src/config/deep-link.ts:95-186`).

## Current Implementation

| Piece | Role |
|---|---|
| `src/main.tsx` | Entry: root render under `StrictMode` |
| `src/App.tsx` | Boot fetch, portal gate, 3-panel responsive shell, lazy modals, hash-router sync, search shortcut, idle-lock wiring host, veil mount |
| `src/api/client.ts` (310 lines) | `BACKEND_URL=''`, dynamic base via Electron bridge, `resolveApiUrl`, workspace/PIN header state, `fetchJsonOrThrow`/`fetchNoContentOrThrow`, `apiClient` (workspaces, screen-lock, categories/channels/agents/modules/profiles, messages, events, artifacts, search, approvals, runs, files) |
| `src/config/socket.ts` | `io()` singleton, `emitChannelJoin` (+ prune, `cleanupSocketJoins`), connect rejoin, throttled `connect_error` log, `refreshSocketPin` stub |
| `src/config/pin.ts` | Memory-first PIN + `crowdos_pin` mirror + `VITE_LOCAL_PIN` fallback; `get/set/clear/hasPin`; header helpers; idempotent global fetch patch |
| `src/config/desktop-storage.ts` | Storage taxonomy (`ui-pref` / `cursor` / `unknown`), `safeGet/safeSet/safeRemove` with quota-eviction of largest cursor mirror |
| `src/config/deep-link.ts` | `parseDeepLink`, `applyDeepLink`, `subscribeDesktopDeepLinks` (subscribed at boot in `main.tsx`) |
| `src/config/desktop-log.ts` | Renderer → `crowdos:log:write` forwarder for console.warn/error + unhandled rejections (no-op in browsers) |
| `src/config/autostart.ts` | `canAutostart/getAutostart/setAutostart` over `crowdos:autostart:get/set` (no-op in browsers) |
| `components/ui/OfflineBanner.tsx` | Offline vs socket-down vs DB-degraded strip (mounted in `App` above the 3-panel area) |
| `components/ui/Primitives.tsx` | Prestige-minimal kit: `Modal` (z-50, 8px shell), `Button` (4 variants), `Input`, `Badge` (square, 5 tones), `Toggle` (single language), `EmptyState`, `Skeleton` |
| `components/ui/AutostartToggle.tsx` | Desktop-only launch-on-login switch (null in browsers; mounted in Workspace Settings → Screen Lock) |
| `components/ui/ToastProvider.tsx` | Toast context (`toast`, `showSuccess/Error/Info`), animated stack, manual dismiss; every call also appends to the persisted history journal (kind toast, errors assertive) best-effort so the live stack never breaks on storage failure |
| `components/ui/notification-history-model.ts` | Persisted history journal (cap 100, `crowdos_notification_history`/`crowdos_notification_dnd` keys, load/append/mark-read/subscribe) plus local DND schedule (enabled + start/end hour) with DND-active check gating the header badge only; history keeps recording during DND |
| `components/ui/NotificationCenter.tsx` (`NotificationCenter`, default export; `useNotificationCenterBadge`) | Review UI over real history only (loading skeleton, honest empty, error-with-cause-and-retry); newest-first rows deep-link via `applyDeepLink` (channel + run through `fetchArtifacts`, approvals through the inbox view); per-row + mark-all-read + confirm-guarded clear; DND editor persists local-only; `role=dialog aria-modal` with focus trap, Escape/backdrop close, and focus return; header trigger in the chat toolbar carries the DND-gated badge (hidden/frozen during DND with an explicit DND label) |
| `components/ui/ErrorBoundary.tsx` | Class boundary: `fallback` prop or default rose panel with Retry state reset |
| `components/ui/CrowIcon.tsx` | 8 `crow-*` SVG variants + emoji→variant hash fallback; `CrowdOSWordmark`/`CrowdOSFullLogo` image brandmarks |

## Props & Store

- `ToastProvider`: props `{ children }`; context `{ toast, showSuccess, showError, showInfo }` (`ToastProvider.tsx:14-23`). Every call persists to history via `appendNotificationHistory` (kind toast, assertive on error) best-effort.`r`n- `NotificationCenter { open; onClose; channelId?; channelName?; isChannelMuted?; onToggleMute? }` plus `useNotificationCenterBadge(): { unreadCount; rawUnread; dndActive; dndLabel }` (`NotificationCenter.tsx`). DND schedule persists local-only (`crowdos_notification_dnd`); badge count is 0 during DND while `rawUnread` and rows keep recording.
- `ErrorBoundary`: props `{ children, fallback? }`; state `{ hasError, error? }` (`ErrorBoundary.tsx:3-11`).
- `CrowIcon`: props `{ variant, className?, iconSize? }`; `variant` accepts `crow-*` or any string/emoji (hashed to a variant) (`CrowIcon.tsx:14-18,48-50`).
- `App` selects 6 store fields via `useShallow` + `locked` from the screen-lock store (`App.tsx:36-47`); infra otherwise holds no app state (module-level `currentWorkspaceId`/`currentPin`/`dynamicBackendUrl` in `api/client.ts:11-41`).

## Relations

- Parents: none (`main.tsx` is the root).
- Children: `WorkspacePortal`, `WorkspaceSidebar`, `MainChatArea`, `RightSidebar`, lazy `AgentProfileModal`/`WorkspaceSettingsModal`/`OmniSearchModal`, `LockScreen` — all mounted by `App`.
- Store: `App` drives `fetchWorkspaces`/`enterWorkspace`/`setActiveChannel`; `api/client.ts` exposes `setActiveWorkspaceId` for tenant header scoping.
- API surface (representative): `api/workspaces[/:id][/screen-lock]`, `api/workspaces/database/test`, `api/categories|channels|agents|modules|providers/generation`, `api/channels/:id/messages[?before]`, `api/events/recent`, `api/artifacts`, `api/search`, `api/approvals/:id/decision`, `api/runs/:id/resume`, `api/workspace/files[/content]`.
- Socket: `channel:join` emitted; all domain receives owned by Stores.

## Emits-Listens

- Socket sent (infra): `channel:join` only (debounced). Socket received (infra): `connect` (rejoin persisted channel), `connect_error` (throttled warn), `reconnect_failed` (error log).
- Bridge: reads `crowdos:config:get` once for `backendBaseUrl` (`src/api/client.ts:22-31`); deep-link channel `crowdos:deep-link` (subscribe helper only — no caller observed).
- Toasts: infra provides; features consume. No store actions owned here.

## Owns

Module singletons: `socket` instance, join-debounce tables (`lastJoinAt`, timers), `memoryPin`, fetch-patch flag `__pinFetchPatched`, `dynamicBackendUrl`, `currentWorkspaceId`/`currentPin`. Toast list (per-`ToastProvider` mount). Nothing persisted except via `pin.ts` (`crowdos_pin`), the taxonomy helpers, and the notification journal (`crowdos_notification_history`, cap 100) plus the DND schedule (`crowdos_notification_dnd`).

## Flags

`VITE_LOCAL_PIN` (PIN fallback, `pin.ts:69`). `VITE_API_URL` is documented in `.env.example` and typed in `vite-env.d.ts` but never read — both HTTP modules hardcode `BACKEND_URL = ''` (relative URLs). No feature toggles.
- `[Observed]` Typography: `Outfit` for UI sans + `JetBrains Mono` for code (`index.html`, `src/index.css --font-sans`); `h1-h3 text-wrap:balance`, `p text-wrap:pretty`, `.tnum` tabular-nums for telemetry/counts.
- `[Observed]` Shell has skip-to-chat link, `nav`/`main`/`aside` landmarks, `grain-overlay` (5% SVG noise, reduced-motion off), tinted shadows `rgba(10,14,32,0.55)`; toasts at `z-[70]` scale (`App.tsx`, `ToastProvider.tsx`, `index.css`).
- `[Observed]` `index.html` carries description + og:title/description/image; title is sentence-case descriptor.
- `[Observed]` Shape rule 2026-09-26: circles only for status dots, knobs, glows; chips/buttons/inputs `rounded-md` (8px), cards/panels `rounded-xl` (12px), modal shells `rounded-2xl` (14px) via restrained `@theme` scale. Motion rule: buttons/links settle in 200ms unless a component declares its own duration.
- `[Observed]` Motion budget 2026-10-05 (single-pulse rule, Phase G): `src/index.css` owns `pulse-once` (single 1.2s pulse, channel mention dot) + `animate-pulse-slow` (3s loop, pending approval cards only, static once decided) with `prefers-reduced-motion` gates collapsing all pulse/spring/shimmer to static; roster rows tick elapsed time without pulsing, toasts fade (motion opacity/y/scale 0.2s) never pulse with a max-3 stack.
- `[Observed]` Theme 2026-09-26: `src/config/theme.ts` (auto/light/dark, localStorage `crowdos_theme`, system listener) + `initTheme()` in `main.tsx` + `src/light-theme.css` for the light palette and dark-utility remaps; accent `#465EDB` locked in both; `color-scheme: light dark` meta. Fonts self-hosted via `@fontsource/outfit` + `@fontsource/jetbrains-mono`, no Google Fonts links.
- `[Observed]` Accessibility contrast 2026-10-09: `src/light-theme.css` maps used status text and tinted status surfaces for light backgrounds, keeps input boundaries visible, and adds a brand-accent `:focus-visible` outline. `UX_GUIDELINE.md` records the warm light palette; checked text pairings meet 4.5:1 and form edges/focus meet 3:1.

## Decisions

- `[Observed]` Same-origin-by-default: empty base URL + relative paths; Electron backend URL is sniffed at runtime, not build time (`src/api/client.ts:9-38`).
- `[Observed]` PIN delivered by monkey-patching `fetch` for legacy direct calls, so every call site is covered without edits (`src/config/pin.ts:148-165`).
- `[Observed]` The fetch patch merges rather than replaces headers: `withPinHeaders` normalizes any `HeadersInit` through `new Headers()` and only adds `x-pin`/`Authorization` when the caller left them unset. The earlier `Object.entries(init.headers)` merge enumerated only the plain-object arm, so a `Headers` instance (what `apiClient` passes) contributed nothing and every `apiClient` call lost `x-workspace-id` and `Content-Type` (`src/config/pin.ts:107-127`).
- `[Observed]` Tenant scoping: `x-workspace-id` is injected by the global fetch patch for every `/api/` request whose caller did not set it explicitly; the patch reads the ACTIVE workspace id through a getter registered by the store at module load (`setActiveWorkspaceIdGetter`, `src/config/pin.ts`). This closes the QA-audit 2026-09-23 defect where store-level create/list/budget fetches skipped the header and the server filed rows under the `default` scope.
- `[Observed]` Tenant scoping: `x-workspace-id` is injected by the global fetch patch for every `/api/` request whose caller did not set it explicitly; the patch reads the ACTIVE workspace id through a getter registered by the store at module load (`setActiveWorkspaceIdGetter`, `src/config/pin.ts`). `apiClient` additionally falls back to that registered id in `buildHeaders` (`src/api/client.ts`), so cold-restored sessions (store init restores `activeWorkspaceId` from localStorage without calling `setActiveWorkspaceId`) still scope test/get/update to the active workspace instead of the global scope. This closes the QA-audit 2026-09-23 defect where store-level create/list/budget fetches skipped the header and the server filed rows under the `default` scope.
- `[Observed]` Overlays lazy-loaded; panels error-isolated; toasts stack from the bottom — shell stays up when one piece fails.
- `[Observed]` Storage split is classification-first: tiny prefs stay, mirrors are evictable, with a documented future move of cursors to main-process `userData` (`desktop-storage.ts:1-37`).
- `[Inferred]` `refreshSocketPin` is a reserved hook, not an implementation — socket re-auth after PIN changes has no real path today.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Same-origin default plus lazy overlays plus panel isolation stay; dead config, PIN plumbing, socket hygiene, and portal boundary are the gaps.
Same-origin-by-default with runtime Electron backend sniff stays. Build-time backend URLs are forbidden.
VITE_API_URL MUST be wired or removed from docs, types, and env examples. Documented-but-unread config is forbidden.
PIN delivery MUST have one canonical path: apiClient x-pin via setActivePin, or the pin.ts fetch patch as the declared mechanism with the other removed. Permanently-empty header path alongside a monkey-patch is forbidden.
Tenant scoping MUST go through one path: apiClient x-workspace-id for all calls. Bare-fetch manual header passing alongside apiClient is forbidden.
subscribeDesktopDeepLinks MUST have a verified caller or be removed. Parsed-but-never-subscribed deep links are forbidden.
cleanupSocketJoins MUST have a caller on unmount or join timers MUST self-clean. Leaked pending join timers are forbidden.
refreshSocketPin MUST be implemented as a real socket credential refresh or removed with unlock re-auth documented through the fetch path. Called-on-every-unlock no-op stubs are forbidden.
Store MUST write through desktop-storage safe helpers with quota guard, or the taxonomy MUST be removed. Raw localStorage writes alongside an unused quota-guard module are forbidden.
Portal branch plus app root MUST have an ErrorBoundary. Unguarded portal crash is forbidden.
All store fetches MUST honor dynamicBackendUrl via resolveApiUrl or apiClient. Relative-URL bypass of the Electron backend resolution is forbidden.
Brand logo paths MUST have a fallback when assets are missing. Hardcoded asset paths with no fallback are forbidden.
## Failure + Resume

- `ErrorBoundary` per panel: sidebar/chat/roster fail independently with inline fallbacks; default (no-fallback) panel offers Retry via state reset and logs `componentStack` (`ErrorBoundary.tsx:20-41`). No boundary above `App` itself observed.
- API errors become `Error` with server message; artifact fetch uniquely swallows to `{ artifacts: [] }` (`src/api/client.ts:91-104,404-410`).
- Socket: infinite reconnect with backoff; offline/retry banners owned by the store layer; join timers cleanable via `cleanupSocketJoins` (no caller observed).
- Toast provider missing: `useToast` logs to console instead of throwing (`ToastProvider.tsx:108-118`).
- Storage helpers never throw (private-mode safe); quota errors evict the largest cursor mirror and retry once (`desktop-storage.ts:136-151`).
- Deep-link failures are swallowed by design ("must never break the shell", `deep-link.ts:144-146`).

## Gaps

- `VITE_API_URL` documented + typed but unread (dead config; separate-origin static hosting cannot work as documented).
- `setActivePin`/`currentPin` in `api/client.ts` have no observed callers — the client's own `x-pin` path is permanently empty; PIN works only through the `pin.ts` patch.
- `subscribeDesktopDeepLinks` has no observed caller — desktop deep-links are parsed but never subscribed in the files read (verify Electron shell wiring before claiming support).
- `cleanupSocketJoins` has no observed caller; pending join timers leak across unmounts.
- `refreshSocketPin()` is an empty stub despite being called on every unlock.
- `desktop-storage.ts` safe helpers have no observed importers; the store writes raw `localStorage` with no quota guard.
- No `ErrorBoundary` around the portal branch or the app root; a portal crash is unguarded.
- `resolveApiUrl` honors `dynamicBackendUrl`, but most store fetches use relative URLs directly and bypass it.
- `CrowdOSWordmark`/`CrowdOSFullLogo` hardcode `/horizontal_logo_*.png` paths with no fallback if assets are missing.
- `mapEmojiToCrowVariant` hashes unknown strings by char-code sum — deterministic but arbitrary (collisions across workspaces unhandled).
- The header-merge defect is fixed, but no test covers the three `HeadersInit` arms of `withPinHeaders` — a regression would be silent again.

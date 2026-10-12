# Notifications and deep links
> Type: Feature · Status: aligned · Updated: 2026-09-13

## Intent
Let run outcomes and approval prompts escape the renderer as native toasts, and route every toast click (plus OS-level `crowdos://` invocations) back into the right channel view via a deep link.

## Architectural decision
Two linked choices. First, toast gating is a pure normalized-set check (`completed`, `failed`, `cancelled`, `approval-requested`; trim + lowercase + underscore-folded) with no Electron import, so it unit-tests in plain Node `[Observed]` (`main/notifications.ts:1-6`, `main/notifications.ts:28-38`). Second, clicks never carry raw ids across the boundary — `buildNotificationAction` maps `channelId` to a `crowdos://` URL (`<ws>/<ch>` → `w` form, plain id → `c` form, empty → `crowdos://c/` home) and the handler forwards it as a `crowdos:deep-link` event after focusing the window `[Observed]` (`main/notifications.ts:40-58`, `main/ipc-handlers.ts:140-150`). The rejected alternative is visible: no toast-body parsing in main, no direct renderer navigation from the notification callback `[Inferred]`.

## How it works
1. A run status is tested with `shouldShowNativeNotification(status)` — normalize, set-check, done (`main/notifications.ts:35-38`).
7. Renderer-side (Phase D): the web `Notification` path in `crowdOsStore.ts` run-completion handling honors the structured `isChannelMuted` map (same localStorage source, never raw reads at call sites) with permission gating + background-only rule; clicks route to `applyDeepLink({ channelId, runId })` best-effort. Renderer deep links additionally parse run/inbox/view targets (`crowdos://run/<runId>`, `crowdos://inbox/<inboxId?>`, `crowdos://jobs`, `crowdos://telemetry`, `#run=/#inbox=/#view=`); `applyDeepLink` maps `inbox→jobs` view and loads run diffs via `fetchArtifacts`. No native notify bridge is used: `window.crowdos` exposes `invoke`/`on` + `pickDirectory` only — DND is the mute map, no invented DND store. Run-scoped links are now real on the renderer side (`deep-link.ts`, `crowdOsStore.ts`).
2. Renderer invokes `crowdos:notify:show` with `{ title, body?, channelId?, runId? }`; main zod-validates (title 1–200 chars, body ≤1000) (`main/ipc-handlers.ts:78-83`, `main/ipc-handlers.ts:185-192`).
3. Main builds the deep-link action from `channelId`, constructs the native `Notification`, and shows it (`main/notifications.ts:43-58`, `main/ipc-handlers.ts:193-207`).
4. On click, main focuses the window and sends `crowdos:deep-link { url }` best-effort — forwarding failures are swallowed, never fail the IPC call (`main/ipc-handlers.ts:197-205`, `main/ipc-handlers.ts:140-150`).
5. OS-level links arrive via `registerCrowdosProtocol`: `setAsDefaultProtocolClient('crowdos')` best-effort, `second-instance` argv scan plus macOS `open-url`, both funneled through `parseCrowdosUrl` validation into one `onDeepLink` callback (`main/app-shell.ts:74-115`, `main/app-shell.ts:121-157`).
6. `crowdos:windows:open-channel` builds the same URL shapes directly from `{ workspaceId?, channelId }` without a toast (`main/ipc-handlers.ts:219-223`).

## Components involved
| doc | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the surface: `main/notifications.ts` (pure gating + link builder), `main/ipc-handlers.ts` (`notify:show`, `windows:open-channel`, `focusAndDeepLink`), `main/app-shell.ts` (`crowdos://` registration + argv parsing) |
| Backend (embedded server) | Presumed producer of the run-status events toasts summarize — no sender found in this package (see gaps) |

## Current state
Real and wired: `notify:show` validates, builds the action, shows the toast, and forwards clicks as deep links; `windows:open-channel` reuses the same URL shapes; protocol registration plus argv/`open-url` parsing is wired with best-effort guards that never break boot.

## Alignment notes
`buildNotificationAction` shapes and the `windows:open-channel` URL shapes agree (`crowdos://w/<ws>/<ch>`, `crowdos://c/<ch>`) — no drift. Pointer note: `shouldShowNativeNotification` has no caller in `main/` (definition only, `main/notifications.ts:35`) — the `notify:show` handler shows unconditionally, so any gating lives outside main; recorded as a gap, not a drift.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Toast gating stays a pure normalized-set check of completed, failed, cancelled, approval-requested with trim plus lowercase plus underscore fold and no Electron import.
* Clicks never carry raw ids across the boundary. buildNotificationAction maps channelId to a crowdos:// URL and forwards it as a crowdos:deep-link event after focusing the window.
* shouldShowNativeNotification has a verified caller gating toasts before notify:show, or is removed as dead code. Unconditional show alongside an unused filter is forbidden.
* crowdos://c/ empty home link has an explicit main and renderer routing contract. Unrouted channel-less deep links are forbidden.
* runId has an explicit run-scoped target contract or is explicitly dropped by decision. Silent schema acceptance without effect is forbidden. Authority: Desktop Shell domain standard.
## Open gaps
- No caller of `shouldShowNativeNotification` found in `main/` — whether the renderer (or a future bridge) gates toasts before invoking `notify:show`, or the filter is currently dead code, is unverified.
- `crowdos://c/` (empty home link, `main/notifications.ts:57`) — how main/renderer routes a channel-less deep link is unverified.
- `runId` is accepted by the notify schema but never influences the deep link — whether run-scoped targets are planned or intentionally dropped is unverified.

# Toasts and error boundaries
> Type: Feature · Status: aligned · Updated: 2026-09-13
## Intent
App-wide transient feedback and per-panel crash isolation, so one failing panel never takes down the shell.
## Architectural decision
- [Observed] Toasts are infra-owned, feature-consumed: `ToastProvider` supplies context, features call it, nothing in the store.
- [Observed] Panels fail independently: sidebar, chat, and roster each sit in their own `ErrorBoundary` with inline fallbacks (`App.tsx:153-171`).
- [Observed] Missing provider degrades, never throws: `useToast` outside a provider logs to console (`ToastProvider.tsx:108-118`).
## How it works
1. Provider mounts around the shell; context exposes `toast`, `showSuccess`, `showError`, `showInfo` (`ToastProvider.tsx:14-23`).
2. Feature calls e.g. `showSuccess` after manifest commit or `showError` on inspect/save failure; toast auto-dismisses in 4 s and stacks from the bottom (`ToastProvider.tsx:41-43,108-118`).
  2. Feature calls e.g. `showSuccess` after manifest commit or `showError` on inspect/save failure; quiet toasts (success/info) auto-dismiss in 4 s as `role=status aria-live=polite`, errors render `role=alert` with a longer-but-FINITE 12 s auto-dismiss (2026-10-22 audit §2.9/§2.17 — a stale error can no longer occupy a third of the max-3 stack forever; dismissal + a11y policy lives in `toast-lifetimes.ts`, tested), and the stack caps at 3 (oldest drops) from the bottom (`ToastProvider.tsx`). History recording is reviewable-events-only (2026-10-22 audit §2.12/§2.14 minor #16): only assertive error toasts append to `notification-history-model`; quiet toasts stay live-stack-only so routine successes and connection churn no longer bump the bell. The header bell in `MainChatArea` opens `NotificationCenter` (DND-gated badge) whose rows route back via `applyDeepLink`.
3. On render crash, the nearest panel `ErrorBoundary` catches it and shows its inline fallback or the default rose panel with Retry state reset (`ErrorBoundary.tsx:20-41`).
4. Retry resets boundary state; `componentStack` is logged (`ErrorBoundary.tsx:20-41`).
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Client Infra.md> | Owns `ToastProvider`, `notification-history-model`, `NotificationCenter`, `ErrorBoundary`, and the per-panel shell wiring |
## Current state
Toast system and panel boundaries match the area doc: quiet 4 s auto-dismiss vs finite 12 s error auto-dismiss (audit §2.17), max-3 stack, console fallback, per-panel isolation with Retry. Toasts fade (motion opacity/y/scale 0.2s, never pulse) with `motion-reduce:transition-none`; the single-pulse rule holds elsewhere (channel mention dot `pulse-once` bounded, roster rows tick without pulse, only pending approval cards loop via `animate-pulse-slow`). Every toast/show call also appends to the persisted history journal (kind toast, errors assertive, cap 100), reviewed in `NotificationCenter` (loading skeleton, honest empty, error-with-cause-and-retry, newest-first real rows only). Rows deep-link via `applyDeepLink` (channel + run through `fetchArtifacts`, approvals through the inbox view); mark read per-row plus mark-all-read plus confirm-guarded clear; the DND schedule persists local-only and gates the header badge (hidden/frozen during DND with an explicit DND label) while history keeps recording. The header bell is a dedicated notification-center trigger; per-channel mute lives inside the center. No boundary above `App` itself or around the portal branch.
## Alignment notes
none found
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Toasts stay infra-owned and feature-consumed with 4s auto-dismiss, bottom stack, and console fallback outside a provider.
* Panels fail independently with per-panel ErrorBoundary plus inline fallback and Retry with state reset.
* Portal branch plus app root have an ErrorBoundary. Unguarded portal crash is forbidden.
* Toast list persistence and cross-mount contract are explicit. Silent per-mount loss ambiguity is forbidden. Authority: Client Infra area doc.
## Open gaps
- No `ErrorBoundary` around the portal branch or app root; a portal crash is unguarded.
- Toast list is per-`ToastProvider` mount with no persistence or cross-mount contract: the live stack is still per-mount (max 3) while the reviewable record is the persisted history journal (cap 100), so a remount loses only the transient stack, never the journal. Tray badge and OS-level quiet hours remain unbridged (renderer has no tray/notify channel beyond `invoke`/`on` + `pickDirectory`), recorded as honest gaps, never invented.

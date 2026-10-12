# Tray menu and updater
> Type: Feature · Status: aligned · Updated: 2026-09-27

## Intent
Give the shell a small OS tray entry point (recent workspaces, run drain, approvals, update check, quit), a conservative update policy that never strands a run mid-step, and a window that reopens where the user left it.

## Architectural decision
Three linked choices, all pure and testable. First, the tray is a plain-data `MenuItemConstructorOptions` template — type-only Electron import, no runtime; click targets travel as item `id`/`toolTip` channel strings that main wires later `[Observed]` (`main/tray-menu.ts:1-9`, `main/tray-menu.ts:22-25`, `main/tray-menu.ts:48-71`). Second, updates are policy-only in v1: `canAutoUpdate` blocks unpackaged builds and any in-flight runs with a drain message, and there is no `electron-updater` dependency `[Observed]` (`main/updater.ts:1-6`, `main/updater.ts:24-47`). Third, shell state is a merged `config.json` (`{ backendPort, windowBounds }`) with synchronous save on close and debounced save (default 300 ms; 500 ms for resize) `[Observed]` (`main/config-store.ts:4-10`, `main/config-store.ts:23-49`, `main/index.ts:355-377`).

## How it works
1. At boot, main builds the tray best-effort from `getTrayMenuTemplate(state)` via `Menu.buildFromTemplate` with recents from `config.json recentWorkspaceIds`; tray click restores + shows + focuses via `focusMainWindow` (fixes minimized/hidden background windows); every step is try/caught so tray never breaks boot. `refreshTray` rebuilds the menu whenever a workspace is opened (`onWorkspaceOpened` → cap-8 recents); Windows JumpList mirrors the top-5 recents as `crowdos://w/<id>` tasks.
2. Recent workspaces render as an `Open Recent` submenu carrying `crowdos:windows:open-channel:<id>` targets, or a disabled `(No recent workspaces)` placeholder; Pause/Cancel and Review Approvals enable only when their counts are positive (`main/tray-menu.ts:29-62`).
3. `crowdos:updater:check` returns the `canAutoUpdate` decision plus hardcoded `updateAvailable: false`; `crowdos:updater:install` refuses with a manual-installer message — no download/install path exists (`main/ipc-handlers.ts:254-263`, `main/updater.ts:30-47`).
4. Feed parsing (`parseUpdaterFeed`: `?channel=` first, then path segments, default `stable`, https-only, query/hash stripped) is implemented but has no caller in the IPC path (`main/updater.ts:59-81`).
5. Window bounds restore at creation from `stored.windowBounds`; resize persists debounced, close persists synchronously, both failure-silent (`main/index.ts:319-322`, `main/index.ts:355-377`, `main/config-store.ts:23-49`).

## Components involved
| doc | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the surface: `main/tray-menu.ts` (template), `main/updater.ts` (policy + feed parser), `main/config-store.ts` (`config.json` load/merge-save), `main/index.ts` (tray construction, bounds restore/persist) |

## Current state
Real and wired: template builds with live recents, policy gates, bounds restore + persist, updater stubs answer honestly (`updateAvailable: false`, manual-install message — manual-install Nightly v1 per user decision 2026-09-27). Feed parsing is implemented but unwired; run/approval counts still render idle (badge bump on notification shown, cleared on focus, covers the signal without fake counts) — honest gap, no live renderer→main counts path exists (`runningCount: 0`, `pendingApprovals: 0` at `main/index.ts:460`; `getRunningCount` is an injected dep hook for a future live feed, wired only into `updater:check` policy). Single global shortcut `CommandOrControl+Shift+O` toggles show/hide (unregistered on `will-quit`); spellcheck suggestions context menu; `render-process-gone` reload dialog; `crashReporter` (no upload) + `setAppUserModelId` for Windows toasts.

## Alignment notes
Drift: the tray is constructed once with zeroed state (`runningCount: 0`, `pendingApprovals: 0` at `main/index.ts:460`) with refresh via `trayRefreshHook` (`main/index.ts:477-478`) — so the count-aware labels (`main/tray-menu.ts:39-46`) and `enabled` gates (`main/tray-menu.ts:51-62`) always render the idle form at runtime. Pointer note: `parseUpdaterFeed` uncalled in the v1 IPC path is consistent with `publish: null` — surface, not behavior.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Tray stays a plain-data MenuItemConstructorOptions template with click targets as channel strings wired later in main.
* Updates stay policy-only in v1: canAutoUpdate blocks unpackaged builds and in-flight runs with a drain message, no electron-updater dependency.
* Shell state stays merged config.json with backendPort plus windowBounds, sync save on close and debounced save on resize.
* Tray refreshes on run and approval events via menu rebuild, or is explicitly labeled static idle template. Count-aware labels always rendering idle are forbidden.
* parseUpdaterFeed is wired to a feed flow or labeled future-anticipation and removed from v1 surface. Uncalled parsers alongside publish null are explicit.
* saveDesktopConfig merge versus delete plus corrupt-JSON fallback has an explicit stale-key and corrupt-config contract. Authority: Desktop Shell domain standard.
## Open gaps
- Whether a tray refresh (menu rebuild on run/approval events) is planned or the static template is the intended v1 end-state is unverified.
- Whether `parseUpdaterFeed` anticipates a future feed-based flow or is leftover anticipation is unverified.
- `saveDesktopConfig` merges without deleting keys and `loadDesktopConfig` falls back to `{}` on corrupt JSON (`main/config-store.ts:12-29`) — stale-key and corrupt-config semantics are as-read, unassessed here.

# Dialogs and windows
> Type: Feature · Status: aligned · Updated: 2026-09-13

## Intent
Own exactly one main window with a hardened baseline, native file dialogs behind validated IPC, single-instance ownership of the backend port, and a one-command dev loop that mirrors the packaged window.

## Architectural decision
Handles-in, no live Electron imports: `app-shell.ts` and `ipc-handlers.ts` take Electron capabilities as injected parameters, so the window factory, lock, protocol wiring, shutdown, dialogs, and IPC dispatch all unit-test in plain Node and `tsc` passes without the Electron binary `[Observed]` (`main/app-shell.ts:8-25`, `main/ipc-handlers.ts:18-20`). The window starts hidden on a dark background and reveals on `ready-to-show` with a 1500 ms fallback to avoid white-flash `[Observed]` (`main/app-shell.ts:37-40`, `main/index.ts:338-339`). Dialogs are the only filesystem touch the renderer gets, and every payload is zod-parsed with per-call `{ ok: false, error }` instead of throws `[Observed]` (`main/ipc-handlers.ts:68-76`, `main/ipc-handlers.ts:312-318`).

## How it works
1. Boot takes the single-instance lock first; losers quit immediately so only one backend owns the port (`main/app-shell.ts:62-69`).
2. Main resolves the preload bundle from `dist/preload/index.cjs|.js` candidates, builds options from the `DESKTOP_SECURITY` baseline (context isolation + sandbox on, node integration off), applies stored bounds, and creates the window hidden (`main/app-shell.ts:34-59`, `main/index.ts:311-322`).
3. The window shows on `ready-to-show` with a 1500 ms fallback, then loads vite in dev or the bundled renderer packaged (`main/index.ts:338-339`).
4. Renderer dialogs arrive as `crowdos:dialog:openDirectory|openFile|save`: `initialPath` maps to `defaultPath`, openDirectory forces the `Select Repository Root` title plus the `openDirectory` property, cancel normalizes to `{ canceled: true, path/filePath: null }` (`main/ipc-handlers.ts:158-184`).
5. Window routing stays URL-based: `windows:open-channel` builds a `crowdos://` URL and forwards it as `crowdos:deep-link`; `windows:open-diff` only focuses — the diff view is renderer-owned (`main/ipc-handlers.ts:219-253`).
6. Dev loop (`scripts/dev-electron.mjs`): builds server then desktop (`scripts/dev-electron.mjs:131-132`), reuses or starts vite on :22077 with `VITE_BACKEND_PORT/BACKEND_PORT=12077` (`scripts/dev-electron.mjs:162-186`), probes a free `--inspect` port 9229–9239 unless `ELECTRON_INSPECT=0` (`scripts/dev-electron.mjs:112-127`), launches Electron with `CROWDOS_DEV=1` from `packages/desktop` (`scripts/dev-electron.mjs:188-214`); SIGINT/SIGTERM kill tracked children (`scripts/dev-electron.mjs:66-76`).
7. Quit defers `before-quit` until the embedded backend stops, then quits; `window-all-closed` quits outright (`main/app-shell.ts:160-184`).

## Components involved
| doc | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the surface: `main/app-shell.ts` (factory, lock, shutdown), `main/ipc-handlers.ts` (dialog/window channels), `main/index.ts` (boot wiring), `scripts/dev-electron.mjs` (dev orchestration) |
| Backend (embedded server) | Stopped gracefully on quit; otherwise untouched by this feature |
| Client bundle | Renderer loaded into the window (vite in dev, bundled file packaged) |

## Current state
Real and wired: lock-first boot, hidden-until-ready window, all three dialog channels with cancel normalization, URL-based window routing, graceful shutdown, and a working dev launcher (build → vite → Electron with inspector probe and child cleanup).

## Alignment notes
none found

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Window lifecycle plus preload bridge plus bounds persistence stay with single-instance lock and graceful backend shutdown.
* Preload artifact order has an explicit contract matching what the release build emits. Unverified candidate order is forbidden.
* START_STANDALONE_API=1 versus embedded-only has an explicit developer rule for when to prefer standalone :12077.
* Quit while runs are in flight has an explicit drain-or-proceed contract matching the updater drain policy. Silent asymmetry is forbidden. Authority: Desktop Shell domain standard.
## Open gaps
- Preload candidate order (`index.cjs` before `index.js`, four candidates at `main/index.ts:311-317`) — which artifact the release build actually emits is unverified here.
- `START_STANDALONE_API=1` reuses/starts a standalone `:12077` API instead of embedded-only (`scripts/dev-electron.mjs:136-159`) — when a developer should prefer it is unverified.
- Quit while runs are in flight shows no drain prompt on the shutdown path (`main/app-shell.ts:160-184`) though the updater policy drains — whether that asymmetry is intentional is unverified.

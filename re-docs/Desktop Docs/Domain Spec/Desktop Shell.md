# Desktop Shell

## Purpose
Single-user local Electron shell for CrowdOS (Windows-first, Zero-Auth, loopback-only). It owns the main-process lifecycle — single-instance lock, embedded loopback backend, first-run DB migrate, BrowserWindow + preload bridge, tray, deep links, updater policy — and exposes nothing past an IPC allowlist plus the embedded HTTP API.

## Feature Scope
In-scope:
- App lifecycle: single-instance lock, `crowdos://` protocol, graceful backend shutdown (`main/app-shell.ts`, `main/index.ts`).
- Embedded backend: inline Fastify on 127.0.0.1 via dynamic `buildServer` import (`utility/embedded-backend.ts`).
- First-run migrate: forked server `db/bootstrap.js` with timeout (`main/ensure-database.ts`).
- IPC surface: zod allowlist + `window.crowdos` preload bridge + main handlers (`ipc-contracts.ts`, `preload/`, `main/ipc-handlers.ts`).
- Hardening: window baseline/CSP, navigation/permission/external-open guards (`security-policy.ts`, `main/navigation-guard.ts`).
- Shell state: `<userData>` paths, `config.json`, tray template, notifications, updater policy (`paths.ts`, `main/config-store.ts`, `main/tray-menu.ts`, `main/notifications.ts`, `main/updater.ts`).
Non-goals (other owners):
- API/routes, queue delivery, run execution, approvals, filesystem I/O → embedded server (`@community-agent/server`), reached over HTTP/socket, never re-implemented behind IPC.
- Renderer UI → client bundle (`client/dist`), loaded via vite in dev or `app://` in packaged builds.
- Postgres itself → external Postgres 16 on 127.0.0.1; this domain only migrates then connects.

## Expect
- Gate-only imports: nothing outside `packages/desktop/` imports past `desktopGate.ts`. `[Observed]` (`desktopGate.ts:60-63`)
- Loopback-only: renderer `connect-src` is `http://127.0.0.1:*` + `ws://127.0.0.1:*`; backend binds `127.0.0.1`; navigation allows only `app:` / bundled `file:` / loopback ports. `[Observed]` (`security-policy.ts:10-11`, `utility/embedded-backend.ts:91`, `main/navigation-guard.ts:23-61`)
- No raw Node in renderer: preload exposes only `window.crowdos` (`invoke`/`on` over allowlist + `pickDirectory`); no fs/shell/require. `[Observed]` (`preload/bridge.ts:34-35`, `preload/index.ts:1-8`)
- Data plane stays on HTTP/socket in v1: `fs:*` / `runs:*` / `approvals:*` IPC calls return a REST-fallback envelope, never backend results. `[Observed]` (`main/ipc-handlers.ts:12-16`, `main/ipc-handlers.ts:97-101`)
- Cwd-independent: path resolution injects `app.getPath("userData")`; `process.cwd()` is never a root. `[Observed]` (`paths.ts:3-10`)

## Flow
1. Entry: `app.whenReady → boot()`; single-instance lock first, second launch quits (`main/index.ts:672-674`, `main/app-shell.ts:62-69`).
2. Roots: `getDesktopPaths(userData)` → `dataRoot`; `mkdir` workspaces + logs; `loadDesktopConfig(config.json)` (`main/index.ts:153-156`).
3. Env: `DATABASE_URL` from env, else parsed from `.env` candidates (repo root, desktop, dataRoot), else `DEFAULT_DATABASE_URL`; then `QUEUE_MODE=inline`, `DESKTOP_MODE=1`, `WORKSPACE_DIR=<workspacesDir>` defaults (`main/index.ts:185-224`).
4. Migrate: `ensureDatabase({ databaseUrl, bootstrapCandidates })`; `failed` shows error box and continues (`main/index.ts:227-233`).
5. Backend: preferred port dev `12077` else stored (never `3001`) → `pickFreePort` probes +10 → `startEmbeddedBackend({ port, databaseUrl })` → persist `backendPort` (`main/index.ts:236-241`); start failure shows error box and quits (`main/index.ts:240-253`).
6. IPC: `registerIpcHandlers` with live `ipcMain/dialog/shell/Notification`, backend + window getters, `<logs>/desktop.log`, `isPackaged` (`main/index.ts:272-309`).
7. Window: resolve preload `dist/preload/index.cjs|.js` candidates → `buildMainWindowOptions` + stored bounds → `ready-to-show` + 1500 ms fallback show; resize (500 ms debounce) / close persist bounds (`main/index.ts:311-377`).
8. Hardening: `will-navigate` → `isAllowedNavigation` (backendPort, devServerPort `22077`, `DEV_RENDERER_URL`); `setWindowOpenHandler` denies popup + `isAllowedExternal` → `shell.openExternal`; permission handler grants `notifications` only; CSP header injected when packaged (`main/index.ts:384-427`).
9. Protocol/tray: `registerCrowdosProtocol` forwards deep links as `crowdos:deep-link`; `second-instance` refocuses; tray built best-effort with zeroed counts (`main/index.ts:432-460`).
10. Load: dev → `loadURL(DEV_RENDERER_URL)` + detached DevTools unless `CROWDOS_DEVTOOLS=0`; packaged → first existing `rendererCandidates` → `protocol.handle("app")` serve from `client/dist` with path-escape 403 + SPA fallback, else `loadFile` fallback; missing renderer errors and quits (`main/index.ts:612-664`).
11. Quit: `before-quit` preventDefault → `backend.stop()` → `quit()`; `window-all-closed` → `quit()` (`main/app-shell.ts:160-184`, `main/index.ts:667-669`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `desktopGate.ts` | ONLY public entry: re-exports types/constants + `desktopGate` ports; no logic |
| `ipc-contracts.ts` | Zod allowlist: 21 invoke + 3 event channels; `IPC_ALLOWLIST` single source of truth |
| `security-policy.ts` | Pure window baseline + loopback `allowedConnectSrc` + CSP string; no Electron import |
| `paths.ts` | Pure injected-root resolution (`dataRoot`, workspaces, logs, config); renderer candidates; never `process.cwd()` |
| `main/index.ts` | Real main entry: boot sequence above; only file importing live `electron` values |
| `main/app-shell.ts` | Window options/factory, single-instance lock, `crowdos://` parse/wiring, graceful shutdown; handle-injected, no live Electron import |
| `main/ipc-handlers.ts` | Allowlist-enforced invoke wiring (config/dialogs/notify/windows/updater/logs + REST fallbacks); handle-injected, zod-validated, sender-checked |
| `main/ensure-database.ts` | Forked one-shot migrate with timeout; `migrated / skipped / failed` envelope |
| `main/config-store.ts` | `config.json` load/merge-save + debounced save; `{ backendPort, windowBounds }` |
| `main/navigation-guard.ts` | Pure `isAllowedNavigation` / `isAllowedExternal` / `getPermissionDecision`; no Electron import |
| `main/notifications.ts` | Pure toast gating (`NATIVE_STATUSES`) + `buildNotificationAction` deep-link mapping |
| `main/tray-menu.ts` | Pure `MenuItemConstructorOptions` template builder; no Electron runtime import |
| `main/updater.ts` | Pure update policy (`canAutoUpdate`) + https-only feed parser (`parseUpdaterFeed`) |
| `preload/bridge.ts` | `window.crowdos` factory (`invoke`/`on` allowlist + `pickDirectory`); handle-injected, no live Electron import |
| `preload/index.ts` | Preload entry: exposes bridge with live `contextBridge`/`ipcRenderer` |
| `utility/embedded-backend.ts` | Dynamic-import `buildServer` resolver + `127.0.0.1`/`inline` start/stop handle |
| `scripts/dev-electron.mjs` | Dev launcher: builds server+desktop, reuses/starts vite :22077, launches Electron with `CROWDOS_DEV=1` + inspector probe |
| `electron-builder.yml` | Packaging: `com.crowdos.app`, NSIS x64 unsigned, bundles `dist` + `client/dist` + `server/dist`, `publish: null` |
| `package.json` | Scripts (`build`, `build:preload` esbuild CJS, `dev`, `dev:electron`, `dist`); deps `zod` + optional-peer `electron` |

## Ports
Types (re-exported):
- `IpcChannel` — union of invoke + event channels (`ipc-contracts.ts:45`).
- `IpcInvokeChannel` — renderer→main request/response channels (`ipc-contracts.ts:43`).
- `IpcEventChannel` — main→renderer one-way channels (`ipc-contracts.ts:44`).
- `DesktopSecurityPolicy` — `typeof DESKTOP_SECURITY` (`security-policy.ts:14`).
- `DesktopPaths` — `{ dataRoot, workspaceRoot, workspacesDir, logsDir, configFile }` (`paths.ts:73-82`).
- `CrowdosDeepLink` — `` crowdos://c/${string} | crowdos://w/${string}/${string} `` (`main/notifications.ts:18-20`).
- `DesktopNotification` — `{ title, body, channelId?, runId? }` (`main/notifications.ts:8-13`).
- `NotificationAction` — `{ deepLink }` (`main/notifications.ts:22-24`).
- `TrayMenuState` — `{ recentWorkspaces, runningCount, pendingApprovals }` (`main/tray-menu.ts:16-20`).
- `TrayRecentWorkspace` — `{ id, name }` (`main/tray-menu.ts:11-14`).
- `UpdateChannel` — `stable | beta` (`main/updater.ts:10`).
- `UpdaterFeed` — `{ channel, baseUrl, raw }` (`main/updater.ts:49-53`).
- `UpdaterState` — `{ isPackaged, runningCount, channel?, currentVersion? }` (`main/updater.ts:12-17`).
- `AutoUpdateDecision` — `{ ok, reason? }` (`main/updater.ts:19-22`).
- `DesktopPermission` — `camera | microphone | geolocation | notifications` (`main/navigation-guard.ts:87-91`).
- `NavigationGuardOptions` — `{ backendPort, devServerPort?, devServerUrl?, allowedRendererPaths? }` (`main/navigation-guard.ts:12-17`).
- `DesktopGate` — `typeof desktopGate` (`desktopGate.ts:74`).
Constants (re-exported):
- `IPC_ALLOWLIST` — readonly invoke + event channel list (`ipc-contracts.ts:50-53`).
- `DESKTOP_SECURITY` — window baseline + `allowedConnectSrc` + `csp` (`security-policy.ts:5-12`).
- `EXTERNAL_HTTPS_ALLOWLIST` — `[]` (empty = allow safe non-loopback http/https) (`main/navigation-guard.ts:65`).
- `UPDATE_CHANNELS` — `["stable", "beta"]` (`main/updater.ts:8`).
Gate object:
- `desktopGate.getIpcContracts` — `getIpcAllowlist` passthrough (`desktopGate.ts:65`).
- `desktopGate.getSecurityPolicy` — `getDesktopSecurity` passthrough (`desktopGate.ts:66`).
- `desktopGate.getPaths` — `getDesktopPaths(appUserDataPath)` passthrough (`desktopGate.ts:67`).
- `desktopGate.getTrayMenu` — `getTrayMenuTemplate(state)` passthrough (`desktopGate.ts:68`).
- `desktopGate.canAutoUpdate` — updater policy passthrough (`desktopGate.ts:69`).
- `desktopGate.isAllowedNavigation` — navigation guard passthrough (`desktopGate.ts:70`).
- `desktopGate.buildNotificationAction` — deep-link builder passthrough (`desktopGate.ts:71`).

## Relations
Gates this domain calls:
- None. No gate-to-gate import observed; server is reached via dynamic `buildServer()` import, never a gate (`utility/embedded-backend.ts:67-81`).
Non-gate dependencies used:
- `@community-agent/server/dist/create-app.js` `buildServer({ host: "127.0.0.1", port, queueMode: "inline" })` + `start()/stop()` (`utility/embedded-backend.ts:91-99`).
- Server `dist/db/bootstrap.js` forked one-shot for migrate (`main/ensure-database.ts:59-62`, `main/index.ts:121-138`).
- Client bundle `client/dist/index.html` loaded via vite/`app://`/`loadFile` (`main/index.ts:612-664`); `paths.ts:39-59` candidates.
- Postgres 16 on 127.0.0.1 via `DATABASE_URL` (external process; only migrated + connected).
Known outside callers of `desktopGate`:
- None observed. The shell is top-level (`main/index.ts` boot); renderer uses `window.crowdos`, not the gate. Gate exists as the facade contract for future/test consumers.

## Emits-Listens
- `crowdos:run-status` (emits, main→renderer event)
- `crowdos:approval-requested` (emits, main→renderer event)
- `crowdos:deep-link` (emits, main→renderer event; from protocol, notification click, `windows:open-channel`)
- No event-broker subscribes; no socket emits owned here — data plane is the embedded server's.

## Owns
- `<userData>/` dataRoot + `workspaces/` dir + `logs/` dir + `config.json` (`{ backendPort, windowBounds }`) + `logs/desktop.log` (no DB tables owned). 2026-09-23: the file log is real now - `main/desktop-log.ts` tees main-process `console.warn`/`console.error` (boot, embedded backend, updater failures) into append-only `logs/desktop.log` from boot onward, and `crowdos:log:write` IPC remains the renderer appender; without this the packaged build had no persistent log at all.
- BrowserWindow lifecycle, preload bridge, single-instance lock, `crowdos://` registration, tray template, permission/navigation/external-open decisions, updater policy, embedded-backend start/stop handle.

## Flags
- `CROWDOS_DEV` — `1` loads vite renderer, skips packaged CSP, relaxes IPC sender check when no `senderFrame.url` (`main/index.ts:144`, `main/index.ts:423-425`, `main/ipc-handlers.ts:131`).
- `DATABASE_URL` — Postgres connection string; read (never assigned by backend module), `.env` fallback, else default local URL (`main/index.ts:185-218`, `utility/embedded-backend.ts:41-44`).
- `QUEUE_MODE` — forced `inline` by the shell (`main/index.ts:220`).
- `DESKTOP_MODE` — forced `1` by the shell (`main/index.ts:221`).
- `WORKSPACE_DIR` — defaulted to `<dataRoot>/workspaces` when empty (`main/index.ts:222-224`).
- `VITE_URL` — dev renderer URL, default `http://127.0.0.1:22077` (`main/index.ts:51`, `scripts/dev-electron.mjs:53`).
- `CROWDOS_DEVTOOLS` — `0` disables renderer DevTools auto-open (`main/index.ts:615-617`).
- `ELECTRON_INSPECT` — dev inspector port probe base, `0` disables (`scripts/dev-electron.mjs:54,112-127`).
- `START_STANDALONE_API` — `1` reuses/starts a standalone `:12077` API instead of embedded-only (`scripts/dev-electron.mjs:136-159`).
- `ELECTRON_RUN_AS_NODE` — set `1` on the migrate child so fork runs as plain Node (`main/ensure-database.ts:60`).

## Decisions
- [Observed] Gate is wire-only: every port is a direct re-export/passthrough with zero branching (`desktopGate.ts:64-72`) — why: keeps the facade a stable contract while internals stay replaceable.
- [Observed] IPC channels are zod enums as single source of truth, with derived readonly arrays (`ipc-contracts.ts:5-53`) — why: renderer, bridge, and main validate against the same list; no drift.
- [Observed] Data-plane channels return 501-style REST pointers instead of backend results (`main/ipc-handlers.ts:97-101`) — why: avoids duplicating the HTTP/socket backend behind IPC in v1.
- [Observed] Security/policy modules import no Electron values (`security-policy.ts:1-3`, `main/navigation-guard.ts:1-6`, `main/notifications.ts:1-6`, `main/ipc-handlers.ts:18-20`, `preload/bridge.ts:11-13`) — why: unit-testable in plain Node and `tsc` passes without the Electron binary.
- [Observed] Server factory resolved by path-agnostic dynamic import with file-exists + package-specifier candidates (`utility/embedded-backend.ts:46-65`) — why: packaged builds may not ship server source at the dev path; static cross-workspace imports would break the bundle.
- [Observed] Migrate is forked, never imported, because `db/bootstrap.ts` auto-runs `main()` on import (`main/ensure-database.ts:4-12`) — why: importing would execute migrations in-process as a side effect.
- [Observed] `resolveWorkspaceRoot` and `resolveWorkspacesDir` both return `<dataRoot>/workspaces` (`paths.ts:18-30`) — why: plural alias kept alongside singular; behavior is identical today.
- [Observed] Update checks always report `updateAvailable: false` and install refuses with a manual-installer message (`main/ipc-handlers.ts:254-263`) — why: v1 ships `publish: null` with no auto-install wiring; updates are manual N/N+1 installers.
- [Observed] Permissions default-deny except notification toasts (`main/navigation-guard.ts:93-99`, `main/index.ts:418-420`) — why: least privilege for camera/mic/geolocation.
- [Inferred] `file:` navigation is allowlisted to known renderer paths instead of blanket-allowed (`main/navigation-guard.ts:36-47`) — why: a permissive `file:` rule would let any local file become top-level content.
- [Inferred] Empty `EXTERNAL_HTTPS_ALLOWLIST` means "allow safe external" rather than "deny all" (`main/navigation-guard.ts:63-85`) — why: v1 has no curated host list, so the guard falls back to protocol + loopback-exclusion checks.
- [Inferred] Packaged renderer served over `app://` with traversal check + SPA fallback (`main/index.ts:643-660`) — why: `file://` + fetch/CORS is brittle for bundled SPAs; the privileged scheme keeps asset loading same-origin-like.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Wire-only gate plus zod allowlist plus loopback-only plus forked migrate stay; gate coverage, tray refresh, event senders, and doc maps are the gaps.
Gate stays wire-only with zero branching. Logic inside the facade is forbidden.
IPC channels stay zod enums as single source of truth across renderer, bridge, and main. Raw channel strings are forbidden.
Data-plane channels stay 501-style REST pointers in v1. Backend re-implementation behind IPC is forbidden.
Security and policy modules stay Electron-import-free for plain-Node tests. Live Electron values inside pure policy modules are forbidden.
Server factory stays path-agnostic dynamic import. Static cross-workspace imports that break packaged bundles are forbidden.
Migrate stays forked, never imported, because bootstrap auto-runs main on import.
Gate coverage MUST be explicit: every importable internal is either a gate port or labeled internal. Silent partial coverage is forbidden.
cursors.json MUST have a reader and writer or be removed with the later-phase migration note resolved. Declared-but-unwired store files are forbidden.
resolveWorkspaceRoot versus resolveWorkspacesDir MUST have one canonical caller path with the other labeled alias or legacy. Silent duplication is forbidden.
Tray MUST refresh on run and approval events or be labeled static idle template. Count-aware labels that always render idle are forbidden.
crowdos:run-status plus crowdos:approval-requested MUST have a verified sender or be labeled future-unwired. Sender-less event contracts are forbidden.
backendPort 3001 remap MUST be documented with its reason. Silent port remaps are forbidden.
Packaged CSP MUST have dev parity coverage or an explicit dev-skips-CSP contract with a pre-release CSP test. Silent untested packaged headers are forbidden.
desktop.zip at package root MUST be removed or documented with its release relationship. Unidentified top-level artifacts are forbidden.
Desktop Docs MUST have _index.md plus _flow-index.md maps synced with code and doc changes like all other roots.
## Failure + Resume
- Single-instance: second launch quits without side effects (`main/app-shell.ts:62-69`).
- Migrate: empty `DATABASE_URL` → `skipped`; no bootstrap bundle → `skipped` (manual `db:push` hint); fork/timeout/exit-nonzero → `failed` with stderr tail (last 500 chars); timeout kills child (default 120 s, `unref`); boot logs a warn and continues offline (no blocking dialog), backend routes 500 until Postgres is up (`main/ensure-database.ts:27-97`, `main/index.ts:227-233`).
- Backend start failure → error box + `app.quit()`; no window is created (`main/index.ts:240-253`).
- Missing packaged renderer → error box + quit (`main/index.ts:631-638`).
- IPC: untrusted sender throws; zod parse failures return `{ ok: false, error }` per call, never throw out of the handler (`main/ipc-handlers.ts:312-318`); window-forwarding failures are best-effort swallowed (`main/ipc-handlers.ts:140-150`).
- Protocol registration, bounds persistence, tray setup, DevTools open: all best-effort try/catch, never break boot (`main/app-shell.ts:78-84`, `main/index.ts:355-377`, `main/index.ts:432-460`).
- Shutdown: `before-quit` defers quit until `backend.stop()` settles (errors logged, quit proceeds) (`main/app-shell.ts:160-184`).
- No run-state recovery owned here: crash-mid-run resume belongs to the server orphan sweep; the shell only restarts backend + migrates on relaunch (README kill-mid-run drill).

## Gaps
- Gate coverage is partial: `isAllowedExternal`, `getPermissionDecision`, `parseUpdaterFeed`, `shouldShowNativeNotification`, `getTrayMenuTemplate` inputs beyond `getTrayMenu`, path resolvers, config-store, `ensureDatabase`, `startEmbeddedBackend`, `registerIpcHandlers`, bridge factories are importable internals but not gate ports — intended public surface vs omission is unverified.
- `DESKTOP_STORE_FILES.cursors` (`cursors.json`) is declared (`paths.ts:61-64`) but no reader/writer was found in this package; `config-store.ts` notes seq cursors "migrate in a later phase" — status unverified.
- `resolveWorkspaceRoot` vs `resolveWorkspacesDir` duplication: whether callers should prefer one, and whether the singular form is legacy, is unverified.
- Tray is constructed with zeroed `recentWorkspaces/runningCount/pendingApprovals` (`main/index.ts:458-461`) with refresh via `trayRefreshHook` (`main/index.ts:450-466`, `main/index.ts:477-478`); `runningCount`/`pendingApprovals` never update at runtime.
- `crowdos:run-status` / `crowdos:approval-requested` emits have no sender found in this package — presumably the embedded server or a future bridge forwards them; wiring unverified.
- Stored `backendPort === 3001` is silently remapped to `12077` (`main/index.ts:237`) — reason (legacy web-dev collision?) unverified.
- Packaged CSP is skipped in dev (`main/index.ts:423-425`); whether dev ever enforces CSP or tests the packaged header is unverified.
- `desktop.zip` at package root: purpose (fixture? stale artifact?) unverified.
- No `re-docs` map entries (`_index.md` / `_flow-index.md`) exist for Desktop Docs yet — code↔doc sync for this domain's maps is open.

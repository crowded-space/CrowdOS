# IPC bridge and contracts
> Type: Feature · Status: aligned · Updated: 2026-09-27

## Intent
Give the renderer exactly one narrow, typed pipe into the main process — `window.crowdos` — so UI code can open dialogs, notify, and query shell state without ever touching fs, shell, or Node, while every channel crossing the boundary is validated against a single shared allowlist.

## Architectural decision
The shape is three linked choices. First, the channel list is a zod enum triple (invoke / event / union) and every derived array is read off the schemas, so contracts, bridge, and handlers cannot drift `[Observed]` (`ipc-contracts.ts:5-53`). Second, the preload bridge allowlists both directions — `invoke` throws on non-invoke channels, `on` throws on non-event channels, and only `crowdos` is exposed (`preload/bridge.ts:72-77`, `preload/bridge.ts:108-123`, `preload/bridge.ts:126-133`). Third, the main side registers every invoke channel but only implements the shell plane (config/dialogs/notify/windows/updater/logs); the data plane (`fs:*`, `runs:*`, `approvals:*`) answers with a REST-fallback envelope pointing at the embedded HTTP API + socket.io instead of duplicating the backend `[Observed]` (`main/ipc-handlers.ts:10-16`, `main/ipc-handlers.ts:285-309`). The rejected alternative is visible: no generic `ipcRenderer` passthrough, no raw channel strings, no backend re-implementation behind IPC `[Inferred]`.

## How it works
Renderer calls `window.crowdos.invoke(channel, payload)` or subscribes via `window.crowdos.on(channel, listener)`; `pickDirectory(opts)` wraps `crowdos:dialog:openDirectory` with `select-repository` semantics (`{ canceled, path }`, tolerant of string / `{ path }` / `{ filePaths }` shapes). Main's `registerIpcHandlers` wires all 23 invoke channels through one `handle` loop: sender check (`file:`/`app:`/loopback, or `CROWDOS_DEV=1` when no sender URL), zod payload parse, then the per-channel action. Dialogs map `initialPath` → `defaultPath`; notify builds a deep-link action and shows a native toast whose click forwards `crowdos:deep-link` (plus an `onNotificationShown` hook that bumps the taskbar/dock badge and flashes the frame, cleared on window focus); `windows:open-channel` builds `crowdos://w/<ws>/<ch>` or `crowdos://c/<ch>`, records the workspace in `config.json recentWorkspaceIds` (cap 8) via `onWorkspaceOpened`, and forwards it; `config:get` returns `{ port, backendBaseUrl }`; `updater:check` returns the drain decision + `updateAvailable: false`; `updater:install` refuses with a manual-installer message (manual-install Nightly v1, user decision 2026-09-27); `log:write` appends a timestamped line to `desktop.log`; `autostart:get/set` read/write OS launch-on-login via `app.getLoginItemSettings/setLoginItemSettings` (renderer helper `src/config/autostart.ts`, toggle in Workspace Settings → Screen Lock). Event channels (`run-status`, `approval-requested`, `deep-link`) flow main→renderer via `webContents.send` and are never invokable.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the whole surface: `ipc-contracts.ts` (allowlist), `preload/bridge.ts` + `preload/index.ts` (renderer pipe), `main/ipc-handlers.ts` (main wiring) |
| Backend (embedded server) | Owns the data plane the REST-fallback envelope points at (filesystem / runs / approvals over HTTP + socket.io) |

## Current state
Real and wired: 23 invoke + 3 event channels, bridge allowlist both directions, sender check, zod validation per payload, all shell-plane actions, REST-fallback stubs for the data plane, and the `app://`/loopback deep-link forwarding path all run today. `pickDirectory` parity (`Select Repository Root` title, `initialPath` mapping) is implemented on both sides of the boundary. Renderer subscribes to `crowdos:deep-link` at boot (`main.tsx` → `subscribeDesktopDeepLinks`) and tees console.warn/error + unhandled rejections into `desktop.log` (`src/config/desktop-log.ts`).

## Alignment notes
Cross-checked `ipc-contracts.ts` (21 invoke enumerated at lines 5-27, 3 events at 30-34) against `registerIpcHandlers` channel list (`main/ipc-handlers.ts:285-309`, identical 21) and the bridge sets (`preload/bridge.ts:70-71`, derived from the same schemas) — no drift. `handleInvoke` switch implements the shell plane and funnels the rest into `REST_FALLBACK_BY_PREFIX` (`main/ipc-handlers.ts:97-101`); `updater:check` / `updater:install` behavior matches the updater policy doc. One pointer note: `isIpcChannel`/`parseIpcChannel`/`getIpcInvokeChannels`/`getIpcEventChannels` exist but are not gate ports — surface, not behavior.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Renderer calls window.crowdos.invoke and on over the zod allowlist with pickDirectory wrapping openDirectory. Main wires all invoke channels through one handle loop with sender check plus zod parse plus per-channel action.
* Data-plane channels return 501-style REST pointers, never backend results. Generic ipcRenderer passthrough plus raw channel strings are forbidden.
* crowdos:run-status plus crowdos:approval-requested have a verified sender or are labeled future-unwired. Sender-less event contracts are forbidden.
* Data-plane channel registration versus omission is an explicit intentional-surface decision, never leftover.
* pickDirectory bare-string tolerance is labeled legacy or defensive-only. Sender check against compromised renderer is explicitly assessed. Authority: Desktop Shell domain standard.
## Open gaps
- No sender found in this package for `crowdos:run-status` / `crowdos:approval-requested` — who emits them (embedded server forward vs unwired future) is unverified.
- `handleInvoke` has no case for data-plane channels by design, but the `registerIpcHandlers` list still registers them — whether registration (vs omit) is intentional surface or leftover is unverified.
- `pickDirectory` tolerates a bare-string result (`preload/bridge.ts:88-90`) that main never returns today — legacy shape or defensive-only is unverified.
- Sender check trusts any `file:`/`app:`/loopback URL plus dev-mode no-URL senders — whether that is sufficient against a compromised renderer process is unassessed here.

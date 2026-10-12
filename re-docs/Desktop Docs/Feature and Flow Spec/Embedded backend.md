# Embedded backend
> Type: Feature · Status: aligned · Updated: 2026-09-13

## Intent
Run the full CrowdOS API + worker inside the desktop process with zero extra infrastructure — no Redis, no separate server process, no LAN exposure — so the packaged app is a double-clickable single-user shell whose renderer talks to `http://127.0.0.1:<port>` like any client.

## Architectural decision
The shape is two linked choices. First, the backend is hosted inline (`QUEUE_MODE=inline`, bind `127.0.0.1`) through the server's side-effect-free `buildServer()` factory, with `start()`/`stop()` owned by a small `{ port, stop }` handle `[Observed]` (`utility/embedded-backend.ts:90-99`). Second, the factory is resolved by path-agnostic dynamic import (dev `dist` paths, `resourcesPath` packaged path, then package-specifier fallbacks) and a missing factory is a loud error with per-candidate reasons, not a silent no-op `[Observed]` (`utility/embedded-backend.ts:46-88`). The module never assigns `process.env.DATABASE_URL` — the shell sets it before calling `[Observed]` (`utility/embedded-backend.ts:41-44`, `main/index.ts:185-218`). The rejected alternatives are visible: no static cross-workspace TS import (would break packaged builds), no LAN bind, no queue worker process `[Inferred]`.

## How it works
At boot, main picks a port (dev `12077`, else stored unless `3001`, probing +10 for a free one) and calls `startEmbeddedBackend({ port, databaseUrl })`, which validates the inputs, finds the first `create-app` bundle exporting `buildServer`, builds with `{ host: "127.0.0.1", port, queueMode: "inline" }`, starts it, and returns the actual port plus a `stop()` closing the server. `backendBaseUrl` is derived as `http://127.0.0.1:<port>`, persisted to `config.json`, and handed to IPC (`crowdos:config:get`) and the navigation guard. In dev, `scripts/dev-electron.mjs` compiles server + desktop first, then either embeds (default) or — with `START_STANDALONE_API=1` — reuses/starts a standalone `:12077` API; the renderer (vite `:22077`) gets `VITE_BACKEND_PORT`/`BACKEND_PORT=12077`. On quit, `before-quit` awaits `backend.stop()` before exiting.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns lifecycle: port pick, `startEmbeddedBackend`, env setup, `backend.stop()` on shutdown (`main/index.ts`, `utility/embedded-backend.ts`, `scripts/dev-electron.mjs`) |
| Backend (server `create-app.ts`) | Owns `buildServer`/`start`/`stop`, routes, queue-inline worker, DB access |

## Current state
Real in both dev and packaged paths: inline Fastify on loopback, dynamic resolution with logged candidate failures, actual-port return, graceful stop, and the dev script's build → vite → Electron orchestration (inspector probe, `CROWDOS_DEV=1`, child tracking/kill) all run today. Standalone-API dev escape hatch (`START_STANDALONE_API=1`) is implemented.

## Alignment notes
Cross-checked `utility/embedded-backend.ts:34-104` against the boot call site (`main/index.ts:236-241`, `main/index.ts:667-669`) and the dev script (`scripts/dev-electron.mjs:129-231`): env ownership (shell sets, module never assigns), inline/loopback args, handle shape, and shutdown wiring all match. `README.md:30-56` runbook (ports, env, inspector, standalone hatch) matches code. No drift found.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Embedded backend stays inline Fastify on 127.0.0.1 via dynamic buildServer import with env owned by the shell, never assigned by the backend module.
* Unavailable errors surface all candidate failures, never the first 3 only. Deeper causes are never dropped.
* pickFreePort bind failure when all 10 probes fail has an explicit contract, never silent fallback to the preferred port.
* Stored-port remap plus standalone probe path are documented with reasons. Packaged resourcesPath versus getAppPath order is verified in a real packaged layout. Authority: Desktop Shell domain standard.
## Open gaps
- Only the first 3 candidate failures are surfaced in the unavailable error — deeper candidates are dropped; whether that ever hides the real cause is unverified.
- `pickFreePort` falls back to the preferred port even when all 10 probes fail — bind-failure behavior in that corner is unverified.
- The stored-port `!== 3001` remap and the `START_STANDALONE_API` probe path (`/api/observability/stats`) were read but not live-tested here.
- Packaged `resourcesPath` resolution order vs `getAppPath` order is code-read only; real packaged-layout verification is unverified.

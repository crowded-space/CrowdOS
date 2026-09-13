# @crowdspace/desktop

Electron desktop shell for CrowdOS (Windows-first, zero-auth, loopback-only).

- **Zero-Auth, Windows-first**: single-user local shell, no hosted auth. The
  embedded backend trusts the local user; all access stays on-device.
- **`QUEUE_MODE=inline`**: the API and worker run in-process (no Redis) via
  the embedded backend stub (`utility/embedded-backend.ts`).
- **Loopback-only**: renderer ↔ backend traffic is restricted to
  `http://127.0.0.1:*` / `ws://127.0.0.1:*` (see `security-policy.ts` CSP +
  `allowedConnectSrc`). No LAN/WAN listeners.

## Layout (Domain Facade Standard)

- `desktopGate.ts` — ONLY public entry point (`getIpcContracts`,
  `getSecurityPolicy`, `getPaths`). Never import past it.
- `ipc-contracts.ts` — zod-validated IPC allowlist (pure types, no Electron).
- `security-policy.ts` — BrowserWindow baseline + CSP.
- `paths.ts` — injected-root path resolution (never `process.cwd()`).
- `main/app-shell.ts` — single-instance lock, window factory, protocol stub.
- `main/index.ts` — real main entry (backend lifecycle, IPC, hardening).
- `main/ipc-handlers.ts` — allowlist-enforced invoke handlers (dialogs, config,
  notify, windows, updater, logs; vfs/runs/approvals stay on REST/socket).
- `main/config-store.ts` — `<userData>/config.json` (backend port, bounds).
- `main/ensure-database.ts` — first-run migrate (forks server `db/bootstrap`).
- `preload/bridge.ts` — whitelisted `window.crowdos` bridge only.
- `preload/index.ts` — preload entry (exposes the bridge).
- `utility/embedded-backend.ts` — inline Fastify host stub (Phase P1).

## Release runbook (Windows x64, NSIS, unsigned OSS v1)

Prereqs: Postgres 16 on `127.0.0.1:5432` (`community_agent`, postgres/postgres
per docker-compose, or set `DATABASE_URL`), `npm install` (pulls the Electron
binary + electron-builder), client+server built (`npm run build`).

- Dev/debug shell (one command): `npm run dev:electron` from the repo root
  (or `npm run dev --workspace @crowdspace/desktop`). It compiles
   main/preload, reuses (or starts) the vite renderer on :22077, then launches
  Electron with `CROWDOS_DEV=1` (loads vite, backend still embedded on
  127.0.0.1) plus `--inspect=9229` for the main process.
  - Main process: `chrome://inspect` → configure `127.0.0.1:9229`
    (`ELECTRON_INSPECT=0` disables, `=<port>` changes).
  - Renderer: DevTools auto-opens detached (`CROWDOS_DEVTOOLS=0` disables).
  - Backend: Fastify/socket logs stream in the launch console; file log at
    `<userData>/logs/desktop.log` via `crowdos:log:write`.
  - Legacy split (build + run by hand): `npm run build:tsc --workspace
    @crowdspace/desktop`, start vite (`npm run dev`), then in PowerShell
    `$env:CROWDOS_DEV=1; npx --prefix packages/desktop electron .`
- Packaged: `npm run build --workspace @crowdspace/client`,
  `npm run build --workspace @crowdspace/server`,
  `npm run dist:desktop` → `packages/desktop/release/CrowdSpace-Nightly-Setup-*.exe`.
- First run: main forks server `db/bootstrap.js` (drizzle migrations + seed,
  120 s timeout). No Postgres, no problem: boot logs a warning and continues
  offline (DB-backed routes degrade until Postgres is up) — start Postgres
  and relaunch, or `npm run db:push`. Rollback: keep the previous installer
  + `pg_dump` before upgrading; restore = reinstall + `psql < backup.sql`.
- Signing: unsigned local builds warn on SmartScreen. Signed Nightly builds
  come from CI with `CSC_LINK` + `CSC_KEY_PASSWORD` set (or Azure Trusted
  Signing via `win.azureSignOptions` in `electron-builder.yml`); verify the
  four prototype drills below against a signed installer before public release.
- Kill-mid-run drill: start a run, SIGKILL the app mid-tool, relaunch →
  orphan sweeper flips `RUNNING` → `ORPHANED` → `RESUMABLE` (60 s heartbeat),
  resume via `POST /api/runs/:id/resume`, gap-fill via
  `GET /api/events/recent?afterSeq=` (covered by e2e test (c) at API level).
- Update rehearsal: `crowdos:updater:check` blocks while runs are active
  (drain prompt); v1 has no auto-install (`publish: null`) — ship N/N+1
  installers and verify manual upgrade preserves `<userData>` + DB.

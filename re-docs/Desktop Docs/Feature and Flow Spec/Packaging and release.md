# Packaging and release
> Type: Flow · Status: drifting · Updated: 2026-09-13

## Intent
Ship one Windows x64 NSIS installer that carries the shell, the client bundle, and the server bundle together, installs per-user with a choosable directory, and phones home to nothing (no publish provider).

## Architectural decision
Unsigned OSS v1 on purpose: `signAndEditExecutable: false` with an explicit signing TODO (certificate file/password or Azure Trusted Signing) gated before any public release, and `publish: null` so there is no auto-update channel to drift from `[Observed]` (`electron-builder.yml:1-3`, `electron-builder.yml:23`, `electron-builder.yml:31`). The image is path-assembled, not recompiled: prebuilt `dist`, `client/dist`, `server/dist` plus `package.json` are copied in, so packaging assumes a prior compile `[Observed]` (`electron-builder.yml:9-17`) `[Inferred]` for the compile-before-package order. Runtime never trusts the install layout: renderer entry resolves from a candidate list (resources path, app path, dev trees) and data roots inject `app.getPath("userData")` instead of `process.cwd()` `[Observed]` (`paths.ts:39-59`, `paths.ts:3-15`).

## How it works
1. Compile shell + server (+ client) so `packages/desktop/dist`, `packages/server/dist`, `packages/client/dist` exist — observed as workspace `npm run build` steps in the dev launcher (`scripts/dev-electron.mjs:131-132`); the release build chain itself is unverified, see gaps.
2. electron-builder copies `dist → dist`, `../client/dist → client/dist`, `../server/dist → server/dist`, `package.json → package.json` into the app image (`electron-builder.yml:9-17`).
3. Windows target builds an x64 NSIS installer (`electron-builder.yml:18-23`): per-user (`oneClick: false`), changeable directory, desktop + start-menu shortcuts named CrowdOS, artifact `CrowdOS-Setup-${version}.${ext}` (`electron-builder.yml:24-30`); output to `release/`, resources from `build/` (`electron-builder.yml:6-8`).
4. No publish step (`publish: null`, `electron-builder.yml:31`) — updates are manual N/N+1 installers, matching the updater IPC stubs (`updateAvailable: false`, manual-install refusal).
5. At first run the shell resolves `<userData>` roots via `getDesktopPaths`, migrates, starts the embedded backend, and serves the bundled renderer — packaged CSP on, DevTools off (see domain spec Flow).

## Components involved
| doc | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the surface: `electron-builder.yml` (package config), `paths.ts` (install-layout-agnostic resolution), updater policy (manual-installer answers matching `publish: null`) |

## Current state
Real as-configured: appId `com.crowdos.app`, product `CrowdOS`, NSIS x64 unsigned (declared openly), four `files` mappings, `publish: null`. Renderer/data resolution is layout-independent.

## Alignment notes
Drift: `crowdos:updater:install` tells the user to "run the signed installer" (`main/ipc-handlers.ts:259-263`), but no signing is wired — `signAndEditExecutable: false` with an explicit pre-release signing TODO (`electron-builder.yml:1-3`, `electron-builder.yml:23`). The message overpromises until signing lands; honest wording is "unsigned installer" (with its SmartScreen friction) or land signing first.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Unsigned OSS v1 stays explicit: signAndEditExecutable false with signing TODO gated before public release, publish null with no auto-update channel.
* Image stays path-assembled from prebuilt dist plus client/dist plus server/dist. Compile-before-package order is an explicit release rule.
* crowdos:updater:install messaging matches reality: unsigned installer with SmartScreen friction until signing lands. Overpromising signed installer is forbidden.
* Release build command chain producing the three dists is documented and verified, never dev-launcher-only.
* directories.buildResources contents are inspected with missing-asset failure mode documented. crowdos:// protocol registration has an explicit owner: NSIS installer, in-app setAsDefaultProtocolClient, or both. desktop.zip at package root is removed or documented. Authority: Desktop Shell domain standard.
## Open gaps
- The release build command chain (which script produces the three dists before electron-builder runs) is unverified — only the dev launcher's build steps were read (`scripts/dev-electron.mjs:131-132`).
- `directories.buildResources: build` (`electron-builder.yml:8`) — contents of `packages/desktop/build` (icons? NSIS assets?) were not inspected; missing-asset failure mode unverified.
- Whether the NSIS installer registers the `crowdos://` protocol itself or registration relies solely on in-app `setAsDefaultProtocolClient` (`main/app-shell.ts:78-84`) is unverified.
- `desktop.zip` at the package root (noted in the domain doc gaps) — relationship to release artifacts, if any, unverified.

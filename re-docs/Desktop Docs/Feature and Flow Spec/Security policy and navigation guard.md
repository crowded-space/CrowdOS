# Security policy and navigation guard
> Type: Feature · Status: aligned · Updated: 2026-09-13

## Intent
The desktop window must be a sealed box: no Node in the renderer, no navigation away from the bundled UI and the loopback backend, no popups, minimum permissions, and a strict content policy — with a small, explicit dev exception so the vite workflow keeps working.

## Architectural decision
The shape is three linked choices. First, the window baseline is pure data (`contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`, loopback-only `allowedConnectSrc`, full CSP string) shared by `buildMainWindowOptions` and the packaged CSP header, and it imports no Electron so tests and lint can read it anywhere `[Observed]` (`security-policy.ts:1-18`, `main/app-shell.ts:34-51`). Second, navigation is a pure allowlist function — `app:` always, `file:` only when it resolves under a known renderer path, `http:`/`ws:` only for loopback hosts on the backend or dev-server port — wired into `will-navigate`, with `setWindowOpenHandler` denying every popup and routing allowed externals through `shell.openExternal` `[Observed]` (`main/navigation-guard.ts:23-61`, `main/index.ts:289-309`). Third, permissions default-deny except notification toasts, and filesystem roots are injected (`app.getPath("userData")`) instead of read from `process.cwd()` `[Observed]` (`main/navigation-guard.ts:93-99`, `main/index.ts:418-420`, `paths.ts:3-10`). The rejected alternatives are visible: no blanket `file:` trust, no `openExternal` to loopback, no camera/mic/geolocation grants `[Inferred]`.

## How it works
`buildMainWindowOptions` derives `webPreferences` (preload, isolation, sandbox, `backgroundThrottling: false`) from `DESKTOP_SECURITY`. At runtime, `will-navigate` blocks anything `isAllowedNavigation` rejects; new windows are always denied while `isAllowedExternal(url)` (non-loopback http/https, further restricted when the host allowlist is non-empty) decides whether the URL also opens in the system browser. The permission handler grants only `notifications`. Responses get a `Content-Security-Policy` header from `DESKTOP_SECURITY.csp` in packaged builds (skipped in dev). Paths flow from the injected `userData` root: `dataRoot → workspaces/ + logs/ + config.json`, with renderer candidates searched `resourcesPath → getAppPath → __dirname` relatives.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the policy: `security-policy.ts` (baseline + CSP), `main/navigation-guard.ts` (pure guards), `paths.ts` (injected roots), wiring in `main/index.ts:384-427` + `main/app-shell.ts:34-51` |

## Current state
Real and wired: hardened window options, `will-navigate` gate, popup deny + external-open routing, notifications-only permissions, packaged CSP header, loopback-exclusion on `openExternal`, and cwd-independent paths all run today. Dev exceptions (vite URL/port navigation, no CSP header, detached DevTools) are implemented.

## Alignment notes
Cross-checked `security-policy.ts:5-12` against `main/app-shell.ts:42-49` (options mirror the baseline) and `main/index.ts:421-427` (CSP from the same string, packaged-only): consistent. `main/navigation-guard.ts:48-56` loopback + port matching matches the `will-navigate` call site (`backendPort`, devServerPort `22077`, `DEV_RENDERER_URL`). `EXTERNAL_HTTPS_ALLOWLIST` is `[]`, so the "allow safe external" branch is the live one — matches the call site's unconditional `shell.openExternal` for allowed URLs. No drift found.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* Window baseline stays pure data with isolation, sandbox, no nodeIntegration, webSecurity, loopback-only connect-src, full CSP, shared by window options and packaged header.
* Navigation stays a pure allowlist: app: always, file: only under known renderer paths, http and ws only for loopback backend or dev-server port, wired into will-navigate with popup deny and allowed externals through shell.openExternal.
* Permissions stay default-deny except notification toasts. Roots stay injected from userData, never process.cwd().
* EXTERNAL_HTTPS_ALLOWLIST empty has an explicit allow-safe-external or curated-list contract. Silent allow-any-external is forbidden.
* Packaged CSP has dev parity coverage or an explicit dev-skips-CSP contract with a pre-release CSP test. file: check edge cases on Windows are tested. rendererCandidates plus workspace root duplication has one canonical path per launch mode. Authority: Desktop Shell domain standard.
## Open gaps
- Empty `EXTERNAL_HTTPS_ALLOWLIST` permits any non-loopback http/https URL — whether a curated host list is planned (the constant suggests it) is unverified.
- CSP is skipped entirely in dev — whether dev ever exercises the packaged policy (and would catch CSP breakage before release) is unverified.
- `file:` check lowercases and prefix-matches the renderer dir — symlink/case/encoding edge cases on Windows were read but not tested here.
- `rendererCandidates` and `resolveWorkspaceRoot`/`resolveWorkspacesDir` duplication: which path is canonical per launch mode is code-read only, not live-verified packaged.

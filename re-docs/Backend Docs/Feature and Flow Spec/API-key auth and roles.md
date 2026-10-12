# API-key auth and roles
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Every HTTP request must prove who it is before anything else runs, and what it may do follows from the key it presented — never from headers the client chose. This feature exists so a stolen or forged `x-user-id` header yields nothing, least-privilege roles apply by default, and the old shared-token mode survives only as a rollback path.

## Architectural decision
Default-deny with server-resolved identity: in strict mode every non-`OPTIONS`, non-health request without a verifiable key gets 401, and identity (`request.identity`, `userId = apikey:<id>`) is built from the matched `api_keys` row while client identity headers are ignored and overwritten `[Observed]`. Roles are a strict hierarchy `viewer < operator < admin` enforced by `requireRole`, with `requireAdmin` on top — but both collapse to pass-through in legacy mode, trading granularity for rollback availability `[Observed]`. Keys rest only as per-key random-salt scrypt hashes verified with `timingSafeEqual` scans, and `last_used_at` touches are fire-and-forget so telemetry can never fail auth `[Observed]`. Bootstrap guarantees operability by minting exactly one admin when none exists and printing it once to stdout, never persisting plaintext `[Observed]`. Health-only exemption plus `OPTIONS` passthrough keeps probes and CORS working without widening the hole `[Inferred]`.

## How it works
`index.ts` installs `authGate.requireAuth` as a global `onRequest` hook before rate limiting so the limiter can key on identity. `requireAuth` dispatches on the import-time `AUTH_STRICT` const into strict or legacy paths. Strict extraction tries `Bearer`, then `x-api-key`, then `?api_key=`; `OPTIONS` and `/health` + `/api/health` (query-stripped) return before any check. Strict verification rejects non-`crowd_` candidates without a DB round-trip, scans active (non-revoked) rows with per-key scrypt plus `timingSafeEqual`, touches `last_used_at` fire-and-forget on match, and collapses verification throws to `null` then 401. The matched row becomes `request.identity` with a default `workspaceId = "default"`. The legacy path warns once and goes fully open when no `AUTH_TOKEN`/`API_KEY` is set (trusting `x-user-id`), otherwise demands token equality and trusts `x-user-id`/`x-workspace-id`. `requireRole(minimum)` re-runs auth, skips further checks when already replied or in legacy mode, else 403s below-rank roles with `Requires <minimum> role.` `requireAdmin` demands `role === "admin"` in strict mode, or the `WORKSPACE_ADMIN_TOKEN` bearer in legacy mode. `requireWorkspaceAccess` re-runs auth and resolves a workspace id but enforces nothing beyond auth. Sockets verify keys in `socket-auth.ts` (strict `verifyKey` → `apikey:<id>`) without calling the HTTP hooks, plus keyless loopback-peer trust with server-minted identity (`register-socket-server.ts`). On boot, `seedBootstrapAdminKey` no-ops when any non-revoked admin exists, otherwise mints a `bootstrap-admin` key printed once.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Auth.md> | Owns the HTTP gate (`auth-gate.ts`), the key store (`api-key-service.ts`), and the `authGate` facade |
| <../Domain Spec/Sockets.md> | Mirrors the two modes for handshakes in `socket-auth.ts` (service-level `verifyKey`, own open modes) |
| <../Domain Spec/Routes.md> | Consumes the guards (`approvals`, `runs`, `tools`/`studio`, `queue`, conditional `observability`/`metrics`) and runs rate limiting after the auth hook |
| <../Domain Spec/Workspace.md> | Owns the tenant hook (`getWorkspaceDb`) that runs independently of auth; `requireWorkspaceAccess` resolves but does not enforce tenancy |

## Current state
Live as documented: strict mode is the default (`AUTH_STRICT` anything but `false`), `DESKTOP_MODE=1` forces non-strict, only the two health paths are exempt, identity is server-resolved, role ranks are `viewer:1 < operator:2 < admin:3`, and legacy mode (open-in-dev, header-trusted identity, role-check pass-through) is preserved verbatim. Bootstrap seeding runs on the `index.ts` boot path. Route guards are wired per the Relations table; `createApiKey`/`revokeKey` have no REST surface and `requireWorkspaceAccess` has no outside callers.

## Alignment notes
`none found` — sampled claims verified: default-deny 401 (`auth-gate.ts:81-83`), health + `OPTIONS` exemption (`auth-gate.ts:27-29`, `auth-gate.ts:82`), server-resolved identity overwriting client headers (`auth-gate.ts:103-104`), loopback trust plus Bearer/`x-api-key`/query token paths (`auth-gate.ts:153-156`, `auth-gate.ts:62-71`), hierarchy ranks and 403s (`auth-gate.ts:14`, `auth-gate.ts:140-161`), prefix-guard without DB round-trip (`api-key-service.ts:118`), scrypt + `timingSafeEqual` scan with fire-and-forget touch (`api-key-service.ts:111-124`), and bootstrap once-only stdout (`api-key-service.ts:227-232`). No contradiction between the Auth domain doc and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in the linked domain specs.
* Strict-only default-deny API-key auth stays the standard. Server-resolved identity only, no client header trust.
* Roles stay viewer less than operator less than admin. Legacy pass-through is retired.
* Query-string api_key transport is removed. Bearer and x-api-key headers only.
* Socket and HTTP auth share one parity table. Socket-only open modes are forbidden.
* Authority: Auth domain standard. This flow does not duplicate rules.
## Open gaps
- `requireWorkspaceAccess` resolves a workspace id into a local and enforces nothing — whether tenant authorization was intended here or lives entirely in the Workspace tenant hook is unverified (`auth-gate.ts:121`).
- `createApiKey`/`revokeKey` have no REST surface observed — issuance/rotation/revocation appears test- or console-driven; operator flow is unverified.
- `seedBootstrapAdminKey` runs only in `index.ts`, not in the `create-app.ts` boot path — whether the desktop/embedded entry ever guarantees an admin key is unverified.
- `index.ts` (auth gate) vs `create-app.ts` (PIN gate) are parallel entries with different global hooks — which entry is canonical in production vs desktop/test is unresolved.
- `api-key-service.ts` is imported only via `authGate` — Sockets (`socket-auth.ts:3`) and boot (`index.ts:10`) both go through the gate (`auth-gate.ts:3`) — gate-shape stability covers all key-service consumers.
- Sockets accepts keyless loopback handshakes with server-minted identity (2026-09-20; fixes `connect_error Unauthorized` for keyless browser/desktop clients) while HTTP stays strict-only — socket-vs-HTTP parity under that mode is deliberate loopback-trust parity, not drift.
- Query-string `?api_key=` is accepted on HTTP while the PIN gate deliberately disables query credentials — asymmetry intent unverified.
- `AUTH_STRICT` is snapshotted at import while `DESKTOP_MODE` is read live — hot env flips behave inconsistently; no reload path was found.
- DB-001 fixed 2026-10-07: db:encrypt-secrets --apply now refuses to run without CREDENTIALS_ENCRYPTION_KEY (skipped-no-key + exit 1) and counts only values that actually changed (backfill-encrypt-secrets.ts:33,68-77,54-59,119-126); dry-run prints keyStatus. Guarded by src/db/backfill-encrypt-secrets.test.ts (hermetic).

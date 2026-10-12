# Auth

## Purpose
SEC-1 HTTP authentication gate: strict-only default-deny API-key auth with server-resolved identity and role hierarchy. Key hashing/verification and bootstrap seeding live in the sibling `api-key-service.ts`; the local screenlock PIN is the child Auth/Pin domain, not this one.

**The gate is MOUNTED.** `create-app.ts` registers `authGate.requireAuthMounted` as a global
`onRequest` hook, after the tenant-DB and PIN hooks. Before the 2026-09-21 calibration pass the gate
existed, was tested, and was registered on nothing — a default-deny control that never ran while the
code advertised it. The mounted entry point adds exactly two things the strict-only preHandler did
not have: a narrow pre-key portal exemption list, and loopback-peer trust that mirrors the socket
handshake boundary.

## Feature Scope
In-scope:
- Strict auth: `Authorization: Bearer`, `X-API-Key`, or `?api_key=` extraction with scrypt verification against non-revoked `api_keys` rows (`auth-gate.ts`, `api-key-service.ts`).
- Server-resolved identity (`request.identity`, `userId = apikey:<id>`) with spoofable client identity headers ignored (`auth-gate.ts:103-104`).
- Role hierarchy `viewer < operator < admin` via `requireRole` and admin-only `requireAdmin` (`auth-gate.ts:165`, `auth-gate.ts:184`).
- Legacy shared-token mode (`AUTH_STRICT=false`) with open-in-dev fallback, preserved verbatim for rollback (`auth-gate.ts:88`).
- Bootstrap admin key seeding with once-only stdout emission (`api-key-service.ts:227-232`).
Non-goals (other domains):
- Local screenlock PIN enforcement → Auth/Pin (`pinGate.requirePin`, `pin-gate.ts:190`); this gate never reads PINs.
- Socket handshake identity → Sockets (`socket-auth.ts` verifies keys via this gate, plus loopback-peer trust minted server-side in `register-socket-server.ts`).
- Per-route rate limiting → Routes (`registerRateLimit` runs after the auth hook so it can key on identity).
- Workspace sharding/DB routing → Workspace (`getWorkspaceDb` tenant hook, independent of auth).
- Key management UI/rotation endpoints → none observed (no REST route mints or revokes keys).

## Expect
- `[Observed]` Strict mode is default-deny: every non-`OPTIONS`, non-health request without a verifiable key gets 401 `Missing or invalid API key.` (`auth-gate.ts:81-83`).
- `[Observed]` Only `/health` and `/api/health` are exempt; query-string stripping precedes the check so `/health?x=1` stays exempt (`auth-gate.ts:27-29`).
- `[Observed]` Identity is never client-declared in strict mode: `x-user-id`-style headers are ignored and overwritten from the key row (`auth-gate.ts:103-104`).
- `[Observed]` Legacy mode with no `AUTH_TOKEN`/`API_KEY` set is fully open (warns once) and trusts `x-user-id` (`auth-gate.ts:88`).
- `[Observed]` `requireRole` is hierarchy-ranked (`viewer:1 < operator:2 < admin:3`) and 403s with `Requires <minimum> role.` (`auth-gate.ts:14`, `auth-gate.ts:171-175`).
- `[Observed]` Legacy `requireRole` lets any authenticated request through (rollback parity, no role check) (`auth-gate.ts:137`).
- `[Observed]` Non-`crowd_` prefixed candidates reject without a DB round-trip (`api-key-service.ts:118`).
- `[Inferred]` `AUTH_STRICT` is snapshotted at module import while `DESKTOP_MODE` is read live — flipping strictness needs a restart, desktop bypass does not (`auth-gate.ts:18`, `auth-gate.ts:28`).

## Flow
1. Hook: `create-app.ts buildServer()` installs `authGate.requireAuthMounted` as a global `onRequest` hook, AFTER the tenant-DB `x-workspace-id` routing hook and after `pinGate.requirePin`, so `request.workspaceId` is resolved before identity is minted. Rate limiting is registered after the gate so the limiter can key on identity (`create-app.ts`).
1a. Mounted dispatch order: `OPTIONS` → health → portal discovery → presented key → loopback peer → 401. An explicitly presented BAD key is rejected even from loopback (a supplied credential is authoritative and cannot be laundered by peer address).
2. Dispatch: `requireAuth` branches on the import-time `AUTH_STRICT` const into strict or legacy paths (`auth-gate.ts:116`).
3. Strict extract: `extractApiKey` tries `Bearer`, then `x-api-key`, then `?api_key=` (`auth-gate.ts:62-71`); `OPTIONS` and health paths return before any check (`auth-gate.ts:82`).
 4. Strict verify: `verifyKey` rejects non-prefixed keys, selects the single candidate whose sha256(key) hint matches, confirms with one scrypt + `timingSafeEqual`, and touches `last_used_at` fire-and-forget on match (`api-key-service.ts:66`, `api-key-service.ts:33`, `api-key-service.ts:78`); verification throws collapse to `null` then 401 (`auth-gate.ts:71`).
   2026-09-25 audit fix (cross-domain, done during the Tools batch): authentication used to run scrypt against EVERY active key — sequential at first, then concurrent — so cost still grew with stored-key count and blew per-request budgets (observed 5s request-path timeouts). O(1) now: `createApiKey` stores `key_hint = sha256(plaintext)` (migration `0023_api_keys_key_hint.sql` + schema mirror + local rows); `verifyKey` looks the hint up instantly and runs exactly ONE scrypt against the hinted row. The hint reveals nothing about a 256-bit random key, and scrypt still confirms every match. Rows without a hint (legacy/local fallback) keep a concurrent full-scan path; revocation union semantics unchanged.
  2026-10-07 db-audit repair: `0011_drop_api_keys.sql` drops the table + enum, so on a fresh DB the original 0023 ALTER failed ("relation api_keys does not exist") and — because drizzle applies the pending batch in one transaction — rolled back EVERY migration after 0022 (first-run desktop migrate included). 0023 now recreates the 0002 shape (enum + table, both idempotent) before its ALTER/index so fresh and stale DBs converge; no doc-visible contract change.
5. Strict identity: the matched row becomes `request.identity` with `(request as any).userId = apikey:<id>` and a default `workspaceId = "default"` (`auth-gate.ts:103-104`).
6. Legacy path: unset token logs one dev-mode warning and trusts `x-user-id` as `user-1`; set token must equal `x-api-key`/`Bearer`/`x-admin-token` or 401, then trusts `x-user-id`/`x-workspace-id` headers (`auth-gate.ts:88`, `auth-gate.ts:98`, `auth-gate.ts:112`).
7. Role gate: `requireRole(minimum)` re-runs `requireAuth`, skips further checks when already replied, else 403s below-rank roles (`auth-gate.ts:165-177`).
8. Admin gate: strict-only, requires an `api_keys` row with `role === "admin"`, 403ing otherwise (`auth-gate.ts:184-191`); no legacy token path exists in-domain.
9. Workspace stub: `requireWorkspaceAccess` re-runs auth and resolves a workspace id but enforces nothing beyond auth (`auth-gate.ts:121`).
10. Socket mirror: `socket-auth.ts` verifies handshake keys via this gate (`verifyKey` → `apikey:<id>`); keyless handshakes are accepted only from loopback peers with a server-minted `loopback` identity (`local-user`/`default`), never from client claims (`register-socket-server.ts`, `socket-auth.ts:isLoopbackPeer`).
11. Bootstrap: on boot `index.ts` calls `seedBootstrapAdminKey`, which no-ops when any non-revoked admin exists and otherwise mints a `bootstrap-admin` key printed once to stdout (`index.ts:54-60`, `api-key-service.ts:227-232`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `auth-gate.ts` | HTTP gate: mode dispatch, key extraction, strict/legacy verifiers, role/admin guards, `authGate` facade |
| `api-key-service.ts` | Key store: scrypt hash/verify, `crowd_` minting, active-key scan, create/revoke, bootstrap admin seed |
| `pin-gate.ts` | Child domain (Auth/Pin): screenlock PIN only, not part of this gate’s contract |
| `../../shared/core/loopback.ts` | §19 loopback predicate — the single source of truth shared by REST and Sockets |
| `../../create-app.ts` | Mounts `requireAuthMounted` as a global `onRequest` hook (after tenant + PIN hooks) |
| `../../auth-gate-mount.test.ts` | 9 tests: mounted behavior over the real server factory + REST/socket parity |

Key types/functions: `ApiKeyRecord { id, label, role }`; `ApiKeyRole` (`admin|operator|viewer`, from `db/schema.ts:969`); `API_KEY_PREFIX = "crowd_"`; `verifyKey` (prefix-guard + timing-safe scan); `createApiKey` (default `viewer`); `revokeKey` (revoke-if-active); `seedBootstrapAdminKey`; `ROLE_RANK`; Fastify `request.identity` declaration merge (`auth-gate.ts:22`).

## Ports
- `isStrictAuth` — always `true` (strict-only; legacy flag removed).
- `requireAuth` — global preHandler (strict verification only).
- `requireRole` — factory returning a preHandler enforcing a minimum `viewer|operator|admin` rank.
- `requireAdmin` — preHandler enforcing admin role.
- `verifyKey` — verifies a presented key against active rows (re-exported; Sockets calls it via the gate).
- `createApiKey` — mints a key row (default `viewer`).
- `revokeKey` — revokes a key row if active.
- `seedBootstrapAdminKey` — mints the once-printed bootstrap admin when none exists.
- `authGate.requireAuthMounted` — the GLOBAL onRequest hook actually registered in `create-app.ts`.
- `authGate.isPortalDiscoveryPath` — the pre-key portal exemption predicate (also unit-tested).
- `authGate.isLoopbackPeer` — the §19 same-machine trust predicate, shared with Sockets.
- `authGate` — facade exposing the ports above.

## Relations
Gates this domain calls:
- None at runtime. Type-only: `ApiKeyRole` from `db/schema.ts`; `FastifyRequest/Reply` types. `auth-gate.ts` wires `verifyKey`/`createApiKey`/`revokeKey`/`seedBootstrapAdminKey` from the sibling service file into the gate (in-domain, not a gate-to-gate call).
Verified outside callers of `authGate`:
- Boot/hook: `create-app.ts:347` (`requireAuth` global hook), `index.ts:55` (`seedBootstrapAdminKey` via the gate).
- Sockets: `socket-auth.ts` (`verifyKey` via the gate).
- Route guards: `routes/approvals.ts:8` (`viewer` reads, `operator` decisions, `admin` sweep), `routes/runs.ts:7` (`operator` resume/get, `admin` compensations), `routes/tools.ts:59` + `routes/studio.ts:21` (`requireAdmin`), `routes/queue.ts:11` (`requireAdmin` failed-jobs), `routes/observability.ts:99` (conditional `requireAdmin` only when an admin token is configured; metrics routes are unguarded).
- `requireWorkspaceAccess`: no outside callers observed.
- `createApiKey`/`revokeKey` (gate ports): no REST callers observed; exercised only via socket-server tests.
Tables shared with other domains:
- `api_keys` (this domain is the sole writer; Sockets only verifies against it; no other domain writes it).

## Emits-Listens
- None observed (no broker import or emit in `auth-gate.ts` or `api-key-service.ts`).

## Owns
- `api_keys` (writes: insert on create/bootstrap, `last_used_at` touch on verify, `revoked_at` on revoke)
- `<sandboxBase>/default/vfs/.crowdos/api-keys.json` (canon 2026-09-22: operator keys are workspace-agnostic, so they live in the documented unscoped `default` folder; dual-boot: union verify across PG + file so DB-less boots stay strictly authenticated; create/revoke fall back to file; never backfilled — rotate keys while healthy)

## Mounted gate: exemptions and trust boundary

Exempt paths (the complete list — kept as small as the portal flow actually requires):
- `/health`, `/api/health` — liveness/readiness probes.
- `GET /api/workspaces` — the portal must enumerate workspaces before a key is known.
- `GET /api/workspaces/:id` — entering a workspace from the portal.
- `POST /api/workspaces/database/test` — pre-creation connection probe; validates a URL and touches no
  workspace state.
- `GET /api/workspaces/:id/screen-lock` — the lock screen must render before a key is known.

Deliberately NOT exempt: every workspace MUTATION (`POST /api/workspaces`, `PATCH`, `DELETE`), the
screen-lock WRITE endpoints, and every other API route. The desktop app reaches those through loopback
trust; a remote caller must present a key.

Loopback trust (mirrors the socket handshake boundary exactly):
- Trusted addresses: `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. The predicate lives in ONE place
  (`shared/core/loopback.ts`) and both transports import it, so the boundaries cannot drift.
- Rationale: §19 is a single-user local-app threat model. The embedded desktop backend listens on
  loopback only, so a keyless loopback request grants nothing a remote caller could obtain.
- A presented-but-invalid key fails even on loopback — address trust never overrides a supplied
  credential.
Credential channels (one credential per header):
- `Authorization` (Bearer) and `x-api-key` are API-key channels ONLY — a presented value is always
  verified as an API key (`extractApiKey`, `auth-gate.ts:62-71`), never as a screenlock PIN.
- The screenlock PIN travels on `x-pin` only (Pin domain). Sharing a header previously made this gate
  verify a PIN as an API key: it failed the `crowd_` prefix check (`api-key-service.ts:118`) and
  answered 401 `Missing or invalid API key.` on every `/api` call while a screenlock user was locked
  out of their own local app.

## Alignment notes

- 2026-09-21 mount: `requireAuth` was implemented, tested, and registered on zero routes. The gate is
  now mounted globally via `authGate.requireAuthMounted` in `create-app.ts`, with the portal exemptions
  above and loopback trust matching Sockets. `auth-gate-mount.test.ts` asserts the mounted behavior over
  the real `buildServer()` factory so it cannot silently be unmounted again, and asserts REST/socket
  predicate parity across the address list.
- 2026-09-23 credential channels: the PIN gate no longer reads `Authorization`/`x-api-key` as PIN
  candidates, and the client no longer sends `Authorization: Bearer <pin>`. The two credentials are
  now strictly partitioned (`x-pin` = PIN; `Authorization`/`x-api-key` = API key), pinned by
  `auth-pin-header.test.ts` and `packages/client/src/config/pin.test.ts`.
- 2026-09-17 dual-boot: `verifyKey` unions PG + local file rows (revoked-in-either wins); `seedBootstrapAdminKey` prints once from either tier. Local keys are a fallback tier, not synced content.
- 2026-09-20 socket loopback trust: `SOCKET_OPEN`/`DESKTOP_MODE` bypasses (removed 2026-09-14) left keyless browser/desktop sockets with `connect_error Unauthorized` and no client credential path; key-first + loopback-peer trust restores them with server-minted identity. `resolveSocketIdentity` stays credential-strict as a pure function.

## Flags
- None. `AUTH_STRICT`/`AUTH_TOKEN`/`API_KEY`/`SOCKET_OPEN`/`SWARM_LEGACY` legacy flags removed (strict-only).
- `WORKSPACE_ADMIN_TOKEN` — admin bearer for DB-mutation/metrics hardening (route-level, not gate).

## Decisions
- `[Observed]` Default-deny strict auth with server-resolved identity — compromise of a client header alone yields nothing (`auth-gate.ts:81-83`, `auth-gate.ts:103-104`).
- `[Observed]` Per-key random-salt scrypt with `timingSafeEqual` scan instead of a hash lookup — only hashes rest, at the cost of a linear verify over active keys (`api-key-service.ts:27`, `api-key-service.ts:33`).
- `[Observed]` `last_used_at` is fire-and-forget — a telemetry write failure can never fail authentication (`api-key-service.ts:78`).
- `[Observed]` Legacy mode preserved verbatim (including open-in-dev and header-trusted identity) as the rollback path (`auth-gate.ts:88`).
- `[Observed]` Bootstrap guarantees operability by minting exactly one admin when none exists and emitting it once to stdout, never persisting plaintext (`api-key-service.ts:227-232`).
- `[Observed]` Role checks are strict-only no-ops in legacy mode — rollback trades granularity for availability (`auth-gate.ts:137`).
- `[Inferred]` Health-only exemption plus `OPTIONS` passthrough keeps probes and CORS preflights working under default-deny without widening the hole (`auth-gate.ts:27-29`, `auth-gate.ts:82`).
- `[Inferred]` `requireWorkspaceAccess` is a stub extension point: it authenticates and resolves context but authorizes nothing, so routes must add their own tenant checks (`auth-gate.ts:121`).

## User Decision:

## Architectural Standard (Target)
Status: Target. Strict-only default-deny API-key auth is the standard. Legacy shared-token mode is retired.
Server-resolved identity only. No client identity header trust. Roles are viewer, operator, admin.
Query-string api_key transport is removed. Bearer and x-api-key headers only.
Socket and HTTP auth share one parity table. No socket-only open modes outside that table.
Key issuance, rotation, revocation need a documented operator path.
## Failure + Resume
- Missing/unverifiable key in strict mode → 401 `Missing or invalid API key.`; verification exceptions collapse to the same 401, never 500 (`auth-gate.ts:53`, `auth-gate.ts:71`).
- Below-rank role → 403 `Requires <minimum> role.`; non-admin in strict admin gate → 403 `Admin privileges required.` (`auth-gate.ts:171-175`, `auth-gate.ts:161`).
- Legacy bad token → 401 with token-hint message; legacy admin without a configured token → 403 `Admin access not configured.` (`auth-gate.ts:105`, `auth-gate.ts:168`).
- Already-sent replies short-circuit role/admin follow-ups via `reply.sent` (`auth-gate.ts:136`).
- Bootstrap seed failure is caught and logged at boot without aborting listen (`index.ts:54-60`).
- Resume is client-driven: present a valid key/higher-role key and retry; revoked keys never revalidate (filtered by `revokedAt IS NULL`, `api-key-service.ts:56`).

## Gaps
- `requireWorkspaceAccess` stub deleted (zero callers) — tenant authorization lives in the Workspace tenant hook, not here.
- `createApiKey`/`revokeKey` have no REST surface observed — key issuance/rotation/revocation appears test- or console-driven; operator flow is unverified.
- `seedBootstrapAdminKey` runs only in `index.ts`, not in the `create-app.ts` boot path — whether the desktop/embedded entry ever guarantees an admin key is unverified.
- `index.ts` (auth gate) vs `create-app.ts` (PIN gate) are parallel entries with different global hooks — which entry is canonical in production vs desktop/test was not resolved here.
- Sockets accepts keyless loopback handshakes (same-machine single user — REST loopback-trust parity) while HTTP stays strict-only; non-loopback keyless handshakes are still rejected. Keyed loopback clients keep their key identity and role granularity.
- Query-string `?api_key=` is accepted on HTTP (logs may capture URLs) while the PIN gate deliberately disables query credentials — asymmetry intent unverified (`auth-gate.ts:49`).
- `AUTH_STRICT` snapshot-at-import vs live `DESKTOP_MODE` means hot env flips behave inconsistently; no reload path was found.

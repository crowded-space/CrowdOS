# Pin

## Purpose
Opt-in local screenlock against casual physical access — not full auth. When no PIN is configured anywhere the gate is DISABLED and all requests pass; there is deliberately no default PIN. Crypto and HTTP/socket guards live here; hash persistence lives in Workspace.

## Feature Scope
In-scope:
- Global `LOCAL_PIN` override plus per-workspace scrypt hashes with timing-safe verify, strict `4..128` validation, and async non-blocking verify for the request path (`pin-gate.ts`).
- HTTP guard `requirePin` with health exemption, global-first precedence, per-workspace targeting, and DB-less management-path allowance (`pin-gate.ts:190`).
- Legacy drift, closed: the `verifyHandshakePin` socket checker was never implemented — HTTP `requirePin` is the only PIN guard, and it reads `x-pin` exclusively (`pin-gate.ts:167`).
- 15s single-entry PIN-entry cache with explicit invalidation (`pin-gate.ts:116`).
Non-goals (other domains):
- Hash persistence and current-PIN-proof rotation → Workspace (`workspace-pin.ts:85` writes registry + DB; this domain only hashes/verifies).
- API-key auth and roles → Auth (`authGate.requireAuth`, `api-key-service.ts`; never mixed with PIN checks).
- Tenant DB routing → Workspace (`create-app.ts` hook owns `request.db`; this gate only reads the resolver/cache).
- Rate limiting, CORS, route schemas → Routes/Shared (`registerRateLimit`, `routes/workspace.ts` screen-lock endpoints).

## Expect
- `[Observed]` Disabled means open: no global PIN and no workspace hash anywhere → `requirePin` allows (`pin-gate.ts:240-246`).
- `[Observed]` Global `LOCAL_PIN` never blocks workspace PINs: when set, either the global value or any workspace PIN passes (`pin-gate.ts:198`).
- `[Observed]` Workspace-targeted requests are isolated: with `x-workspace-id` set, only that workspace's hash matters, and hash-less workspaces allow without a PIN (`pin-gate.ts:216`, `pin-gate.ts:239`).
- `[Observed]` Untargeted requests need any-workspace match once something is configured; management paths (`/api/workspaces`, DB probe, screen-lock) additionally allow PIN-less listing so the portal works (`pin-gate.ts:253`, `pin-gate.ts:261`).
- `[Observed]` Query-string PINs are never accepted, and the PIN travels on `x-pin` ONLY — `Authorization` is the API-key channel (`auth-gate.ts:63`) and legacy `x-api-key` is an API-key alias, so neither is read as a PIN (`pin-gate.ts:167`).
- `[Observed]` Validation trims before length checks; verify trims the candidate but stored hashes are exact (`pin-gate.ts:41`, `pin-gate.ts:62`).
- `[Observed]` Wrong/missing PIN on a protected route is always 401 with the screenlock message, never 403/500 (`pin-gate.ts:179`).
- `[Inferred]` The per-request path never blocks the loop on scrypt: HTTP uses the async variant while the exported sync verifier is for setup/tests (`pin-gate.ts:84`).

## Flow
1. Extract: `extractPin` reads the `x-pin` header ONLY; empty string when absent (`pin-gate.ts:167`). `Authorization`/`x-api-key` are deliberately NOT read — see the credential-channel decision below.
2. Exempt: `OPTIONS` and `/health` + `/api/health` (query-stripped) return before any check (`pin-gate.ts:191`).
3. Global branch: when `LOCAL_PIN` is set, exact-match global or async-match any workspace hash passes as `local-user`; anything else is 401 (`pin-gate.ts:195`).
4. Targeted branch: `x-workspace-id` header (or preset `request.workspaceId`) resolves the hash via the injected resolver first, cached registry entries second (`pin-gate.ts:215`, `pin-gate.ts:219`); hash present requires async verify or 401, hash absent allows (`pin-gate.ts:230`, `pin-gate.ts:239`).
5. Portal branch: with no target, disabled-anywhere allows; a presented any-workspace match allows; PIN-less management paths allow; otherwise 401 (`pin-gate.ts:246`, `pin-gate.ts:253`, `pin-gate.ts:261`, `pin-gate.ts:268`).
6. Hash load: `loadWorkspacePinEntries` dynamically imports `workspace-registry.ts` (avoids a static Workspace↔Shared cycle) and maps records to `(id, hash)` with DB-unavailable collapsing to `[]` (`pin-gate.ts:106`).
7. Cache: single-key `TtlCache` (15s, capacity 1) fronts the registry read; screen-lock writes and tests drop it via `invalidatePinCache` (`pin-gate.ts:116`, `pin-gate.ts:128`).
8. Verify: sync `verifyScreenLockPin` and async twin parse `scrypt$salt$hash`, enforce 16-byte salt + 32-byte key lengths, compare with `timingSafeEqual`, and return `false` (never throw) on any malformed input (`pin-gate.ts:62`, `pin-gate.ts:84`).
9. Extraction: `extractPin` reads the `x-pin` header alone (no `Authorization`/`x-api-key` fallback), `requirePin` accepts a global exact match or any-workspace async match, and allows everything only when fully disabled (`pin-gate.ts:167`, `pin-gate.ts:184`, `pin-gate.ts:240-244`).
10. Wiring: `create-app.ts` injects the resolver (`getWorkspacePinHash`), installs `requirePin` as an `onRequest` hook after tenant routing, and reuses `isWorkspaceManagementPath` for DB-optional routing (`create-app.ts:331`, `create-app.ts:332`, `create-app.ts:244`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `pin-gate.ts` | Whole domain: constants, resolver seam, global/validate/hash/verify helpers, cached entry loader, path sets, HTTP + handshake guards, `pinGate` facade |
| `pin-gate.test.ts` | Hermetic opt-in/disabled/precedence/exempt/hash contract tests against a temp registry file |

Key functions: `getGlobalPin` (trimmed or `null`); `validateScreenLockPin` (trim + `4..128`, throws); `hashScreenLockPin` (random 16-byte salt, scrypt `N=16384,r=8,p=1`, 32-byte key); `verifyScreenLockPin` / `verifyScreenLockPinAsync`; `isScreenLockConfigured`; `matchesWorkspacePin` (`Promise.all` fan-out); `isWorkspaceManagementPath` (exact list/DB-probe/screen-lock regex); `PUBLIC_PATHS`.

## Ports
- `SCREEN_LOCK_PIN_MIN_LENGTH` — `4`, minimum validated PIN length.
- `SCREEN_LOCK_PIN_MAX_LENGTH` — `128`, maximum validated PIN length.
- `setWorkspacePinResolver` — injects/clears the `(workspaceId) => hash` resolver used before the registry cache.
- `getGlobalPin` — trimmed `LOCAL_PIN` or `null` when unset/blank.
- `validateScreenLockPin` — returns the trimmed PIN or throws on non-string/short/long.
- `hashScreenLockPin` — validates then returns a uniquely salted `scrypt$hex$hex` hash (never the plaintext).
- `verifyScreenLockPin` — sync timing-safe candidate-vs-hash check, `false` on any bad input, never throws.
- `invalidatePinCache` — drops the cached workspace PIN entries.
- `isScreenLockConfigured` — `true` when a global PIN or any workspace hash exists.
- `matchesWorkspacePin` — `true` when the candidate async-verifies against any workspace hash.
- `PUBLIC_PATHS` — frozen health set exempt from PIN and rate-limit scoping (`/health`, `/api/health`).
- `isWorkspaceManagementPath` — `true` for workspace list, DB probe, and per-workspace screen-lock routes.
- `requirePin` — Fastify `onRequest` guard implementing the global/targeted/portal precedence.
- `getPinForTests` — test seam returning the effective global PIN.
- `pinGate` — facade exposing the fifteen ports above.

## Relations
Gates this domain calls:
- `workspace-registry.ts` via dynamic `import()` only (`listWorkspaceRecords` at `pin-gate.ts:108`) — deliberately avoids a static Workspace↔Shared cycle; never imports the workspace gate.
- Non-gate internals used: `Shared/core/ttl-cache.ts` (`TtlCache`).
Verified outside callers:
- HTTP wiring via `create-app.ts`: resolver injection (`create-app.ts:331`), `requirePin` hook (`create-app.ts:332`), shared management-path boundary (`create-app.ts:244`).
- Crypto consumers via `Workspace/workspace-pin.ts`: `getGlobalPin` (operator-override proof), `hashScreenLockPin` + `validateScreenLockPin` (set path), `verifyScreenLockPin` (proof path) (`workspace-pin.ts:12`).
- Tests only: `pin-gate.test.ts` (HTTP/handshake/cache contracts), `workspace-pin.test.ts` (sanitize + proof via the hash helper).
- `verifyHandshakePin`: no production socket caller observed — the live socket server authenticates via `socket-auth.ts` (API-key modes), not this helper.
- `getPinForTests` / `setWorkspacePinResolver(null)`: test/boot seams only.
Tables shared with other domains (all read-only here):
- `workspaces.json` registry `screenLockPinHash` values (written by Workspace `workspace-pin.ts`, never by this gate).

## Emits-Listens
- None observed (no broker import or emit in `pin-gate.ts`).

## Owns
- None. This gate writes no tables or queues: hashing is pure (callers persist), verification is read-only, and the only state is the in-memory 15s entry cache.

## Flags
- `LOCAL_PIN` — the sole env: non-empty trimmed value enables the global operator override; unset/blank means not configured (`pin-gate.ts:34`).

## Decisions
- `[Observed]` Explicit opt-in with no fallback default — unconfigured means disabled-open rather than a hardcoded PIN (`pin-gate.ts:7`, `pin-gate.ts:240-243`).
- `[Observed]` Global-first precedence that still honors workspace PINs — an operator override never locks out per-workspace secrets (`pin-gate.ts:198`).
- `[Observed]` Per-workspace isolation on targeted requests — a wrong-workspace PIN cannot unlock another workspace, and hash-less workspaces stay open (`pin-gate.ts:216`).
- `[Observed]` Management paths stay PIN-less-accessible so the portal can list workspaces and configure locks before any database resolves (`pin-gate.ts:155`, `pin-gate.ts:261`).
- `[Observed]` Query-string credentials disabled as desktop hardening; the Auth gate still accepts `?api_key=`, so the two gates intentionally differ (`pin-gate.ts:167`).
- `[Observed]` One credential per header: the PIN is read from `x-pin` alone and never from `Authorization`/`x-api-key`, because those two are the Auth gate's API-key channels (`auth-gate.ts:63`). Sharing a header made each gate verify the other's credential: the PIN gate misread an API-key client as presenting a wrong PIN, and the Auth gate verified a PIN as an API key, failed the `crowd_` prefix check (`api-key-service.ts:118`), and answered 401 `Missing or invalid API key.` on every `/api` call — a lockout for any user who had enabled screenlock (`pin-gate.ts:167`, `auth-gate.ts:63`).
- `[Observed]` Only scrypt hashes persist; plaintext never touches disk/DB and hashes are uniquely salted per call (`pin-gate.ts:53`, `pin-gate.test.ts:168`).
- `[Observed]` Verification is timing-safe with strict shape/length gates and never throws — malformed hashes are `false`, not errors (`pin-gate.ts:62`).
- `[Observed]` Async scrypt on the request path with sync reserved for setup/tests — throughput over convenience (`pin-gate.ts:78`, `pin-gate.ts:84`).
- `[Observed]` Dynamic registry import plus short-TTL single-entry cache — no static cycle, bounded staleness, explicit drop on writes (`pin-gate.ts:106`, `pin-gate.ts:116`, `pin-gate.ts:128`).
- `[Inferred]` Resolver-before-cache ordering lets the host app override hash sourcing (DB-first in `create-app.ts`) while keeping the registry as the default (`pin-gate.ts:219`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Opt-in plus global-first plus scrypt-only stay; handshake coverage, shared boundaries, and import casing are the gaps.
Explicit opt-in with no default stays: unconfigured means disabled-open, never a hardcoded PIN.
Global-first precedence honoring workspace PINs stays. Per-workspace isolation stays: wrong-workspace PIN never unlocks another workspace.
Management paths stay PIN-less so the portal lists workspaces and configures locks before any database resolves.
Only scrypt hashes persist with unique salts. Plaintext never touches disk or DB. Verification is timing-safe with strict gates and never throws.
Async scrypt stays on the request path with sync reserved for setup and tests.
Socket-handshake PIN coverage was doc drift: verifyHandshakePin never existed in pin-gate.ts (verified by search 2026-09-16). Local-first sockets intentionally verify nothing; the PIN guards HTTP only.
Dead getDb plus workspaces imports removed 2026-09-16. Abandoned-path imports stay forbidden.
setWorkspacePinResolver global mutable state MUST stack and restore outside tests or be documented single-host. Silent multi-tenant conflicts are forbidden.
isWorkspaceManagementPath MUST live in a shared routing module, not pin-gate. Forked security boundaries are forbidden.
PUBLIC_PATHS in pin-gate.ts is the single health-exemption source (Auth gate deleted 2026-09-16). Duplicated exempt sets stay forbidden.
matchesWorkspacePin scrypt fan-out MUST be capped. Unbounded per-workspace scrypt is forbidden.
Workspace registry import casing MUST match on-disk PascalCase. Case-insensitive-only validity is forbidden.
x-workspace-id targeting allow-on-no-hash MUST be an explicit threat-modeled contract, never silent open.
## Failure + Resume
- Protected-route failure → 401 with the screenlock message (set `x-pin` and retry); `OPTIONS` and health paths never 401 (`pin-gate.ts:173`, `pin-gate.ts:185`).
- Unresolvable-workspace targeting degrades to allow-with-`local-user` when the workspace has no hash, and to 401 only when a hash exists but the candidate fails (`pin-gate.ts:230`).
- Registry/DB unreadable collapses to `[]` entries, which under no-global-PIN means disabled-open rather than fail-closed (`pin-gate.ts:106`).
- Malformed hashes, empty candidates, and scrypt errors all resolve to `false`/401, never throw (`pin-gate.ts:62`, `pin-gate.ts:84`).
- Stale reads self-heal within 15s or immediately via `invalidatePinCache` after screen-lock writes (`pin-gate.ts:116`).
- Resume is client-driven: present the correct global or workspace PIN on `x-pin` and retry; rotate via Workspace screen-lock endpoints (current-PIN proof or global override).
- Client-side counterpart: `packages/client/src/config/pin.ts` sends the PIN on `x-pin` only. Its `withPinHeaders` merge normalizes through `new Headers()` — `HeadersInit` is a union and `Object.entries()` enumerates only the plain-object arm, so a `Headers` instance (what `apiClient` passes) yielded an empty set and silently dropped `x-workspace-id`/`Content-Type` on every `/api/*` fetch.

## Gaps
- Closed 2026-09-16: the verifyHandshakePin gap was doc drift — the function never existed in pin-gate.ts. Socket auth was deleted with socket-auth.ts; the PIN guards HTTP only.
- Closed 2026-09-16: dead `getDb`/`workspaces` imports removed from pin-gate.ts.
- `setWorkspacePinResolver` override is process-global mutable state with no stacking/restore outside tests — concurrent-host or multi-tenant resolver conflicts are unverified (`pin-gate.ts:29`).
- `isWorkspaceManagementPath` is shared by the PIN gate and the tenant-DB hook as the security boundary, but it lives in this file rather than a shared routing module — drift risk if either side forks the check (`pin-gate.ts:155`, `create-app.ts:244`).
- `PUBLIC_PATHS` duplicates the Auth gate's health exemption inline instead of sharing it — the two exempt sets could drift (`pin-gate.ts:148` vs `auth-gate.ts:27-29`).
- `matchesWorkspacePin` fans out one async scrypt per workspace entry with no cap — cost under many-workspace fleets is unverified (`pin-gate.ts:140`).
- Lowercase `../../workspace/workspace-registry.ts` import vs on-disk PascalCase `Workspace/` (`pin-gate.ts:108`) — valid on case-insensitive filesystems, breaks on case-sensitive ones; frozen per task, do not rename.
- Whether `x-workspace-id` targeting can be spoofed to probe hash-less workspaces open (allow on no-hash) was not threat-modelled beyond code reading (`pin-gate.ts:239`).
- No `listens` observed; whether any UI/socket layer reacts to lock set/clear beyond the next-request 401 was not traced.

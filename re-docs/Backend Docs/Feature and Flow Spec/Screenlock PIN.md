# Screenlock PIN
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
A local screenlock against casual physical access — not full auth. This feature exists so a shared or unattended desktop can demand a PIN per workspace (plus an operator override), while a machine with nothing configured stays fully open rather than falling back to an insecure default.

## Architectural decision
Explicit opt-in with no default: no global PIN and no workspace hash anywhere means DISABLED, and both the HTTP guard and the handshake checker allow `[Observed]`. Precedence is global-first without lockout — when `LOCAL_PIN` is set, either the global value or any workspace PIN passes `[Observed]`. Targeted requests are isolated per workspace (wrong-workspace PINs fail, hash-less workspaces stay open), while untargeted portal traffic additionally allows PIN-less management paths so workspace listing and lock setup work before any database resolves `[Observed]`. Only scrypt hashes persist, uniquely salted per call, verified timing-safe with strict shape/length gates that return `false` never throw; the request path uses the async variant so scrypt never blocks the loop `[Observed]`. Query-string credentials are refused as desktop hardening — headers only — which intentionally differs from the Auth gate's `?api_key=` acceptance `[Observed]`. Crypto and guards live in Auth/Pin; hash persistence lives in Workspace `[Observed]`.

## How it works
`extractPin` reads the `x-pin` header ONLY — `Authorization`/`x-api-key` are the Auth gate's API-key channels and are deliberately never read as PIN candidates; empty when absent. `requirePin` exempts `OPTIONS` and `/health` + `/api/health` (query-stripped) first. Global branch: when `LOCAL_PIN` is set, an exact global match or an async any-workspace match passes as `local-user`, anything else is 401 with the screenlock message. Targeted branch: `x-workspace-id` (or preset `request.workspaceId`) resolves the hash via the injected resolver first, cached registry entries second; hash present requires async verify or 401, hash absent allows. Portal branch: with no target, disabled-anywhere allows, a presented any-workspace match allows, PIN-less management paths (`/api/workspaces`, DB probe, screen-lock regex) allow, otherwise 401. Hash loading dynamically imports `workspace-registry.ts` (avoiding a static Workspace↔Shared cycle) and collapses DB-unavailable to `[]`; a single-key 15s `TtlCache` fronts registry reads and is dropped on screen-lock writes via `invalidatePinCache`. On the client, `packages/client/src/config/pin.ts` sends the PIN on `x-pin` only and merges headers through `new Headers()` so `apiClient`'s `Headers`-instance headers survive. `create-app.ts` injects the resolver (`getWorkspacePinHash`), installs `requirePin` after tenant routing, and reuses `isWorkspaceManagementPath` for DB-optional routing. Workspace-side, `setScreenLockPin` validates `4..128` chars, requires current-PIN proof (stored hash or global override) when a hash exists, writes the registry then best-effort DB sync; reads go registry-first, DB-second.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Pin.md> | Owns crypto, validation, the 15s entry cache, the HTTP guard (`requirePin`) and the handshake checker (`verifyHandshakePin`) in `pin-gate.ts` |
| <../Domain Spec/Workspace.md> | Owns hash persistence (`workspace-pin.ts`: registry-first load, status/get/set/clear, current-PIN proof, hash-stripping sanitize) and the `workspaces.json` registry |
| <../Domain Spec/Routes.md> | Owns the screen-lock endpoints and rate-limit/CORS wiring; shares the management-path boundary with the tenant hook in `create-app.ts` |

## Current state
Live as documented: DISABLED-open when unconfigured, global `LOCAL_PIN` override, per-workspace scrypt hashes (`scrypt$salt$hash`, 16-byte salt, 32-byte key), `4..128` trimmed validation, 401 (never 403/500) on protected-route failure, management-path allowance for PIN-less portal listing, plaintext never persisted, hashes never leaving the server (only `screenLockEnabled` exposed). Resolver-before-cache ordering lets `create-app.ts` override hash sourcing DB-first with the registry as default.

## Alignment notes
`none found` — sampled claims verified: disabled-open (`pin-gate.ts:246`, `pin-gate.ts:240-244`), global-first precedence honoring workspace PINs (`pin-gate.ts:198`), targeted isolation with hash-less allow (`pin-gate.ts:216-239`), portal/management allowance (`pin-gate.ts:253-265`), headers-only extraction (`pin-gate.ts:167`), 401 screenlock message (`pin-gate.ts:179`), dynamic registry import with `[]` collapse (`pin-gate.ts:106-108`), 15s single-entry cache (`pin-gate.ts:116`), and registry-first persistence with proof gating (`workspace-pin.ts:32-107`). No contradiction between the Pin/Workspace domain docs and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* verifyHandshakePin has a production socket caller or is removed. Test-only security surface is forbidden.
* Dead getDb plus workspaces imports are removed. Resolver state stacks and restores outside tests.
* isWorkspaceManagementPath lives in a shared routing module. PUBLIC_PATHS shares the Auth health-exemption source.
* matchesWorkspacePin fan-out is capped. x-workspace-id allow-on-no-hash is an explicit threat-modeled contract. Authority: Pin, Auth, Workspace standards.
## Open gaps
- `verifyHandshakePin` has no verified production caller — live sockets authenticate via `socket-auth.ts` API-key modes, so handshake PIN coverage may be test-only or wired elsewhere unverified.
- `getDb` and `workspaces` are statically imported in `pin-gate.ts` but never referenced — dead imports suggesting an abandoned DB-direct path.
- `setWorkspacePinResolver` override is process-global mutable state with no stacking/restore outside tests — multi-tenant resolver conflicts unverified.
- `isWorkspaceManagementPath` is shared by the PIN gate and the tenant-DB hook as the security boundary but lives in `pin-gate.ts` — drift risk if either side forks the check.
- `PUBLIC_PATHS` duplicates the Auth gate's health exemption inline instead of sharing it — the two exempt sets could drift.
- `matchesWorkspacePin` fans out one async scrypt per workspace entry with no cap — cost under many-workspace fleets unverified.
- Whether `x-workspace-id` targeting can be spoofed to probe hash-less workspaces open (allow on no-hash) was not threat-modelled beyond code reading.
- No `listens` observed; whether any UI/socket layer reacts to lock set/clear beyond the next-request 401 was not traced.

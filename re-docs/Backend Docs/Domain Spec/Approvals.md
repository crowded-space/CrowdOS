# Approvals

## Purpose
Durable approval-request store for tool-use gating. It owns `approval_requests` rows, classifies risk, supports reusable scope-hash grants, guards decisions with an atomic pending-only claim, and sweeps past-TTL pendings to `expired` with default-deny run resume.

## Feature Scope
In-scope:
- Approval row CRUD + pending/reusable-grant lifecycle (`approval_requests` table).
- Risk classification (`mapVerdictToRiskClass`), args preview truncation, scope-hash computation.
- Atomic single-winner `decide` (`pending` → `approved`/`denied`) with reusable-grant expiry extension.
- Bulk TTL expiry (`pending` → `expired`) + per-workspace sweep that resumes `waiting_for_approval` runs and emits `approval.decided`.
Non-goals (other domains):
- Execution, pause-wait loop, event-driven wait + poll backoff → Tools (`tool-executor.ts` drives `createPending`, `waiting_for_approval`, `approval.requested` emits).
- Run state machine, checkpointing, orphan resume → Runs (`runsGate.getById`, `runsGate.transition`; Runs owns `runs` rows).
- Transport (REST/socket payloads, auth roles, rate limits) → Routes/Sockets (call `approvalGate`, never contain policy).
- Workspace sharding/DB routing → Workspace (`forEachWorkspaceDb` is borrowed, not owned).

## Expect
- `[Observed]` `decide` only succeeds from `pending`; non-`pending` or missing id returns `null`, never throws, never writes.
- `[Observed]` `decide` is single-winner under concurrency; the conditional `UPDATE ... WHERE status = pending RETURNING` claims first, loser gets `null`.
- `[Observed]` `approved` extends expiry to reusable TTL only on an explicit reuse request (reuse flag, legacy `scope:'reusable'` sentinel, caller-supplied scope key, or explicit `expiresAt`); a plain approval clears expiry so the row can never match `findReusableGrant` (AP-005). `denied` never extends expiry.
- `[Observed]` Expiry is bulk `UPDATE pending → expired` on `expiresAt < now`; callers must treat `expired` as denied (default-deny) and resume the run.
- `[Observed]` Reusable-grant lookup is per-requester first, global fallback second; both require `approved` + matching `(toolName, scope)` + `expiresAt > now`.
- `[Observed]` Reusable-grant lookup is strictly per-requester (AP-002 fixed: the cross-requester global fallback was removed); a hit requires `approved` + matching `(toolName, scope, requestedBy)` + `expiresAt > now`, otherwise the caller re-asks.
- `[Inferred]` `createRequest` default TTL is pending-TTL unless `status === approved`, which gets reusable-TTL; explicit `expiresAt` always wins.

## Flow
1. Classify + hash: `tool-executor.ts:405` maps Guard verdict to `riskClass` via `approvalGate.mapRisk`, builds truncated preview via `approvalGate.argsPreview` (`tool-executor.ts:406`, `approval-types.ts:109`), hashes `(tool, preview)` to 16-hex scope via `approvalGate.computeScopeHash` (`tool-executor.ts:410`, `approval-types.ts:65`).
2. Reusable fast path: executor checks `findReusableGrant(tool, scopeHash, requestedBy)` (`tool-executor.ts:415`, `approval-repository.ts:72`); on hit it writes an audit `createApproved` row with 1h expiry (`tool-executor.ts:418-426`, `approval-repository.ts:47`), emits `approval.requested` + `approval.decided` auto-approved (`tool-executor.ts:434-438`), and executes without pausing.
3. Pending create: on miss, executor builds `expiresAt = now + pendingTtl` and calls `createPending({ runId, toolName, argsPreview, riskClass, requestedBy, scope: scopeHash })` (`tool-executor.ts:451-460`, `approval-repository.ts:43`); repository defaults missing `expiresAt` to pending-TTL (`approval-repository.ts:18`).
4. Pause run: executor moves `running → waiting_for_approval` via `runsGate.transition` (`tool-executor.ts:468`); emits room-scoped `approval.requested` (`tool-executor.ts:478`).
5. Wait: executor blocks on broker `approval.decided` fast path plus exponential DB poll (`getById` per tick) until `approved`/`denied`/`expired`, abort, or TTL-plus-guard ceiling; on TTL lapse it resolves locally as `expired` without writing (sweeper owns expiry).
6. Decide: operator `POST /api/approvals/:id/decision` or `approval:decide` socket validates `pending` then calls `decide(id, { decision, decidedBy, scope, expiresAt })`; repository atomically claims, then optionally extends `(scope, expiresAt)` for `approved`.
7. Post-decision: route/socket/executor/sweeper all emit via the single `emitDecided()` helper and idempotently resume `waiting_for_approval → running`.
8. FS-tool variant: `write_file`/`delete_file`/`edit_file` read channel/workspace `requireApprovalFor` policy, check `findReusableGrant`, and on miss run the same `createPending → waiting → poll` loop with `destructive` risk.
9. Expiry sweep (sole owner): `sweepApprovalsOnce` fans out per workspace DB; per DB `expirePendingApprovals` runs single `UPDATE ... WHERE pending AND expiresAt < now RETURNING`; each expired row resumes its `waiting_for_approval` run to `running` and emits via `emitDecided()` with `decision: expired` + `workspaceId` tag.
10. Read/list: `GET /api/approvals?runId=` → `listByRun` newest-first limit 200 (`routes/approvals.ts:11`, `approval-repository.ts:67`); `GET /api/approvals/:id` → `getById` 404 on miss (`routes/approvals.ts:17`, `approval-repository.ts:52`); socket `approval:list` → same `listByRun` (`register-socket-server.ts:1166`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `approval-types.ts` | Pure policy/helpers, no I/O. `ApprovalRiskClass`/`ApprovalStatus`/`ApprovalRequest`/`CreateApprovalInput`/`DecideApprovalInput` types; `APPROVAL_PENDING_TTL_MS` (5min) + `APPROVAL_REUSABLE_TTL_MS` (1h) env parsing; `isApprovalsEnabled`, `computeScopeHash`, `mapVerdictToRiskClass`, `argsPreviewFromCommand` |
| `approval-repository.ts` | DB owner. `createRequest`/`createPendingRequest`/`createApprovedRequest`/`getById`/`findPendingByRun`/`listByRun`/`findReusableGrant`/`decide`/`expirePendingApprovals`/`sweepExpired`/`findPending` plus `ApprovalRow` type |
| `approval-gate.ts` | Thin facade, wire + re-export only, plus single `emitDecided()` emit helper. |
| `approval-sweeper.ts` | TTL reaper. `sweepApprovalsOnce` fan-out, `sweepOneDb` expire + default-deny resume + emit, `startApprovalSweeper` 5s-delay + 30s interval with `unref`, `stopApprovalSweeper` |
| Types (from `approval-types.ts:3`, `approval-types.ts:11`, `db/schema.ts:571`) | `ApprovalRiskClass` (`install/network/destructive/git_push/db_write/general`), `ApprovalStatus` (`pending/approved/denied/expired`), `ApprovalRequest` (full row shape), `CreateApprovalInput` (no id/timestamps), `DecideApprovalInput` (`approved/denied` + decidedBy + optional scope/expires) |

## Ports
- `ApprovalRow` — `approval_requests` record type.
- `ApprovalRequest` — approval request interface type.
- `ApprovalRiskClass` — risk class union type.
- `ApprovalStatus` — `pending | approved | denied | expired` type.
- `CreateApprovalInput` — creation input type.
- `DecideApprovalInput` — decision input type.
- `isApprovalsEnabled` — true only when `APPROVALS_ENABLED === true`.
- `computeScopeHash` — sha256 `(tool, argsPreview)` truncated to 16 hex.
- `mapVerdictToRiskClass` — Guard-reason + tool fallback to risk class.
- `argsPreviewFromCommand` — 500-char-truncated args preview or `null`.
- `APPROVAL_PENDING_TTL_MS` — pending TTL ms (default 5min).
- `APPROVAL_REUSABLE_TTL_MS` — reusable grant TTL ms (default 1h).
- `approvalGate.create` — inserts request with TTL defaulting by status.
- `approvalGate.createPending` — forces `status: pending`.
- `approvalGate.createApproved` — forces `status: approved` with reusable expiry.
- `approvalGate.getById` — fetch one row by id (`null` on miss).
- `approvalGate.findPending` — fetch one row by id only if `pending`.
- `approvalGate.findPendingByRun` — up to 200 `pending` rows for a run.
- `approvalGate.listByRun` — up to 200 rows for a run, newest first.
- `approvalGate.findReusableGrant` — unexpired `approved` grant by `(tool, scope, requester)` with global fallback.
- `approvalGate.decide` — atomic pending-only claim + optional reusable extension; `null` on loss/miss.
- `approvalGate.expirePendingApprovals` — bulk `pending → expired`, returns rows (sweeper-only owner).
- `approvalGate.sweepExpired` — same expiry, returns count.
- `approvalGate.sweepOnce` — 2026-09-25: queue-facing port, dynamic-imports `approval-sweeper.ts` (no static gate→sweeper→gate cycle); maintenance worker calls this, never the sweeper file.
- `emitDecided` — single `approval.decided` emit (sweeper + REST/socket + executor share one shape).
- `approvalGate.isEnabled` — alias of `isApprovalsEnabled`.
- `approvalGate.computeScopeHash` — alias of `computeScopeHash`.
- `approvalGate.mapRisk` — alias of `mapVerdictToRiskClass`.
- `approvalGate.argsPreview` — alias of `argsPreviewFromCommand`.

## Relations
Gates this domain calls:
- `runs-gate.ts` — `getById` for channel lookup + `transition` for default-deny resume (`approval-sweeper.ts:37`, `approval-sweeper.ts:37`); repository never touches `runs` directly.
- `event-broker-gate.ts` — `EventBroker` for `approval.decided` emits (`approval-sweeper.ts:44`); never subscribes in-domain.
- `workspace-gate.ts` — `forEachWorkspaceDb` for multi-DB sweep fan-out (`approval-sweeper.ts:12`).
- Non-gate internals used: `shared/config/database.ts` (`getDb`, `withTransaction`, `runWithDb`), `db/schema.ts` (`approvalRequests` def), dynamic `shared/sockets/register-socket-server.ts` (`globalBroker` room fan-out).
Known outside callers of `approvalGate`:
- Tools: `tools/tool-executor.ts` (mapRisk/argsPreview/computeScopeHash/findReusableGrant/createApproved/createPending/getById; never `expirePendingApprovals`).
- Routes: `routes/approvals.ts` (listByRun/getById/decide; the admin sweep route calls the gate's `sweepOnce` port, never the sweeper file — AGENTS.md §2 gate-only).
- Sockets: `Shared/sockets/register-socket-server.ts` (getById/decide/listByRun).
- Queue: `queue/maintenance-worker.ts` via `sweepOnce` (2026-09-25; was direct `approval-sweeper.js` import).
- Self: `approvals/approval-sweeper.ts` (sole `expirePendingApprovals` owner).
Tables shared with other domains (FK-owned reads):
- `runs.id` ← `approval_requests.run_id` cascade; Approvals reads runs only via `runsGate`, never writes them.

## Emits-Listens
- `approval.decided` (emits via single `emitDecided()` helper shared by sweeper/routes/sockets/executor)
- `approval.requested` (never emitted in-domain; emitted by Tools only)

## Owns
- `approval_requests` (writes: insert, `pending → approved/denied/expired` status + `decidedBy/decidedAt/scope/expiresAt` updates)

## Flags
- `APPROVALS_ENABLED` — `true` enables ASK→pause flow; anything else makes ASK throw/deny without creating rows (`approval-types.ts:61`, `tool-executor.ts:389`).
- `APPROVAL_TTL_MS` — preferred pending TTL override, falls back to `APPROVAL_PENDING_TTL_MS`, default 5min (`approval-types.ts:48`, `tool-executor.ts:447-449`).
- `APPROVAL_PENDING_TTL_MS` — pending TTL fallback when `APPROVAL_TTL_MS` unset (`approval-types.ts:48`).
- `APPROVAL_REUSABLE_TTL_MS` — reusable grant TTL, default 1h (`approval-types.ts:54`).

## Decisions
- `[Observed]` Atomic claim-first `decide` via conditional `UPDATE ... WHERE pending RETURNING` — why: concurrent operator + sweeper + poller expiry cannot double-decide.
- `[Observed]` Two-step `decide` (claim, then scope/expiry extension only when changed) — why: keeps the race window to one statement; second update is idempotent no-op when timestamps match.
- `[Observed]` Bulk single-statement expiry instead of per-row loop — why: one RTT sweeps all TTL lapses; per-row handling (resume + emit) happens after.
- `[Observed]` Default-deny resume (`waiting_for_approval → running` + tool-fail, never cancel/fail the run) — why: TTL lapse must unblock the run without implying success.
- `[Observed]` Per-requester reusable grant first, global fallback second — why: preserves requester isolation while honoring older global-grant interpretations.
- `[Observed]` Gate re-exports helpers (`computeScopeHash/mapRisk/argsPreview`) so Tools need no second import — why: single facade for classification + storage.
- `[Inferred]` Dynamic `import()` for `globalBroker` with fresh-`EventBroker` fallback — why: avoids gate-to-gate cycles and keeps the sweeper runnable without sockets booted.

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this. Poll-cadence docs must read 1s to 5s, not 400ms to 2000ms.
Atomic single-winner decide via conditional UPDATE WHERE status equals pending RETURNING. Operator, sweeper, and executor self-check converge on one claim; losers get null.
Expiry is bulk UPDATE pending to expired on expiresAt less than now, with default-deny run resume. Callers treat expired as denied.
Reusable-grant lookup is per-requester first, global fallback second. Both require approved plus matching tool and scope plus unexpired.
TTL defaults: pending-TTL unless status is approved, which gets reusable-TTL. Explicit expiresAt always wins.
All settlers emit via the single emitDecided helper with one shape. Parallel emit chains are forbidden.
Wait is event-plus-poll with a hard TTL-plus-guard ceiling. The executor holds one worker slot per wait by design; storms need explicit backpressure (see Q3).
Expired rows carry decidedAt plus a system decidedBy value, never null. Consumers may rely on non-null decider.
Scope sentinel values are explicit contracts or removed. Silent ignore-with-side-effect is not acceptable.
## User Decision (Open - awaiting operator choice)
Q1: Are hierarchical workspace and channel grants planned, or is the flat scope hash the contract?
Q2: What does calling the gate directly while disabled do - the gate enforces the kill-switch or documents that only the executor checks it?
Q3: Approval-storm backpressure - queue depth or per-workspace caps - or is slot-holding unbounded by design?
Q4: Confirm the canonical fallback poll is 1s to 5s and fix the stale 400ms to 2000ms pointers.
## Failure + Resume
- Missing row / non-`pending` decide → `decide` returns `null`; route maps to 404 (missing) or 409 (`already <status>`, concurrent loss) (`approval-repository.ts:129`, `routes/approvals.ts:43`); socket maps to `not_found` / `already_decided` / `decision_failed` (`register-socket-server.ts:1121`).
- `createPending` throw surfaces as tool error (`Failed to create approval request`) without pausing the run (`tool-executor.ts:462-463`); reusable-audit insert failure only warns and still executes (`tool-executor.ts:441-443`).
- Wait abort / row disappearance → executor resumes `running` and throws `approval_cancelled` / `approval disappeared — denying` (`tool-executor.ts:512-517`); `denied`/`expired` resumes `running` and fails the tool safely, run continues per APR-1 (`tool-executor.ts:540-545`).
- Sweep per-row failures warn-and-continue, never throw the batch (`approval-sweeper.ts:56-57`); timer uses `unref` so it never holds the process open (`approval-sweeper.ts:68-69`).
- Resume is explicit: decision path + sweeper both transition only when `status === waiting_for_approval`, so double-resume is a state-machine no-op (`routes/approvals.ts:81`, `approval-sweeper.ts:36-41`).
- Admin `POST /api/approvals/sweep` delegates to `approvalGate.sweepOnce` (AP-004): the sweeper fan-out flips statuses AND resumes `waiting_for_approval` runs via `stateGate` with `approval.decided` emits per row, returning `{ swept }` (`routes/approvals.ts:96`, `approval-gate.ts` `sweepOnce`). Drift fixed 2026-10-07: the route no longer imports `approval-sweeper.js` past the gate (gate-lint clean), and this line no longer claims flip-only semantics.

## Gaps
- `expirePendingApprovals` sets `decidedAt` but leaves `decidedBy` null on expiry; whether consumers require a non-null decider for `expired` rows is unverified.
- `findPending(approvalId)` duplicates `getById` + status filter with no distinct caller observed outside tests; intent (convenience vs legacy) unverified.
- `scope === reusable` sentinel is ignored for assignment but still extends expiry (`approval-repository.ts:135`); the literal `"reusable"` scope contract vs real scope-hash values is unverified.
- `isApprovalsEnabled`/`isEnabled` is defined but never called inside the domain; enforcement lives in `tool-executor.ts` env checks — gate-level kill-switch semantics unverified.
- No `listens` observed in-domain; whether any worker subscribes to `approval.decided` besides the transient `tool-executor.ts:137` waiter was not traced beyond emit sites.
- `argsPreview` 500-char truncation means `computeScopeHash` hashes the preview, not full args; near-identical large payloads colliding on truncated prefix is unverified.
- AP-003 fixed 2026-10-07: `sweepApprovalsOnce` now always sweeps the ambient `getDb()` handle in addition to registry workspace DBs, so single-DB deployments expire pendings; guarded by `src/approvals/approval-sweeper.test.ts` (hermetic, mocks DB/state/workspace/runs boundaries; pre-existing DB-gated integration files unchanged).
- AP-004 fixed 2026-10-07: `POST /api/approvals/sweep` delegates to `approvalGate.sweepOnce` (flip + default-deny resume + `approval.decided` emit) instead of flip-only `sweepExpired`; same test file asserts run resume + expired emit and that `sweepExpired` is never called by the route.
- Residual (not fixed here, outside AP-003/004 scope): `expirePendingApprovals` still leaves `decidedBy` null on expiry (AP-007), and the sweeper's ambient leg uses `catch {}` — a dead ambient DB is silent for this one target.
- AP-005 fixed 2026-10-07: `decide` extends to the reusable TTL only on an explicit reuse request (`reuse:true` or legacy `scope:'reusable'`) or explicit `expiresAt`; a plain approval of a scoped row keeps its own expiry — scope presence no longer silently mints a 1h grant. Guarded by `src/approvals/approval-decide.test.ts` (hermetic).
- AP-009 fixed 2026-10-07: socket `approval:decide`/`approval:list` now run inside the socket workspace handle (`runWithSocketWorkspace`, register-socket-server.ts:586) — split-DB decides no longer hit the global pool; local-only/unresolvable workspaces degrade unscoped with a `socket.approval.scope_degraded` warn. Guarded by the AP-009 case in `register-socket-server.test.ts`.
- Residual (AP-005/009 scope): AP-013 (double-lookup hot path) and the socket `scope:'reusable'` legacy passthrough remain; the socket decide does not forward a reuse flag (client socket path unused today).
- AP-016 fixed 2026-10-07: concurrent sweeps (API inline timer + worker timer, no leader election) converge by construction — the atomic bulk expire gives each row exactly one owner, and the runs CAS (`runsRepository.applyTransition` WHERE status=from) admits a single `waiting_for_approval → running` resume even when two sweeps flip disjoint rows of the same run; emits stay one `approval.decided` per flipped row. No advisory lock by design (comment `approval-sweeper.ts:10-18`). Guarded by the AP-016 overlap case in `src/approvals/approval-sweeper.test.ts` (hermetic; barrier forces the CAS collision).
- DB-004 fixed 2026-10-07: dead `approval_requests.scope_hash` + `approval_requests_scope_hash_idx` (0012, never read — code uses `scope`) dropped by migration 0028; `approval_grants.scope_hash` (different table, live) untouched. Guarded by `src/db/approval-scope-hash-drop.test.ts` (hermetic; live column/index checks DB-gated on DATABASE_URL).

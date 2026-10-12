# Approval decision flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
A tool call classified `ASK` must not execute (or fail) on the spot — the run pauses mid-execution, the pending request is durably recorded, and the run only continues once exactly one settler (operator, sweeper, or the executor's own expiry check) wins the race to decide it. This flow exists so the runtime timeline — verdict → pause → wait → single-winner settle → resume — is total: no hang, no double-decide, no lost wakeup.

## Architectural decision
The shape is three linked choices. First, the pause is a durable `pending` row plus a `running → waiting_for_approval` walk, never an in-memory sleep, so crashes and multi-worker setups see the same wait `[Observed]`. Second, the settle is an atomic single-winner claim (`UPDATE … WHERE status = pending RETURNING`, `approval-repository.ts:117-128`) because three settlers — operator decision, TTL sweeper, executor expiry check — can converge on the same row `[Observed]`. Third, the wait is event-plus-poll (broker `approval.decided` fast path, exponential DB poll fallback, TTL-plus-guard hard ceiling) because the executor deliberately holds one run-worker slot while waiting instead of suspend-and-resume (`tool-executor.ts:301-305`) — a missed event must still resolve, and the wait must always terminate `[Observed]`. Expiry resolves to default-deny with the run resumed to `running` (tool failed, run continues), never cancelled, so a lapsed TTL unblocks without implying success `[Observed]`.

## How it works
1. Guard returns `ASK` on the call (`tool-executor.ts:190-197`); the executor classifies risk, truncates an args preview, and hashes both into a scope (`tool-executor.ts:213-215`).
2. Reusable-grant fast path: on a live-grant hit the executor writes an audit `createApproved` row, emits `approval.requested` + `approval.decided` (auto-approved), and executes without pausing (`tool-executor.ts:220-250`).
3. On a miss the executor builds `expiresAt = now + pendingTtl` and creates the `pending` row via `createPending` (`tool-executor.ts:259-269`), walks the run `running → waiting_for_approval` (`tool-executor.ts:275-277`), and emits room-scoped `approval.requested` (`tool-executor.ts:283-285`).
4. The executor waits on both paths at once: a broker `approval.decided` subscription (`tool-executor.ts:137`) plus exponential DB poll (`getById` per tick, 1s → 5s), bounded by a `TTL + 2000` expiry check (`tool-executor.ts:384`) and a `TTL + 2500` unref guard (`tool-executor.ts:423`).
5. An operator settles from Routes or Sockets (`POST /api/approvals/:id/decision`, `approval:decide`), which validates `pending` then calls the atomic `decide` (`routes/approvals.ts:42-46`, `approval-repository.ts:117-128`); losers of the claim get `null` (mapped to 404/409 or `already_decided`).
6. The decision path emits `approval.decided` with `runId/approvalId/tool/decision/decidedBy/scope/riskClass` (`routes/approvals.ts:66-72`) and idempotently resumes `waiting_for_approval → running` only when that state still holds (`routes/approvals.ts:81`); the executor wakes on the event (or the next poll tick) and executes on `approved`, or resumes `running` + fails the tool on `denied`/`expired` (`tool-executor.ts:455-474`).
7. If nobody decides, two expiry paths converge: the executor's own TTL check (`tool-executor.ts:384-406`) and the Approvals sweeper (30s timer + Queue `approval-expire` repeatable), which bulk-flips lapsed rows `pending → expired`, resumes their runs default-deny, and emits `approval.decided` with `decision: expired` (`approval-sweeper.ts:20-42`).
8. The filesystem variant (`write_file`/`delete_file`) runs the same `createPending → waiting → wait` loop after consulting channel/workspace `requireApprovalFor` policy (default `delete,execute`) (`tool-executor.ts:490-559`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Tools.md> | Owns the wait: ASK detection, grant fast path, pending create, `waiting_for_approval` walk, event-plus-poll wait, execute-or-fail on settle |
| <../Domain Spec/Approvals.md> | Owns the rows: risk/scope helpers, atomic `decide`, bulk expiry, per-workspace sweeper with default-deny resume |
| <../Domain Spec/Runs.md> | Owns the `running ↔ waiting_for_approval` edges and excludes that state from the orphan sweep |
| <../Domain Spec/Queue.md> | Fires the `approval-expire` repeatable that drives `sweepApprovalsOnce` in bullmq mode; never decides |
| <./Approval lifecycle.md> | Owns the policy/grants machinery (risk classes, scope-hash grants, TTL defaults, kill-switch) — see that doc, not duplicated here |
| <./Recovery and resume.md> | Owns the parallel wait path the orphan sweep must not touch (`waiting_for_approval` exclusion) — see that doc for crash recovery |

## Current state
Real: bash `ASK` pause flow, reusable-grant fast path with audit row, atomic decide, bulk TTL expiry with default-deny resume, per-workspace sweeper on a 30s timer, broker-plus-poll wait with a hard ceiling, `APPROVALS_ENABLED` kill-switch defaulting to deny. The executor holds one run-worker slot per wait by design. Stub: the FS path's hierarchical `findGrant` probe always misses (no such gate port) and falls through to flat `findReusableGrant`; the `edit_file` branch is wired but no such tool is registered.

## Alignment notes
Cross-checked the three domain docs against the cited code; timeline claims verified: grant fast path (`tool-executor.ts:220-250`), pending create + pause walk (`tool-executor.ts:259-277`), dual-path wait (`tool-executor.ts:137`, `tool-executor.ts:384`, `tool-executor.ts:423`), atomic claim (`approval-repository.ts:117-128`), decision emit + guarded resume (`routes/approvals.ts:66-81`), sweeper bulk-expiry + resume + emit (`approval-sweeper.ts:20-42`). One drift found, minor and shared with `Approval lifecycle.md`: `Approvals.md` Flow §5 says the fallback poll runs "400ms → 2000ms", but the code runs 1s → 5s (`tool-executor.ts:321`, `tool-executor.ts:189-193`) — the Tools doc number is correct. No behavioral contradiction; pointer only.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in the linked domain specs.
* Pause is a durable pending row plus running to waiting_for_approval walk, never in-memory sleep.
* Settle is atomic single-winner claim via conditional UPDATE WHERE pending. Losers get null.
* Wait is event-plus-poll with hard TTL-plus-guard ceiling. Waits always terminate.
* Expiry resolves default-deny with run resumed to running. Tool fails, run continues.
* Authority: Approvals, Tools, Runs domain standards. This flow does not duplicate rules.
## Open gaps
- Whether the held worker slot under concurrent approval storms needs backpressure (queue depth, per-workspace caps) is unverified — suspend-and-resume was deliberately skipped.
- Which settler won a raced row (operator vs sweeper vs executor self-expiry) is not recorded on the row — audit trail shows the outcome, not the winner.
- Admin `POST /api/approvals/sweep` flips statuses without resuming runs; affected runs depend on live pollers or the next sweeper pass — resume latency there is unverified.
- Expiry rows carry `decidedAt` but null `decidedBy`; whether any consumer requires a non-null decider is unverified.
- Whether anything subscribes to `approval.decided` beyond the transient per-wait handler and socket fan-out is unverified.

# Approval lifecycle
> Type: Feature · Status: aligned · Updated: 2026-09-14

## Intent
Some tool calls (risky shell commands, destructive file writes) should not run on the agent's say-so alone, so the system pauses the run, records exactly what was about to happen, and waits for a human to approve or deny it — with time itself counting as a denial so a run can never hang forever waiting for someone who never answers.

## Architectural decision
Risky tools pause instead of failing outright because the common case is "yes, do it" and the operator has full context to decide [Inferred]. The pause is recorded as a durable row rather than held in memory, so crashes, restarts, and multi-worker setups all see the same pending request [Observed]. The decision itself is an atomic single-winner claim (`UPDATE … WHERE status = pending RETURNING`, `approval-repository.ts:120`) because the operator and the TTL sweeper can race to settle the same row [Observed]. Expiry is sweeper-only (executor never writes expiry; it resolves locally and lets the sweeper persist) and resolves to default-deny with the run resumed to `running` (tool failed, run continues) rather than cancelled [Observed]. All `approval.decided` emits go through the single `emitDecided()` helper (sweeper + REST/socket + executor share one shape) [Observed].

## How it works
It starts in Tools: `tool-executor.ts` evaluates the call through `Guard`, and on an `ASK` verdict with approvals enabled it classifies risk, truncates an args preview, and hashes both into a scope (`tool-executor.ts:405`). Still in Tools, it checks Approvals for a live reusable grant and auto-executes with a fresh audit row when one hits. On a miss it creates a `pending` approval row via Approvals, walks the run `running → waiting_for_approval` via Runs, and emits `approval.requested` for observers. The executor then waits on two paths at once: a broker `approval.decided` subscription as the fast path and an exponential DB poll as the fallback, bounded by a TTL-plus-guard ceiling. A human settles the row from Routes or Sockets (`POST /api/approvals/:id/decision`, `approval:decide`), which calls the atomic `decide` in Approvals and emits `approval.decided`; both the route/socket layer and the executor idempotently walk the run back `waiting_for_approval → running` when that state still holds. If nobody decides in time, two expiry paths converge: the executor's own TTL check and the Approvals sweeper (`approval-sweeper.ts`, fanned out per workspace DB and fired every 30s directly and via Queue's `approval-expire` repeatable), which bulk-flips lapsed rows to `expired`, resumes their runs default-deny, and emits `approval.decided` with `decision: expired`. The filesystem variant (`write_file`/`delete_file`) follows the same shape but consults channel/workspace `requireApprovalFor` policy first, defaulting to `delete,execute`.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Approvals.md> | Owns `approval_requests` rows, risk/scope helpers, atomic decide, bulk expiry, sweeper with default-deny resume |
| <../Domain Spec/Tools.md> | Requests approvals, pauses on `waiting_for_approval`, waits event-plus-poll, executes or fails the tool on settle |
| <../Domain Spec/Runs.md> | Owns the run state machine; exposes the `running ↔ waiting_for_approval` edges and excludes that state from orphan sweep |
| <../Domain Spec/Queue.md> | Fires the `approval-expire` repeatable that drives `sweepApprovalsOnce` in bullmq mode; never decides policy itself |

## Current state
Real: bash + FS `ASK` pause flows, reusable-grant fast path with audit row, atomic decide, sweeper-only bulk TTL expiry with default-deny resume, per-workspace sweeper on a 30s timer, broker-plus-poll wait, single `emitDecided()` emit, `APPROVALS_ENABLED` kill-switch defaulting to deny. Dead code removed: executor self-expiry, `findGrant` probe (flat `findReusableGrant` only), `edit_file` is a registered native tool.

## Alignment notes
- Sweeper-only expiry + `emitDecided()` (2026-09-14): executor self-expiry, triple emit chains, and `findGrant` probe removed; three settlers (executor/REST+socket/sweeper) share one emit helper.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in the linked domain specs.
* Atomic single-winner decide stays. Operator, sweeper, and executor self-check converge on one claim.
* Bulk TTL expiry pending to expired with default-deny resume stays. Expired is denied.
* All settlers emit via single emitDecided helper with one shape. Parallel emit chains are forbidden.
* Expired rows carry decidedAt plus system decidedBy, never null.
* Authority: Approvals domain standard. This flow does not duplicate rules.
## Open gaps
- Whether hierarchical `(workspace, channel)` grants are planned or the `findGrant` probe is dead code; the FS fast path depends on the answer.
- Whether consumers require a non-null `decidedBy` on `expired` rows (expiry sets `decidedAt` but leaves `decidedBy` null, `approval-repository.ts:164`).
- The `scope === "reusable"` sentinel contract in `decide` (`approval-repository.ts:135`): ignored for assignment yet still extends expiry — intent unverified.
- Gate-level kill-switch semantics: `isEnabled` is exported but enforcement lives in the executor's env checks; what calling the gate directly while disabled should do is unverified.
- Whether anything subscribes to `approval.decided` beyond the transient per-wait handler and socket fan-out.
- Truncated-preview hashing: `argsPreview` is 500-char truncated before `computeScopeHash`, so near-identical large payloads sharing a prefix may collide — collision handling unverified.

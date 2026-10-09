# Approvals Domain — Ordered Fix Plan (audit-derived; READ-ONLY audit, no production edits made)

Constraints: preserve facade contract (additive ports only); main-only; no auto-commit; code + docs same task (AGENTS.md §6). Rollback = revert commit (no schema destructive steps until step 6 is operator-approved).

## Rewrite decision: INCREMENTAL (prefer incremental)
Rationale: the domain is small (4 source files), the core invariants (atomic decide, bulk expiry, single emit helper) hold, and the bugs found are localized (fallback filter, dead fan-out mode, sentinel semantics, dead routes/schema drift). A rewrite would risk the frozen facade used by Tools/Routes/Sockets/Queue. Incremental fixes with characterization tests first.

## Ordered plan

1. **AP-003 — sweeper single-DB fan-out** (files: `approval-sweeper.ts` `sweepApprovalsOnce`; symbols: `forEachWorkspaceDb` target assembly). Fix: always include `getDb()` as a sweep target (runWithDb(getDb(), sweepOneDb)) in addition to workspace DBs, dedupe handles. Tests: TG-04. Compat: none (internal). Migration: none. Rollback: revert. Verify: integration single-DB expiry. DoD: sweepOnce expires global-DB pending rows.
2. **AP-004 — admin sweep resume/emit** (files: `routes/approvals.ts` POST /sweep). Fix: call `approvalGate.sweepOnce(broker)` (or return expired rows from sweepExpired and resume/emit each) instead of bare count. Tests: TG-05. Compat: response keeps `{ swept }` (additive). Verify: waiting run resumed + expired emit. DoD: sweep leaves no waiting run for expired rows.
3. **AP-002 — grant fallback scoping** (files: `approval-repository.ts` `findReusableGrant`). Fix: delete global fallback (or add workspace/requester scoping; operator Q1). Tests: TG-02. Compat: behavior change — gate to operator first (fail-closed). Docs: Domain Spec Approvals Q1 + Feature/Flow open gap same task. DoD: cross-requester reuse no longer possible (or explicitly documented as intended if operator says so).
4. **AP-001/AP-005 — reusable sentinel contract** (files: `approval-types.ts` DecideApprovalInput, `approval-repository.ts` decide, `ApprovalCard.tsx`). Fix: explicit `reuse?: boolean` (or mode) separate from `scope`; server requires real scope-hash for grant creation; UI sends row's scope + reuse flag. Tests: TG-03, TG-10. Compat: keep `scope:'reusable'` accepted as deprecated alias for one release. DoD: grant-for-session produces a matchable grant for null-scope rows too.
5. **AP-007/AP-008 — expiry hygiene** (files: `approval-repository.ts`). Fix: expiry sets `decidedBy:'system:ttl'`; reject/flag `expiresAt:null` on create. Tests: TG-14, TG-08. Compat: additive decidedBy; null-expiry now rejected (check callers — none pass null today). DoD: expired rows non-null decider; no un-expirable pendings.
6. **AP-006 — schema/migration convergence** (files: `db/schema.ts` + migration 0025). Fix: add the five 0012 columns to schema.ts OR drop unused ones (scope_hash/workspace_id/channel_id/thread_id unused by code today; scope_type unused) via idempotent migration; keep `scope`. Operator decision (dropping is destructive → prefer documenting/adding to schema). Tests: drizzle-kit generate empty diff. DoD: schema.ts matches DB.
7. **AP-015 — dead grants surface** (files: `routes/safety.ts` + `approval_grants`). Fix: delete file + table (operator) or register route through gate with auth. Tests: TG-12. DoD: no gate bypass surface; check-gates clean.
8. **AP-009 — socket tenant scoping** (files: `register-socket-server.ts` approval:decide/list; `approval-repository.ts` optional workspaceId params). Fix: run handlers under `runWithDb(getWorkspaceDb(identity.workspaceId).db)` when source==='workspace'. Tests: TG-06. Compat: additive optional params. DoD: socket decide works in split-DB.
9. **AP-011 — boundary cleanup** (files: `approval-gate.ts`, `approval-sweeper.ts`, `create-app.ts`, `worker.ts`). Fix: restructure so gate can statically re-export `startApprovalSweeper`/`stopApprovalSweeper` (move sweeper's gate dependency to repo-level functions passed in, or split emit helper), then remove both check-gates allowlist entries. Tests: check-gates 0/0. DoD: no allowlisted bypass for approvals.
10. **AP-014 — TTL single source** (files: `approval-types.ts`, `tool-executor.ts` inline parse). Fix: export one parser; executor uses gate constant. Tests: TG-01 parity. DoD: one TTL authority.
11. **AP-010/AP-012/AP-013/AP-016/AP-017/AP-018 — cleanup batch** (channelId sentinel removal, dead ports decision, perf note, concurrency doc, emit decidedBy, worker-broker note). Low risk, docs + small diffs.

## Docs to update in the same tasks (AGENTS.md §6)
- `re-docs/Backend Docs/Domain Spec/Approvals.md`: Ports table (remove dead ports if step 11 removes them; add reuse mode), Q1 answer (AP-002), Target expired-decider row (AP-007), gap list refresh, line refs.
- `re-docs/Backend Docs/Feature and Flow Spec/Approval lifecycle.md`: open gaps (fallback, sentinel, socket scoping, sweep fan-out), alignment note.
- `Feature and Flow Spec/_flow-index.md` if links change (no change expected).

## Explicitly out of scope (read-only audit)
No production edits were made; no branch created; no commit. Baseline commands only.

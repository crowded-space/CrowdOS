# Runs Domain — Phase 7 Implementation Plan Proposal (no implementation this turn)

Constraint summary: preserve the facade contract exactly (18 ports, same names/signatures/return semantics unless a step says otherwise); AGENTS.md flow — finish → checks → stop → ask user to review → ask `commit?` → commit only on explicit yes; docs updated in the same task as code (AGENTS.md §6); no branch, main only.

## Architecture assessment (A–E classification per problem)

- **RUN-001 errorCode clobbering** — **B (bug, small fix)**: one-line write-policy change + contract note + unit test. No interface change.
- **RUN-002 cancel partial hop** — **B**: return-first-hop / retry-second-hop decision; port return type unchanged (`RunRow | null`). Unit test only.
- **RUN-003 coding-runtime journal order** — **B**: reorder two statements in two handlers (Runtime-owned files; cross-domain change, coordinate with Runtime).
- **RUN-004 journal observability** — **C (smell + observability gap)**: add a warn/metric at call sites; no contract change.
- **RUN-005 truncated type drift** — **B**: additive type field; zero wire change.
- **RUN-006 resume delivery visibility** — **D (transport redesign, small)**: additive response field `delivery`; keep 200 + existing fields for compat. Routes/Sockets-owned; coordinate.
- **RUN-007 workspaceId threading** — **D (cross-cutting, needs design)**: either thread workspaceId through executor/state-gate/resume/undo, or resolve the DB handle from the run row inside the repository. Touches Runtime, State, Routes, Sockets, Approvals. Must ship with characterization first. Highest-blast-radius item.
- **RUN-008/RUN-025 throw-vs-null contract** — **C**: decide one policy and document it in the Domain Spec `Expect` section; normalize only if the decision is "null".
- **RUN-009 dead ports** — **E (intentional legacy)**: keep; pin with tests (G-12) before any removal decision; removal is an operator decision.
- **RUN-010 checkpoint on terminal** — **C**: optional status guard; low value; document first.
- **RUN-011 wedged-but-heartbeating run** — **D (new capability)**: stall detection / max-age alert; requires telemetry design; defer.
- **RUN-012 cost-ledger direct read** — **C**: add a narrow read port (`listByIds`) or accept and document; cheap either way.
- **RUN-013 deleteCompensation scope** — **B**: additive `(runId, compId)` port; keep old for compat; low risk.
- **RUN-014/RUN-031 research children** — **B/C**: heartbeat children or make them non-swept; stop enqueuing trace children on the executable queue (worker filter or marker). Runtime-owned; coordinate.
- **RUN-015 sweep lock pattern** — **C**: wrap in withTransaction or reword comment; correctness currently held by CAS.
- **RUN-016 missing (status, updated_at) index** — **B (migration)**: additive, idempotent index migration; low risk.
- **RUN-017 status parity** — **B**: type-level assertion only.
- **RUN-018 checkpointSeq / RUN-019 historyRef** — **E (open operator questions)**: resolve Q4/Q2 with the operator; no code until answered.
- **RUN-020/RUN-021 emit robustness/typing** — **B**: warn on emit failure; type the payloads; no schema change.
- **RUN-022 env clamp warnings** — **B**: one-line warn.
- **RUN-023 surrogate truncation** — **B**: code-point slice; unit test.
- **RUN-024 list-broadcast** — **C**: change socket emit scope for the read path only.
- **RUN-026/RUN-030 worker adopt/backlog duplicate** — **B/D**: status guard at worker adopt (small) + threshold/env decision (design). Runtime/Queue-owned; coordinate.
- **RUN-027/RUN-029 doc drift** — **B (docs-only)**.
- **RUN-028 DDL default** — **B (migration)**: alter default to 'created'.

Overall: **incremental refactor (option 2)**. The domain core (state machine + CAS transition + atomic checkpoint merge + refusal-first undo) is sound and well-tested; defects cluster in boundary handling (errorCode, cancel hops, worker adopt) and cross-domain threading (RUN-007). No evidence supports a rewrite.

## Rewrite decision (options 1/2/3)

1. **Status quo + docs only** — rejected: RUN-001/002/003/026/031 are real defects with cheap fixes; leaving them means silent misbehavior.
2. **Incremental refactor (RECOMMENDED)** — scope: fix confirmed S1/S2 bugs in-place, pin with tests, keep every port contract byte-compatible, one migration (index) + one migration (default), docs synced. Risk: low–medium (RUN-007/026/031 touch Runtime/Queue; stage separately). Benefit: closes silent failure modes without contract churn.
3. **Rewrite the domain** — rejected: the choke-point design, CAS loop, atomic checkpoint merge, refusal-first undo, and sweep self-heal are load-bearing and covered by 26 passing tests + 9 DB-integration tests; a rewrite would recreate exactly the boundary bugs listed here with zero evidence of a structural gain.

## Ordered implementation plan (next turn onward)

All steps: no branch, main only; each step = code + in-domain tests + doc update in the same task; stop for live review before commit.

### Step 0 — Preconditions (no code)
1. Re-run baseline: `cd packages/server && npx vitest run src/runs` and `npx tsc --noEmit` (expect 26 passed / 9 skipped / exit 0).
2. Ask the operator: (a) RUN-007 approach (thread workspaceId vs resolve-from-row) and its deployment reality; (b) Q4 checkpointSeq removal; (c) RUN-009 dead-port removal; (d) RUN-030 threshold decision. Record answers in `re-docs/Backend Docs/Domain Spec/Runs.md` User Decision.

### Step 1 — errorCode write policy (RUN-001) — files: `runs/runs-repository.ts` (`applyTransition`), `runs-gate.ts` (doc comment only)
- Change: write `errorCode` only when the option key is present (undefined = leave; null = explicit clear). Keep all signatures.
- Tests: extend `runs/apply-transition.test.ts` (G-02).
- Docs: `Domain Spec/Runs.md` Expect + Failure sections; `contracts.md` row 7 updated (audit file).
- Compat: no wire/stored change (field already nullable).
- Verification: `npx vitest run src/runs` green.

### Step 2 — cancel two-hop outcome (RUN-002) — files: `runs/runs-repository.ts` (`cancelRun`)
- Change: on hop-2 rejection, return hop-1 row (status `cancelling`) instead of null; document; keep null only for hop-1 rejection.
- Tests: new `runs/cancel.spec.test.ts` (G-01).
- Docs: Runs.md Ports (cancel semantics), contract matrix row 4.

### Step 3 — compensation type + truncation hardening (RUN-005, RUN-023) — files: `db/schema.ts` (additive `truncated?: boolean`), `runs/runs-repository.ts` (`buildCompensationInverse`)
- Change: type field + code-point-safe slice; drop the `as CompensationInverseOp` cast.
- Tests: `checkpoint.test.ts` boundary (G-10), type parity compile.
- Compat: additive JSONB field already written; no stored-format change.

### Step 4 — journaling observability + ordering (RUN-003, RUN-004) — files: `runtime/runtimes/coding-runtime.ts` (reorder), `tools/tool-registry.ts` + `coding-runtime.ts` (warn on null result), optional small helper in runs
- Coordinate with Runtime/Tools owners (cross-domain files; runs only owns the helper).
- Tests: G-03 ordering test; G-16 characterization.
- Docs: Compensation undo flow.md drift fixes (RUN-027 part).

### Step 5 — worker adopt guard (RUN-026) — files: `runtime/runtime-executor.ts` (refuse non-executable statuses)
- Change: when a requested run exists in `failed`/`cancelled`/`completed`/`resumable` without resumeContext → throw (existing throw path) instead of log-and-reuse.
- Tests: G-04 (executor/worker level).
- Docs: Runtime.md + Recovery and resume.md gap update.

### Step 6 — research child hardening (RUN-014, RUN-031) — files: `runtime/runtimes/research-runtime.ts` (do not enqueue trace children on the executable queue; heartbeat or exempt children)
- Coordinate with Runtime/Queue owners; decide queue-filter vs marker in Step 0.
- Tests: G-18.

### Step 7 — resume delivery visibility (RUN-006) — files: `routes/runs.ts`, `shared/sockets/register-socket-server.ts`
- Change: additive `delivery: "queued" | "inline" | "failed"` (+ reason) on responses/acks; keep 200 + existing keys.
- Tests: G-13.
- Compat: additive only; client ignores unknown fields.

### Step 8 — RUN-007 workspace threading (design-gated by Step 0 answer)
- Option 8a (preferred if split-DB is real): thread `workspaceId` — executor passes its `workspaceId` into `stateGate.applyRunTransition` input (already typed but unused) and into `getById`/`touchRunHeartbeat`/`touchCheckpoint`; `resumeRun`/`undoCompensation` pass `run.workspaceId` after the first lookup; state-gate forwards it to `runsGate.transition`.
- Option 8b (smaller): repository resolves the handle from the run row when workspaceId is absent (single extra lookup) — keeps callers untouched.
- Either way: characterization test G-05 first (pin current behavior), then the fix with the same test flipped to the new guarantee.
- Docs: Runs.md Gaps, `shared/config/database.ts` comment correction (owner: Workspace), Recovery and resume.md.

### Step 9 — migrations (RUN-016, RUN-028) — files: new `db/migrations/00XX_runs_index_and_default.sql`
- `CREATE INDEX IF NOT EXISTS runs_status_updated_idx ON runs (status, updated_at);` + `ALTER TABLE runs ALTER COLUMN status SET DEFAULT 'created';`
- Safe: additive + default change matches all code paths; rollback = drop index / restore default.
- Verification: `npm run db:push` (or drizzle-kit migrate) on a dev DB; integration suites re-run with DB.

### Step 10 — docs-only drift batch (RUN-027, RUN-029) — files: three `re-docs` docs + schema comment
- Update stale claims and line refs; add RUN-029 comment on delegations child FK; update `_index.md`/`_flow-index.md` only if links change.

### Step 11 — type/emit polish (RUN-017, RUN-020, RUN-021, RUN-022, RUN-024)
- Static parity assertion; typed emits (drop `as never`); warn on emit failure; warn on env clamp; socket list emit scope.
- Tests: G-06, G-07, G-11, G-17, G-20.

### Step 12 — cleanup decisions (RUN-009, RUN-013, RUN-018, RUN-019, RUN-012) — only on operator answers
- Additive `deleteCompensation(runId, compId)` if approved; checkpointSeq removal only if Q4 confirmed; historyRef decision; cost-ledger port if approved.

## Rollback / migration notes

- All steps except Step 9 are code-only; rollback = revert commit (no stored-format change anywhere).
- Step 9 migrations are additive/idempotent; rollback SQL provided above. No data rewrite.
- Step 8 changes routing behavior; ship behind the characterization test and re-run the two integration suites against two real DBs.

## Definition of Done (per step)

1. Contract preserved: `runs-gate.ts` exports unchanged (except explicitly additive types).
2. `cd packages/server && npx vitest run src/runs` green; `npx tsc -p tsconfig.json --noEmit` exit 0; `node scripts/check-gates.mjs` and `check-events.mjs` exit 0.
3. Ledger row(s) flipped to `Fixed` in `audit/domains/runs/bug-ledger.csv` with the test that pins it.
4. Docs updated in the same task (Domain Spec + flow doc + `_flow-index.md` if links change).
5. Stop for operator live review; commit only on explicit `yes` via the git-crow flow (main only).

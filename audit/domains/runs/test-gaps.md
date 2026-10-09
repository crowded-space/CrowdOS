# Runs Domain — Phase 4 Test Baseline + Gap Register (read-only audit, 2026-10-06)

## 1. Baseline (exact commands + results)

| Command (cwd: `packages/server`) | Result |
| --- | --- |
| `npx vitest run src/runs --reporter=verbose` | **4 files passed, 2 skipped; 26 passed, 9 skipped (35 total)**; duration 9.78s |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 (no diagnostics) |
| `node scripts/check-gates.mjs` | exit 0; 0 violations; 46 TEST-ONLY cross-domain test imports (4 touch runs: approvals×2 files, artifacts, shared/core) |
| `node scripts/check-events.mjs` | exit 0; 0 violations |

Per-file results:

| File | Tests | Result | Notes |
| --- | --- | --- | --- |
| apply-transition.test.ts | 4 | pass | CAS retry, illegal, no-op via scripted DB mock |
| run-state-machine.test.ts | 13 | pass | full map walk, terminal immutability, dead-end guard |
| checkpoint.test.ts | 4 | pass | orphan edges + inverse builder incl. truncation |
| runs-service.test.ts | 4 | pass | undo refusal paths (not-found, truncated, unknown op, hash mismatch) |
| resume.integration.test.ts | 5 | **skipped** | `DATABASE_URL` unset → suite skip (probe validates enum/column/table first) |
| runs-repository.integration.test.ts | 4 | **skipped** | `DATABASE_URL` unset → suite skip |

Skipped tests are gated on a live dev Postgres + applied migrations 0003/0007 (enum + checkpoint column + compensation table). They are characterization-ready but not exercised in CI-as-run-here.

## 2. Existing coverage map (what is actually pinned)

- State machine: every declared edge, representative illegal edges, terminal immutability, same-state no-op, unknown-state rejection, dead-end freedom. Strong.
- applyTransition: CAS retry-once semantics, null on illegal, changed=false no-op, null after double loss. Strong (mock level).
- Compensation inverse builder: delete/restore/hash/truncation flag. Adequate.
- undoCompensation: all four refusal paths keep the row. Adequate for refusals.
- Integration (when DB present): checkpoint merge monotonicity + union dedupe, journal ordering, sweep two-hop + resume single-use, pending-threshold behavior, full transition chain durability, terminal immutability at SQL level, cancel walk, fail error code.

## 3. Gap register (what must be added — no tests written in this turn)

Priority P0 = protects a confirmed S1/S2 ledger bug; P1 = contract/invariant pin; P2 = hardening.

| # | Pri | Gap | Ledger link | Proposed test (file) | Type |
| --- | --- | --- | --- | --- | --- |
| G-01 | P0 | `cancelRun` second-hop rejection: outcome when the row is left `cancelling` | RUN-002 | `runs/cancel.spec.test.ts` (scripted db like apply-transition.test.ts) | characterization + regression |
| G-02 | P0 | `errorCode` stickiness across a subsequent reason-only transition | RUN-001 | `runs/apply-transition.test.ts` (extend scripted rows with errorCode) | contract |
| G-03 | P0 | coding-runtime journal-before-mutate ordering (currently after) | RUN-003 | `runtime/runtimes/coding-runtime.compensation.test.ts` (mock fs + runsGate spy, assert call order) | invariant |
| G-04 | P0 | Worker must not execute a run whose status is terminal/resumable (adopt refusal) | RUN-026, RUN-030, RUN-031 | `queue/run-worker.guard.test.ts` (stub runtimeGate, job with failed runId) | regression |
| G-05 | P0 | Threaded create + unthreaded read split-DB behavior (document today; pin after fix) | RUN-007 | integration: two DBs (`runs-routing.integration.test.ts`) | characterization → regression |
| G-06 | P1 | `resumeRun` emit contract: exactly one emit when changed; zero when changed=false; warn when no broker | INV-37, RUN-020 | `runs/resume-emit.test.ts` (mock repo + broker spy) | contract |
| G-07 | P1 | Sweep emit contract: one emit per hop, two for live rows, self-heal emits, none when CAS loses | INV-44, RUN-015 | `runs/orphan-sweep-emit.test.ts` (scripted db + broker spy) | contract |
| G-08 | P1 | Checkpoint on terminal row: documented behavior (currently allowed) | RUN-010 | extend integration `checkpoint after terminal` | characterization |
| G-09 | P1 | `undoCompensation` success path: Guard called, fs applied, row deleted, entries returned; delete inverse tolerates ENOENT | INV-22/23 | `runs/undo-success.test.ts` (mock channelMountGate + Guard + fs) | contract |
| G-10 | P1 | Truncation boundary: >20k flag stored and refused at undo; exactly 20k not flagged | INV-19, RUN-023 | extend `checkpoint.test.ts` boundary cases | boundary |
| G-11 | P1 | `RunStatus`/`RunState` static equality | RUN-017 | type-level test `runs/status-parity.type-test.ts` | type |
| G-12 | P1 | `listRunsByStatus` + `complete`/`fail`/`cancel` port behavior (dead ports must stay pinned before refactor) | RUN-009 | `runs/legacy-ports.test.ts` | contract |
| G-13 | P1 | Resume delivery-failure visibility (route 200 + delivery flag) | RUN-006 | `routes/runs.resume-delivery.test.ts` (inject throwing queueGate) | contract |
| G-14 | P2 | Sweep concurrency: two concurrent sweeps, one row → exactly one transition per hop | RUN-015 | integration concurrency test | concurrency |
| G-15 | P2 | Compensation seq race: concurrent addCompensation → unique seqs, retry works | INV-17 | integration concurrency test | concurrency |
| G-16 | P2 | `addCompensation` ignores workspace context (today) — pin as characterization before threading change | RUN-004 | scripted db asserting resolveWriteDb() called with no arg | characterization |
| G-17 | P2 | Emit payload schema parity for resume/sweep (`as never` casts today) | RUN-021 | payload-shape assertion vs RunStatusChangedEventPayload keys | schema |
| G-18 | P2 | Research child runs: no heartbeat, sweep interplay, bullmq duplicate execution | RUN-014, RUN-031 | integration (slow child + sweep) + worker test | regression |
| G-19 | P2 | `historyRef` round-trip (today: stored/ferried only) | RUN-019 | characterization: set + read back through resume | characterization |
| G-20 | P2 | Auth/isolation: socket role gates for resume (operator) and compensations (admin) | contract §Transport | socket tests already partially exist in register-socket-server.test.ts — extend with runs-specific cases | auth |

## 4. Test-infrastructure notes

- The domain unit tests use a scripted-db mock pattern (`apply-transition.test.ts:6-40`) and module mocks (`runs-service.test.ts:3-11`). Extending these files is cheap and stays in-domain (allowed to import internals).
- Integration tests skip cleanly without `DATABASE_URL`; run them with a local dev DB + migrations to get the real coverage (currently unexercised in this environment).
- Cross-domain test files that touch runs internals (approvals, artifacts) are flagged TEST-ONLY by `check-gates`; when refactoring, route them via `runs-gate` or move runs-specific setup into the runs domain.
- `fileParallelism: false` in `vitest.config.ts` — suite runs serially; concurrency tests need explicit in-test parallelism (Promise.all) rather than vitest workers.

## 5. Definition-of-done for the next turn's test work

1. G-01…G-05 written and passing (each fails against current code where it pins a confirmed bug).
2. Baseline command re-run: `npx vitest run src/runs` stays green; integration suites re-run with a DB at least once locally.
3. New tests never import past the gate from another domain; in-domain internals OK.

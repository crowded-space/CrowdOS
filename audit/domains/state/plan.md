# State Domain - Phase 7 Proposal: Ordered Implementation Plan (no implementation this turn)

Status: proposal only. All items are read-only findings from audit/domains/state/*. Next turn implements steps in order; each is small, reviewable, independently verifiable. No production edits were made in this audit; docs sync happens in the same task as any future code change (AGENTS.md section 6).

## Rewrite decision

Recommendation: INCREMENTAL REFACTOR (option 2), not rewrite, not freeze.

- Keep: the domain is 60 lines with a sound core idea (persist -> emit once per changed transition) and a green boundary lint. The facade contract (RunTransitionInput, stateGate object, null/changed semantics) is small and stable; nothing about it blocks the fixes.
- The problems are completeness and duplication, not architecture: 17 bypass writers (STATE-002), one inverted normalization (STATE-003), one dropped tenant arg (STATE-001), no tests (STATE-007). All are localization fixes in the existing seams.
- A rewrite would risk the executor contract and the client's run.status_changed ingestion (jobsByRun / runRuntimeByRun / notification counting) for no structural gain. A freeze would leave the client's approval-wait status permanently unobserved.

## Ordered steps

| # | Step | Files / symbols | Ledger IDs | Tests | Compat | Migration / rollback | Verification cmd | DoD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Fix errorCode passthrough: stop normalizing undefined to null in applyRunTransition; pass input.errorCode through untouched (null stays explicit clear) | state-gate.ts:22 | STATE-003 | Gate unit tests mirroring RUN-001 (preserve/clear) | Same wire shape; only semantics corrected | None | npx vitest run src/state | Reason-only hop preserves stored code; explicit null clears |
| 2 | Tenant threading: DONE externally (XD-002) - optional workspaceId added to RunTransitionInput (state-gate.ts:19-20), threaded at :29, executor supplies the row id at runtime-executor.ts:251. Remaining work: add the two-DB regression test | state-gate.ts:19-29; runtime-executor.ts:251 | STATE-001 | Two-DB harness transition test (missing) | Already additive | None | npx vitest run src/state src/runs | Dual-tier run walks + emits under unbound scope; test pins it |
| 3 | Add the in-domain test file pinning gate behavior (emit-once/changed, silent reject/no-op, broker fallback, emit-throw swallow) | packages/server/src/state/state-gate.test.ts (new) | STATE-007 | the file itself | None | None | npx vitest run src/state | All five behaviors pinned |
| 4 | Consolidate emitters: extract one buildRunStatusChangedPayload helper (runs domain, gate-exported or repo-level) and use it in state-gate, runs-service.resumeRun, orphan-sweep.emitStatus | state-gate.ts:31-44; runs-service.ts:23-37; orphan-sweep.ts:46-57 | STATE-006 | Payload parity test (three paths, same shape) | Payload keys unchanged | None | npx vitest run src/state src/runs | One builder; parity test green |
| 5 | Close the bypass for approval paths: route tool-executor approval hops, approval-sweeper expiry, routes/approvals decision, socket approval resume through stateGate.applyRunTransition (they already hold or can resolve a broker); research-runtime child hops likewise | tool-executor.ts:468,515,542,545,695,719,730,732; approval-sweeper.ts:41; routes/approvals.ts:79; register-socket-server.ts:1160; research-runtime.ts:404-405,454-456 | STATE-002 | Event-count per writer path; client jobsByRun regression | Adds events (additive for consumers); no API change | Rollback per site = revert call to runsGate.transition | npx vitest run src/tools src/approvals src/routes src/state | Exactly one run.status_changed per changed transition on every writer |
| 6 | Decide applyMessage: wire execution-path message writes (runtime-kernel.ts:198 first) through it, or remove the port and re-word State.md | state-gate.ts:51-55; runtime-kernel.ts:198; State.md | STATE-004 | Passthrough test OR import-graph + doc check | Removing the export is a breaking change for a zero-caller port - allowed | None | npm run lint:gates (from packages/server: node scripts/check-gates.mjs) + vitest | No dead export; docs equal gate surface |
| 7 | Event-loss compensation for dropped emits: emit a repair pass (sweep/snapshot comparison) or outbox the event with the status write | state-gate.ts:25-47; runs/sweep or runs-repository | STATE-005 | Failure-injection: broker down -> gap repaired | Additive | Additive | npx vitest run src/state src/runs | No permanent silent miss after a broker outage |
| 8 | Telemetry for dropped emits (count + structured log), once Runs Q1 names the sink | state-gate.ts:28,46 | STATE-008 | Metric assertion test | None | None | npx vitest run src/state | Dropped emit is queryable |
| 9 | Type the facade: explicit return annotations on both exports | state-gate.ts:21,51 | STATE-009 | tsc | None | None | npx tsc -p tsconfig.json --noEmit | Annotated contract compiles |
| 10 | Docs sync: update State.md Ports/Gaps/Decisions for the new fields/behavior; record ledger IDs; update _index.md if the gate shape changes | re-docs/Backend Docs/Domain Spec/State.md; _index.md | all | Manual review | None | None | n/a | Docs equal gate surface |

## Compatibility and risk notes

- Steps 1-2 are behavior corrections on existing calls; both are small and covered by new unit tests. Step 2 is additive (optional field) so old callers compile unchanged.
- Step 5 is the only step that changes runtime event volume (adds previously-missing run.status_changed events). Consumers (client crowdOsStore jobs projection, events log, socket fan-out) already handle the event type; extra events are additive. Verify no double-emit where a path both transitions and already emits (approval paths emit approval.* only - no overlap found).
- No step creates a branch; all work lands on main per AGENTS.md. Each step: checks -> stop -> user review/test -> commit only on explicit yes.

## Definition of Done (per step)

1. Focused tests added and passing (npx vitest run <paths>). 2. npx tsc -p tsconfig.json --noEmit green. 3. node scripts/check-gates.mjs green. 4. Docs updated in the same task when behavior or gate shape changes. 5. Ledger row updated with Status=Fixed plus evidence. 6. User review/test before commit.

# Swarm Domain - Test Gaps

## Baseline (exact commands + results, 2026-10-06)
1. cd packages/server; npx tsc -p tsconfig.json --noEmit -> EXIT=2; only error src/memories/memory-retrieval.ts(168,41) TS2559 (outside swarm domain).
2. cd packages/server; npx vitest run src/swarm -> 9 files / 60 tests passed (14.09s).
3. cd packages/server; node scripts/check-gates.mjs -> EXIT=0; 361 files / 23 domains; 0 production violations; 46 TEST-ONLY findings, 4 for swarm/swarm.e2e.test.ts.

## Gaps (mapped to ledger)
1. No PG-mode repository tests (hermetic short-circuit hides them): SW-01 transition bypass, SW-06 delete failure, SW-07 collision, memOnly/PG merge branches (swarm-repository.ts:240-260).
2. No test that the delegation artifact stores what the truncation message claims (SW-03); current test asserts summary size only (delegation.test.ts:124-158).
3. No abort-after-persist test (SW-04); dispatcher abort settle (swarm-dispatcher.ts:368-380) untested end-to-end.
4. No test that result-map blocked status matches the persisted blocked row (SW-05); dispatcher test asserts rows only (swarm-dispatcher.test.ts:111-136).
5. No test for the >50-task dispatch throw (swarm-dispatcher.ts:158) or the 32 concurrency clamp (resolveSwarmConcurrency).
6. No test for withTimeout late-settle usage accounting (SW-12).
7. No test for planner alias keys depends_on/dependencies/assignee_template/assignee (swarm-planner.ts:46-53).
8. No test for verifier invalid-JSON-with-usage path (verifier.test covers failing kernel only).
9. No test for delegation events with null/absent workspaceId.
10. No test tying emitted delegation payloads to event-types (SW-20); emits use casts.
11. Roster substitution spread uses Math.random (resolver:65,129,143); assertions regex-tolerant but there is no determinism seam for exact-worker assertions.
12. Docs verification not performed in this time-box: re-docs/Backend Docs/Feature and Flow Spec/"Swarm DAG and delegation.md" and "Swarm execution flow.md" were not read (read-only audit; docs sync not performed).

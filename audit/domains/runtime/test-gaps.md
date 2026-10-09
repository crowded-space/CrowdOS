# Runtime Domain — Test Gaps + Baseline
## Baseline (exact cmds from packages/server)
- npx vitest run src/runtime/runtime-router.test.ts src/runtime/interpreter.test.ts -> PASS 2 files 13 tests (router 6 incl precedence/pin/tier/rollback; interpreter 7 incl mentions/modes).
- npx vitest run src/runtime/runtime-lifecycle.test.ts -> 20/21 PASS 1 FAIL (Active Runtime prompt test throws MODEL_MODULE_NOT_CONFIGURED at context-pipeline-manager.ts:122; suite pins RESEARCH_V1/SWARM_V1=true but seeds no model module) — ledger B-01.
- npx tsc -p tsconfig.json --noEmit -> timed out at 30s wall (no result; rerun with longer budget before claiming green).
- node scripts/check-gates.mjs -> NOT RUN: file absent (scripts/ missing). Gate-boundary check unavailable; manual importer scan substituted.

## Coverage present
Router precedence/tier/pin/rollback, interpreter lexical, lifecycle routing/orchestration/tool-safety/failure/cancel/facade-invariant/swarm-conversational sections, agentic resume/budget/contract-conformance, coding cancel, research, context budget/integrity/pipeline/perf, provider contracts/http, ReAct parser, stream parity, tool deferral, safety dedupe, discovery context, model routing (log-only), round-trip + local-chat e2e.

## Gaps (ordered)
1. Resume idempotency under checkpoint-touch failure (B-05): no test kills touchCheckpoint between tool result and checkpoint; add fault-injection test asserting no replay.
2. Swarm deleteByRun failure path (B-03): no test for delete throw -> assert run fails loudly, no createTasks.
3. Stale-status reuse (B-02): no test executing with run in completed/failed -> assert refusal, not warn-reuse.
4. Token-usage loss (B-04): no test for TokenTracker throw -> assert retry/outbox or failed metric, response still returns.
5. Heartbeat failure (B-06): no test for touchRunHeartbeat rejection -> assert metric + no orphan reap.
6. Stream-buffer eviction (B-07): no test for adapter throw mid-batch -> assert no cross-turn flush.
7. Unknown-runtime fallback provenance (B-08): assert metric/run annotation when falling back to agentic.
8. studio.ts:201 bypass (B-10): contract test asserting routes use runtimeGate ports (gate-only import lint).
9. tsc baseline: rerun with extended timeout and record result.


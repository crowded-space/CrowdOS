# Runtime Domain — Plan (incremental; facade contract preserved)
AGENTS.md: kebab-case, thin gate, gate-to-gate, main-only, no commit without ask. Docs sync noted not performed (read-only audit).

## Architecture verdict: A-E
A. Boundaries: PASS with one breach — gate-to-gate holds except routes/studio.ts:201 direct contextPipeline.assemble (B-10).
B. Data flow: SOUND — interpret->route->runs/state->assemble->runtime->closeRun+usage; provenance gap only on unknown-runtime fallback (B-08).
C. Failure handling: WEAKEST — stale-reuse warn (B-02), swarm delete warn (B-03), usage/checkpoint/heartbeat fire-and-forget (B-04/05/06).
D. Config/flags: COHERENT — RESEARCH_V1/SWARM_V1 rollback + TIER map + PER_ITERATION_BUDGET/STREAM_BATCH_MS; lifecycle suite pins flags true (masks default-false behavior).
E. Test posture: GOOD core, missing fault-injection (see test-gaps.md 1-8).

## Rewrite decision: INCREMENTAL (no rewrite)
Executor/router/assembler/kernel/runtimes form a working honest-chain pipeline with 20/21 lifecycle + 13/13 router/interpreter green. Defects are localized failure-path hardness + one route bypass. Rewrite would re-risk run-state honesty for no structural gain.

## Ordered fix plan (each with gate-shape check + lifecycle test)
1. B-10 route bypass: studio.ts:201 -> runtimeGate.assembleContext (or documented adapter); add gate-only import lint test. Risk Low.
2. B-02 stale reuse: refuse non-running/created/queued/starting without resumeContext; test. Risk Low (behavior tightening).
3. B-03 swarm delete: fail run loudly on deleteByRun error; test. Risk Low.
4. B-01 baseline: seed model module in lifecycle setup or gate test; rerun full file green. Risk None.
5. B-04 usage: await-with-timeout or outbox + metric; test tracker-throw path. Risk Medium (hot path).
6. B-05 checkpoint: checkpoint-before-append or pending-carry; fault-injection test. Risk Medium.
7. B-06 heartbeat: handle touch errors + metric; test. Risk Low.
8. B-08 fallback: record fallback + metric or throw; test. Risk Low.
9. B-07 stream buffers: per-call scoping + eviction test. Risk Low.
10. B-09/B-11/B-12 hygiene: narrow context-gate; clone memory args; version cache key. Risk Low.
11. Docs sync (when fixes land): Domain Spec Ports/Relations + Feature/Flow + _index/_flow-index in same task.


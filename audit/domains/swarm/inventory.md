# Swarm Domain - Inventory (read-only audit, Phases 1-4)

Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd
Domain: packages/server/src/swarm | Facade: swarm-gate.ts | Date: 2026-10-06
No production edits. No branch. Git untouched except audit/.

## Files
| File | Bytes | Role |
| ---- | ----- | ---- |
| swarm-gate.ts | 1149 | Thin facade, exactly 10 ports, no type re-exports |
| swarm-types.ts | 1755 | Types + isSwarmV1Enabled flag reader |
| swarm-repository.ts | 10144 | swarm_tasks CRUD; hermetic mem + PG fallback; status state machine |
| swarm-planner.ts | 7840 | Supervisor prompt, strict plan-JSON parser, linear fallback |
| swarm-dispatcher.ts | 17224 | DAG validation, bounded fan-out, delegation pre-check, lease, abort |
| swarm-worker-resolver.ts | 9284 | Roster load + assignee to L3 worker resolution |
| swarm-aggregator.ts | 6622 | Pure merge/dedupe/conflict + honest summary |
| swarm-verifier.ts | 6352 | Verifier LLM + honest heuristic fallback |
| delegation-repository.ts | 7438 | delegations CRUD (hermetic + PG fallback) |
| delegation-service.ts | 9508 | depth/cycle guards, summarizer, delegate/completeDelegation |
Tests (9): delegation, swarm-aggregator, swarm-dispatcher, swarm-planner, swarm-repository, swarm-verifier, swarm-worker-resolver, swarm.e2e, swarm.no-mocks.

## Exports (exact, from source)
- swarm-gate.ts: swarmGate { isV1Enabled, createTasks, listByRun, deleteByRun, plan, dispatch, resolveWorker, loadWorkerCandidates, aggregate, verify }.
- swarm-types.ts: SwarmTaskStatus, SwarmPlanTask, SwarmPlan, SwarmTaskRow, SwarmWorkerResult, SwarmAggregationResult, SwarmVerificationResult, isSwarmV1Enabled.
- swarm-repository.ts: createSwarmTasks, updateSwarmTaskStatus, listSwarmTasksByRun, getSwarmTaskById, deleteSwarmTasksByRun, resetSwarmRepositoryForTests, resetSwarmForTests.
- swarm-planner.ts: PlanResult, parsePlanJson, buildFallbackLinearPlan, buildSupervisorPrompt, generateSwarmPlan.
- swarm-dispatcher.ts: WorkerExecutor, DEFAULT_SWARM_CONCURRENCY, MAX_SWARM_CONCURRENCY, resolveSwarmConcurrency, DEFAULT_TASK_TIMEOUT_MS, resolveTaskTimeoutMs, DispatchInput, MAX_SWARM_TASKS, dispatchSwarmTasks.
- swarm-worker-resolver.ts: ResolvedWorker, WORKER_AUTHORITY_LEVEL, resolveWorker, WorkerUnavailableError, loadWorkerCandidates.
- swarm-aggregator.ts: aggregateSwarmOutputs. swarm-verifier.ts: verifySwarm.
- delegation-repository.ts: DelegationRow, createDelegation, getDelegationById, getDelegationByChild, listDelegationsByParent, updateDelegationSummary, listAllDelegations, resetDelegationRepositoryForTests.
- delegation-service.ts: MAX_SUBAGENT_RETURN_TOKENS, CHARS_PER_TOKEN, MAX_SUBAGENT_RETURN_CHARS, DelegationRejectedError, getMaxDepth, isGuardDisabled, estimateTokens, getChainDepth, getVisitedSet, summarizeChildResult, delegate, completeDelegation.

## Import map (outside domain)
- PROD (sole consumer): runtime/runtimes/swarm-runtime.ts:4 imports { swarmGate } from swarm-gate.js; uses all 10 ports (isV1Enabled:27, loadWorkerCandidates:52, plan:55, deleteByRun:66, createTasks:70, resolveWorker:110, dispatch:152, listByRun:162, aggregate:163, verify:175).
- runtime/runtime-router.ts:90-92 reads SWARM_V1 directly (not via gate).
- No routes/, sockets/, queue/ prod imports. register-socket-server.ts:242-243 and queue/maintenance-worker.ts:182-183 hold only legacy "swarms: []" placeholders.
- Tests outside domain: swarm.e2e.test.ts imports runtime internals (provider-registry, runtime-kernel, swarm-runtime) - check-gates TEST-ONLY findings (non-fatal).

## Persistence / events / flags
- Tables: swarm_tasks (schema.ts:536-547, run FK cascade), delegations (schema.ts:549-559; child FK at :552 dropped by migration 0024 - drift).
- Emits: delegation:start, delegation:completed (delegation-service.ts:166, 236; types event-types.ts:120-132,175-176). Socket fan-out: register-socket-server.ts:414-454 (workspaceId room scoping :444).
- Flags: SWARM_V1 (env.ts:216), SWARM_MAX_DEPTH (env.ts:218), SWARM_MAX_CONCURRENCY, SWARM_TASK_TIMEOUT_MS, SWARM_GUARD_DISABLED (env.ts:261).

## Commands run (exact + result)
1. cd packages/server; npx tsc -p tsconfig.json --noEmit -> EXIT=2; single error OUTSIDE swarm: src/memories/memory-retrieval.ts(168,41) TS2559. No swarm errors.
2. cd packages/server; node scripts/check-gates.mjs -> EXIT=0; 361 files / 23 domains, 0 production violations; 46 TEST-ONLY findings incl. 4 for swarm/swarm.e2e.test.ts.
3. cd packages/server; npx vitest run src/swarm -> 9 files, 60 tests passed (14.09s).

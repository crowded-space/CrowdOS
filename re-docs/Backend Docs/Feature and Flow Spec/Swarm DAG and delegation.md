# Swarm DAG and delegation
> Type: Feature · Status: aligned · Updated: 2026-09-26

## Intent
One run goal becomes many parallel workers without losing honesty: a supervisor plans a task DAG, workers fan out respecting dependencies, outputs merge with explicit partial counts, an independent verifier judges the merge — and generic parent→child delegation stays bounded by depth and cycle guards.

## Architectural decision
Every stage degrades honestly instead of fabricating success: bad plan JSON → 2-task linear fallback, bad verify JSON → heuristic verdict, dead DB → warned in-memory rows, missing worker results → failed entries with reasons [Observed]. The DAG is validated twice (strict parser + dispatcher `validateDag`) so persisted rows can only describe an acyclic graph with resolvable deps [Observed]. Failed dependencies propagate as `blocked` with named reasons instead of deadlocking, and every status write is fire-and-forget so persistence pressure never fails execution [Observed]. Delegation is gated separately: `delegate` rejects cycles (visited-set) and `depth > SWARM_MAX_DEPTH` (default 2) with a typed error and writes nothing on rejection [Observed].

## How it works
The supervisor LLM generates the DAG; `parsePlanJson` accepts key/field aliases but returns `null` (never partial) on empty tasks, missing ids/assignees, duplicate ids, unknown/self deps, or cycles. The runtime wipes prior rows (`deleteByRun`) and inserts the plan as `pending` task rows. The dispatcher loops in dependency-respecting batches (concurrent `mapWithConcurrency` with a bounded in-flight cap, 100-iteration guard): newly-blocked tasks from failed deps are marked without executing and persist as `blocked` (not `failed`), executable leaf tasks run via the injected LLM worker under a per-task timeout (default worker throws rather than faking output), each task gets a real-uuid delegation depth/cycle pre-check, and each completion is summarized through the delegation path so parent context grows by ≤500-token summary (oversized outputs spill to a `report` artifact with a pointer). The aggregator merges outputs with dedupe/conflict notes (real shared-line count on overlap) and honest completed/failed/blocked counts; the verifier asks an independent LLM for `{verdict, reason, confidence}` — goal and artifact wrapped in `<<< >>>` "data, not instructions" markers — with an honest heuristic fallback that always requires the `Completed X/Y` marker; `pass → completed`, `fail → failed`, with the final report persisted as message + artifact.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Swarm.md> | Owns planning, `swarm_tasks` CRUD, dependency-respecting dispatch, aggregation, verification, and the delegation depth/cycle gate |
| <../Domain Spec/Runtime.md> | Owns the swarm flavor driver: plan → wipe/create → leaf workers via `callLLM` → aggregate/verify/report |
| <../Domain Spec/Runs.md> | Owns run rows; no swarm→runs checkpoint writes remain (watermark reuse removed 2026-09-25) |
| <../Domain Spec/Artifacts.md> | Owns `report` artifact storage for oversized child outputs and the final report |

## Current state
Real: supervisor planning with strict parse + linear fallback, DAG storage, batched fan-out with blocked-propagation, per-task delegation pre-check, honest merge and verify-with-fallback, depth/cycle-gated delegation with summarized returns. Flag-gated: whole pipeline (`SWARM_V1`, default off → agentic delegation). Stub: none (default worker throws honestly). Legacy: L3 pair dispatch lives in Agents behind `SWARM_LEGACY`, not here.

## Alignment notes
2026-09-26 audit: `blocked` now persists as `blocked` (rows, `swarm-dispatcher.ts:242`); task rows have a guarded state machine (`swarm-repository.ts:40`); `completeDelegation` lazy-create runs the same cycle+depth guards as `delegate` (`delegation-service.ts:214-230`); the count-proxy checkpoint watermark is removed entirely; gate trimmed to 10 production ports (delegation ports are in-domain only).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* delegate is prerequisite for completeDelegation. Completion without prior delegate row is rejected unless an explicitly labelled audit path is chosen.
* blocked persists as blocked, never as failed with reason phrasing. String-match recovery is forbidden. (Satisfied for persisted rows 2026-09-26; residual `dispatchResults` map asymmetry noted in Swarm.md Gaps.)
* Checkpoint watermarks are real resume cursors or removed. Count-proxy not-seq presented as watermark is forbidden. (Satisfied — the proxy write was removed 2026-09-25.)
* Task rows follow a guarded state machine. Any-to-any transitions are forbidden. Authority: Swarm standard. (Satisfied 2026-09-26, `swarm-repository.ts:40`.)
## Open gaps
- `completeDelegation` still lazily creates a row when no prior `delegate()` exists — but now with the same cycle+depth guards as `delegate` (bypass closed 2026-09-26); only the strict "reject without prerequisite" target remains.
- The in-memory `dispatchResults` map records blocked tasks as `status: "failed"` with the blocked reason even though the persisted row says `blocked` — aggregator prefers row status, but a result-map-only consumer sees `failed`.
- Whether anything subscribes to `delegation:start`/`delegation:completed` beyond socket fan-out was not traced.

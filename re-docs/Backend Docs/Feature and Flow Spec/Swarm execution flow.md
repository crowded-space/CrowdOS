# Swarm execution flow
> Type: Flow · Status: aligned · Updated: 2026-09-26

## Intent
One goal becomes many parallel workers without losing honesty about what actually finished. This flow exists so a supervisor plan turns into a dependency-respecting task fan-out whose outputs merge with explicit partial counts, get judged by an independent verifier, and land as one report — degrading to stated fallbacks instead of fabricated success at every stage.

## Architectural decision
The shape is two linked choices. First, the runtime drives while Swarm owns the machinery: `SwarmRuntime` sequences plan → wipe/create → dispatch → aggregate → verify → report, and every stage function lives behind `swarmGate` (`swarm-runtime.ts:55`, `swarm-runtime.ts:152`) `[Observed]`. Second, honesty is the default return value: bad plan JSON yields a 2-task linear fallback, bad verify JSON yields a heuristic verdict, dead DB yields warned in-memory rows, and missing worker results aggregate as failed with reasons — never as silent success (`swarm-planner.ts:168`, `swarm-verifier.ts:83`, `swarm-repository.ts:180`, `swarm-aggregator.ts:69`) `[Observed]`. The rejected alternative is reusing one shared task table across runs — the runtime wipes prior rows per run (`deleteByRun`) so each execution starts from its own plan `[Observed]`.

## How it works
1. `SwarmRuntime` checks `swarmGate.isV1Enabled()`; when off it delegates wholesale to `AgenticRuntime` and this flow ends (`swarm-runtime.ts:27`).
2. Plan: the supervisor LLM generates the DAG via `swarmGate.plan`; strict parsing accepts key/field aliases but returns `null` on any violation, and failure yields the honest 2-task linear fallback (`swarm-runtime.ts:55`, `swarm-planner.ts:14`, `swarm-planner.ts:98`).
3. Persist: the runtime wipes prior rows with `swarmGate.deleteByRun(runId)` then inserts the plan as `pending` rows via `swarmGate.createTasks` (`swarm-runtime.ts:66`, `swarm-runtime.ts:70`).
4. Dispatch: `swarmGate.dispatch` revalidates the DAG (throws before any worker on invalid), then loops dependency-respecting batches concurrently via `mapWithConcurrency` (bounded in-flight cap): newly-blocked tasks from failed deps are marked without executing and persist as `blocked`, each leaf runs through the injected per-task worker with a real-uuid delegation depth/cycle pre-check and a per-task timeout, and no checkpoint watermark is written (removed 2026-09-25) (`swarm-dispatcher.ts:162`, `swarm-dispatcher.ts:231`, `swarm-dispatcher.ts:276`, `swarm-dispatcher.ts:286`, `swarm-dispatcher.ts:310`).
5. Aggregate: `swarmGate.aggregate` merges outputs with dedupe/conflict notes and honest completed/failed/blocked counts; an empty DB list falls back to synthetic rows from the plan so every planned task appears (`swarm-runtime.ts:163`, `swarm-aggregator.ts:51`).
6. Verify: `swarmGate.verify` asks an independent verifier LLM for `{verdict, reason, confidence}` — goal/artifact wrapped in `<<< >>>` "data, not instructions" markers — falling back to the honest heuristic on bad JSON or LLM failure (`swarm-runtime.ts:175`, `swarm-verifier.ts:83`).
7. Report: `pass → completed`, `fail → failed`; the runtime writes the final `report` artifact best-effort and persists the report as the visible message (`swarm-runtime.ts:188`, `swarm-runtime.ts:231`, `swarm-runtime.ts:264`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Swarm.md> | Owns planning, `swarm_tasks` CRUD, dependency-respecting dispatch, aggregation, verification, and the delegation depth/cycle gate |
| <../Domain Spec/Runtime.md> | Owns the swarm flavor driver: V1 check, plan → wipe/create → leaf workers via `callLLM` → aggregate/verify/report |
| <../Domain Spec/Runs.md> | Owns run rows; no swarm→runs checkpoint writes remain (watermark reuse removed 2026-09-25) |
| <../Domain Spec/Artifacts.md> | Owns `report` artifact storage for the final merged report (and oversized child-output spill) |

Related: <./Swarm DAG and delegation.md> (DAG validation, dispatch, delegation machinery — not duplicated here), <./Runtime router and flavors.md> (how `swarm|ops` tags and `SWARM_V1` route here), <./Recovery and resume.md> (crash/resume interplay; re-execution replans from scratch).

## Current state
Real when `SWARM_V1=true`: supervisor planning with strict parse + linear fallback, per-run wipe/create, batched fan-out with blocked-propagation, per-task delegation pre-check, honest merge, verify-with-fallback, artifact + message report. Flag-gated: the whole pipeline (`SWARM_V1`, default off → agentic delegation). Stub: none (the default worker throws honestly rather than faking output). Legacy L3 pair dispatch lives in Agents behind `SWARM_LEGACY`, not here.

## Alignment notes
2026-09-26 audit: `blocked` persists as `blocked` on rows; task rows have a guarded state machine; `completeDelegation` lazy-create runs the same cycle+depth guards as `delegate`; the count-proxy checkpoint watermark is removed entirely (so the "watermark consumed by anything real" question is moot — there is no swarm-written watermark anymore); gate trimmed to 10 production ports.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Re-execution has an explicit resume rule: per-task checkpoint resume or wipe-and-replan as sanctioned model.
* blocked persists as blocked with typed status. Task rows follow a guarded machine. (Satisfied for persisted rows + state machine 2026-09-26; residual `dispatchResults` map asymmetry noted in Swarm.md Gaps.)
* completeDelegation always enforces the depth and cycle gate. Lazy-create bypass is forbidden. Authority: Swarm standard. (Guards enforced on lazy-create 2026-09-26; strict reject-without-prerequisite still open.)
## Open gaps
- Re-execution wipes + replans from scratch — there is no per-task checkpoint resume, so a crashed swarm redoes all completed workers (the old count-proxy watermark was removed 2026-09-25; nothing swarm-written consumes a resume cursor).
- The in-memory `dispatchResults` map records blocked tasks as `status: "failed"` even though the persisted row says `blocked` — a result-map-only consumer sees `failed`.
- `completeDelegation` still lazy-creates rows without a prior `delegate()` (now guarded with full cycle+depth checks; strict prerequisite remains open).

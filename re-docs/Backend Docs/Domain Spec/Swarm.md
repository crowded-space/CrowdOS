# Swarm

## Purpose
DAG-based multi-worker execution plus guarded sub-agent delegation. It turns one run goal into a supervisor-planned task DAG, persists it to `swarm_tasks`, fans workers out respecting dependencies, merges outputs honestly (no fabricated success), verifies the merge against the goal, and separately guards generic parent→child run delegation with depth ≤ 2 and visited-set cycle rejection backed by the `delegations` table.

## Feature Scope
In-scope:
- Supervisor planning: LLM DAG generation with strict JSON parsing and honest linear fallback (`swarm-planner.ts`).
- Task row CRUD for one run's DAG (`swarm_tasks` table, `swarm-repository.ts`).
- Dependency-respecting fan-out dispatch with blocked-propagation (`swarm-dispatcher.ts`).
- Output merge with dedupe/conflict notes and explicit partial counts (`swarm-aggregator.ts`).
- Independent LLM verification with honest heuristic fallback (`swarm-verifier.ts`).
- Delegation contracts: depth/cycle gate + ≤500-token summaries with artifact pointers (`delegations` table).
Non-goals (other domains):
- Real worker execution and message persistence → Runtime (`SwarmRuntime` injects the LLM worker; run key is `packet.runId ?? packet.requestId`, `swarm-runtime.ts:48`).
- Run status lifecycle and checkpoints → Runs (no swarm→runs checkpoint writes since 2026-09-25; the old per-completion watermark write corrupted the tool-call resume cursor — removal noted at `swarm-dispatcher.ts:348`).
- Report artifact storage → Artifacts (runtime and delegation write `report` artifacts via `artifactsGate`).
- Legacy L3 pair dispatch → Agents (`SWARM_LEGACY` path, not this domain).
- Transport and queueing → Routes/Sockets/Queue (no HTTP or socket code here).

## Expect
- `[Observed]` `plan` never throws: invalid LLM JSON or LLM failure always yields a 2-task linear fallback with `fallbackUsed: true` and a reason.
- `[Observed]` `parsePlanJson` returns `null` (never partial) on empty tasks, missing id/assignee, duplicate ids, unknown/self dependencies, or dependency cycles.
- `[Observed]` `dispatch` throws on an invalid DAG before running any worker, and the default worker (no injected executor) throws rather than faking output.
- `[Observed]` A task whose dependency failed is marked `blocked` without ever executing — in the local status map and in the persisted row (persisted as `blocked`, not `failed`, `swarm-dispatcher.ts:242`); its reason names the failed dependencies.
- `[Observed]` Task rows follow a guarded state machine: `updateSwarmTaskStatus` rejects illegal transitions (e.g. rewinding a terminal row) with a warning and leaves the row untouched (`swarm-repository.ts:40`, `swarm-repository.ts:195`).
- `[Observed]` Task rows follow a guarded state machine: `updateSwarmTaskStatus` rejects illegal transitions (e.g. rewinding a terminal row) with a warning and leaves the row untouched — mem path (`swarm-repository.ts:40`) and, since SW-01 fix, the PG path via a CAS status predicate.
- `[Observed]` Task rows follow a guarded state machine: `updateSwarmTaskStatus` rejects illegal transitions (e.g. rewinding a terminal row) with a warning and leaves the row untouched — mem path (`swarm-repository.ts:40`) and, since SW-01 fix, the PG path via a CAS status predicate. Abort is checked before persist (SW-04 fixed); dispatch map reports `blocked` honestly (SW-05 fixed); failed deletes throw instead of hiding stale rows (SW-06 fixed); child FK removed from schema to match migration 0024 (SW-02 fixed).
- `[Observed]` `delegate` throws `DelegationRejectedError` (code `cycle` or `depth`) on violation and never writes a row in that case.
- `[Observed]` Child summaries longer than 500 tokens (≈2000 chars) are truncated with an artifact pointer; short outputs pass through verbatim with no artifact.
- `[Observed]` Aggregation never fabricates success: tasks without results are reported failed with the reason recorded.
- `[Inferred]` `SWARM_V1=false` disables the whole pipeline — `SwarmRuntime` routes to plain agentic execution and no other caller drives plan/dispatch.

## Flow
1. Gate check: `SwarmRuntime.execute` routes to agentic when `swarmGate.isV1Enabled()` is false (`swarm-runtime.ts:27`); otherwise the run key is `packet.runId ?? packet.requestId` (`swarm-runtime.ts:48`).
2. Plan: `swarmGate.plan(packet, kernel, broker)` prompts the supervisor LLM (`swarm-planner.ts:146`); `parsePlanJson` strips fences, slices outer braces, accepts `tasks`/`plan`/`dag` keys plus `depends_on`/`dependencies` and `assignee_template`/`assignee` aliases, then enforces ids/deps/cycle rules (`swarm-planner.ts:14`); failure yields `buildFallbackLinearPlan` (2-task chain, `swarm-planner.ts:98`; fallback wiring at `swarm-planner.ts:168`, LLM error at `swarm-planner.ts:171`).
3. Persist: runtime clears prior rows via `swarmGate.deleteByRun(runId)` then `swarmGate.createTasks(runId, plan.tasks)` inserts all rows `pending` (`swarm-runtime.ts:66`, `swarm-repository.ts:132`); DB failure warns and falls back to the in-memory map, still returning rows (`swarm-repository.ts:180`).
4. Dispatch: `swarmGate.dispatch({ plan, runId, packet, broker, workerExecutor })` revalidates the DAG and throws on error (`swarm-dispatcher.ts:162`); each iteration marks newly-blocked tasks from failed deps (`swarm-dispatcher.ts:231`), runs the executable batch concurrently via `mapWithConcurrency` (bounded in-flight workers — replaced `allSettled`, `swarm-dispatcher.ts:46`, batch at `swarm-dispatcher.ts:276`), and loops until no `pending` remains (100-iteration guard fails leftovers and throws, `swarm-dispatcher.ts:208`).
5. Per worker: dispatcher mints `childRunId = randomUUID()` (uuid column type required — the old composite `<runId>::<taskId>::<8hex>` was rejected by the uuid column, `swarm-dispatcher.ts:286`) and runs the `delegate` depth/cycle pre-check — rejection fails just that task (`swarm-dispatcher.ts:298`), other gate errors warn and proceed unguarded (`swarm-dispatcher.ts:302`); the injected executor runs under a per-task timeout (`swarm-dispatcher.ts:310`, SwarmRuntime worker executes via `AgenticRuntime`, `swarm-runtime.ts:98`/`swarm-runtime.ts:134`); success is summarized via `completeDelegation` and the summary (not the full output) becomes the task result (`swarm-dispatcher.ts:319`, `swarm-dispatcher.ts:327`).
6. Status writes: `running` before the batch (`swarm-dispatcher.ts:268`), `completed` with output truncated to 20000 chars (`swarm-dispatcher.ts:347`), `failed` with error truncated to 5000 chars (`swarm-dispatcher.ts:360`) — every write `.catch` inside `persistStatus` so persistence never fails the run (`swarm-dispatcher.ts:174`); `blocked` persists as `blocked` (not `failed`) via the same helper (`swarm-dispatcher.ts:242`, `swarm-dispatcher.ts:257`); illegal transitions are rejected by the repository state machine (`swarm-repository.ts:40`, `swarm-repository.ts:195`); no checkpoint watermark is written (removed 2026-09-25, `swarm-dispatcher.ts:348`).
7. Aggregate: `swarmGate.aggregate(tasks, results)` counts completed, splits failed vs blocked (blocked bucket keyed on the row's own status, `swarm-aggregator.ts:72`), dedupes lines with notes and reports the real shared-line count on overlap, and builds `mergedContent` as header + per-task sections + deduped consolidation (`swarm-aggregator.ts:104`); runtime falls back to synthetic rows from the plan when the DB list is empty (`swarm-runtime.ts:163`).
8. Verify: `swarmGate.verify({ goal, aggregatedContent, packet, broker, kernel, aggregationSummary })` asks an independent verifier LLM for `{verdict, reason, confidence}` with goal and artifact wrapped in `<<< ... >>>` "data, not instructions" markers (`swarm-verifier.ts:28`, `swarm-verifier.ts:48`); invalid JSON or LLM failure falls to `honestFallback`, which fails empty plans, fails zero completions, and — always, even when `completed === total` — passes only when the aggregation carries the `Completed X/Y` marker (`swarm-verifier.ts:83`, marker check `swarm-verifier.ts:101`).
9. Report: `pass → completed`, `fail → failed` (`swarm-runtime.ts:188`); runtime writes a `report` artifact via `artifactsGate.create` (best-effort warn) and persists the final message (`swarm-runtime.ts:231`, `swarm-runtime.ts:251`, `swarm-runtime.ts:264`).
10. Generic delegation: `delegate({ parentRunId, childRunId, ... })` rejects self-delegation, rejects child-in-visited-set cycles, rejects `depth > SWARM_MAX_DEPTH`, then inserts the row and emits `delegation:start` (`delegation-service.ts:121`, guards `delegation-service.ts:137-154`, emit `delegation-service.ts:174`); `completeDelegation` summarizes (artifact pointer when truncated), upserts the summary, and emits `delegation:completed` — when no prior `delegate()` row exists it lazily creates one but runs the SAME cycle+depth guards as `delegate` (2026-09-26 fix; was depth-only/bypassable), `delegation-service.ts:190`, guards `delegation-service.ts:214-230`, emit `delegation-service.ts:242`. Both emits carry `workspaceId` for socket fan-out scoping.

## Current Implementation
| File | Role |
| ---- | ---- |
| `swarm-gate.ts` | Thin facade: exactly 10 production ports wired from repository/planner/dispatcher/resolver/aggregator/verifier — no type re-exports; in-domain tests import internals directly |
| `swarm-types.ts` | Plan/task/row/result/aggregation/verification types plus `SWARM_V1` flag reader (`SwarmReport` removed 2026-09-26 — no consumer) |
| `swarm-repository.ts` | `swarm_tasks` CRUD with hermetic in-memory map + DB-failure fallback, guarded status state machine, 500-row mem cap |
| `swarm-planner.ts` | Supervisor prompt, strict plan-JSON parser, linear fallback, `generateSwarmPlan` |
| `swarm-dispatcher.ts` | DAG validation, bounded batched fan-out, delegation pre-check, status writes, abort handling |
| `swarm-worker-resolver.ts` | Roster candidates + plan assignee → agent (requester never resolves as its own worker) |
| `swarm-aggregator.ts` | Pure merge: counts, dedupe/conflict notes, honest `mergedContent` |
| `swarm-verifier.ts` | Verifier prompt, verdict parser, LLM verify with honest heuristic fallback |
| `delegation-repository.ts` | `delegations` CRUD with the same hermetic in-memory pattern |
| `delegation-service.ts` | Depth/cycle gate, token estimate, summarizer, `delegate`/`completeDelegation` |

Key types/functions: `SwarmPlanTask { id, dependsOn, assigneeTemplate, goal?, description? }`; `SwarmTaskStatus = pending|running|completed|failed|blocked`; `WorkerExecutor` (injected LLM worker, `swarm-dispatcher.ts:8`); `DelegationRejectedError { code: cycle|depth }` (`delegation-service.ts:10`); `MAX_SUBAGENT_RETURN_TOKENS = 500`, `MAX_SUBAGENT_RETURN_CHARS = 2000` (`delegation-service.ts:6`, `delegation-service.ts:8`); `MEM_ROW_CAP = 500` (`swarm-repository.ts:16`); `isHermeticMode` (`NODE_ENV=test` or `__SOCKET_FAKE_DB__=1` or no `DATABASE_URL`, `swarm-repository.ts:60`).

## Ports
Gate exports exactly one object, `swarmGate`, with ten production ports (2026-09-26 trim: type re-exports, test-only helpers, parser internals, and all delegation ports were removed from the gate surface — types live in `swarm-types.ts`, in-domain tests import repository/service internals directly, and the dispatcher calls `delegation-service.js` in-domain):
- `swarmGate.isV1Enabled` — `SWARM_V1 === "true"` flag reader (`swarm-types.ts:58`).
- `swarmGate.createTasks` — inserts a run's task rows as `pending`.
- `swarmGate.listByRun` — lists a run's task rows (cap 500).
- `swarmGate.deleteByRun` — deletes a run's task rows (hermetic: mem only).
- `swarmGate.plan` — supervisor LLM plan, honest linear fallback on invalid JSON/LLM failure (never throws).
- `swarmGate.dispatch` — dependency-respecting bounded fan-out, returns id→result map.
- `swarmGate.resolveWorker` — plan assignee + roster candidates → resolved agent (requesting agent excluded as its own worker; substitution reported honestly).
- `swarmGate.loadWorkerCandidates` — one workspace roster read per swarm; rethrows roster errors (caller decides fallback).
- `swarmGate.aggregate` — pure output merge with honest counts and blocked bucket.
- `swarmGate.verify` — independent verification: `<<< >>>`-wrapped goal/artifact prompt, strict honest fallback requiring the `Completed X/Y` marker.

## Relations
Gates this domain calls:
- `artifacts-gate.ts` — `artifactsGate.create` for oversized child outputs, dynamic import (`delegation-service.ts:89`); `SwarmRuntime` transport writes the final `report` artifact (`swarm-runtime.ts:231`).
- `runs-gate.ts` — REMOVED `runsGate.touchCheckpoint` heartbeat reuse per completed task: the call overwrote the tool-call resume cursor with a completed-count proxy. No swarm→runs checkpoint writes remain (2026-09-25 audit fix; removal noted at `swarm-dispatcher.ts:348`).
- Type-only: `EventBroker` (`event-broker-gate.js`), `ContextPacket` (runtime types).
Known outside callers of `swarmGate`:
- Runtime: `runtime/runtimes/swarm-runtime.ts` (sole production driver; consumes exactly the 10 ports above).
- Tests: `swarm.e2e.test.ts`, `swarm-dispatcher.test.ts` (in-domain; import repository internals directly where needed), `delegation.test.ts`, `swarm-planner.test.ts`, `swarm-aggregator.test.ts`, `swarm.no-mocks.test.ts`, `swarm-repository.test.ts`, `swarm-verifier.test.ts`, `swarm-worker-resolver.test.ts`.
Tables shared with other domains (owned by Runs):
- `runs` — parent run ids reference it; parent-FK cascade deletes delegation rows with the run. `delegations.child_run_id` is uuid NOT NULL but no longer FK-references `runs.id` (migration 0024, 2026-09-26 — dispatcher-minted child ids are delegation tokens, not run rows; the FK made every prod INSERT fail and silently fall back to process memory). `artifacts` rows written via gate are owned by Artifacts.

## Emits-Listens
- `delegation:start` (emits, on accepted delegation with depth + taskId; payload carries `workspaceId` for socket fan-out scoping, `delegation-service.ts:174`)
- `delegation:completed` (emits, with summary + artifact ref; payload carries `workspaceId`, `delegation-service.ts:242`)

## Owns
- `swarm_tasks` (writes: insert, status/output updates, delete-by-run)
- `delegations` (writes: insert, summary update)

## Flags
- `SWARM_V1` — `true` enables the swarm pipeline; anything else routes `SwarmRuntime` to agentic.
- `SWARM_MAX_DEPTH` — max delegation chain depth, default 2, non-numeric/negative falls back to 2; `≥ 99` disables the depth guard entirely.
- `__SOCKET_FAKE_DB__` / `NODE_ENV=test` / absent `DATABASE_URL` — hermetic mode: repositories serve the in-memory maps and skip the DB (`swarm-repository.ts:60`, `delegation-repository.ts:60`).

## Decisions
- `[Observed]` Honest fallback everywhere: bad plan JSON → linear 2-task plan, bad verify JSON → heuristic verdict, dead DB → warned in-memory rows — the pipeline degrades without ever fabricating worker success (`swarm-planner.ts:168`, `swarm-verifier.ts:83`, `swarm-repository.ts:180`).
- `[Observed]` Double DAG validation (strict parser + dispatcher `validateDag`) — persisted rows can only ever describe an acyclic graph with resolvable deps (`swarm-planner.ts:14`, `swarm-dispatcher.ts:105`).
- `[Observed]` Blocked-propagation instead of deadlock: failed deps fail dependents with named reasons, and unsatisfiable leftovers are force-blocked so the loop always terminates — and blocked persists as `blocked`, recoverable from the row itself (`swarm-dispatcher.ts:231`, `swarm-dispatcher.ts:250`).
- `[Observed]` `mapWithConcurrency` fan-out (bounded in-flight workers so a wide batch cannot spawn unbounded subprocesses — replaced `allSettled`) with per-task status writes — one worker crash fails one task, and every write is caught inside `persistStatus` so persistence pressure never fails execution (`swarm-dispatcher.ts:46`, `swarm-dispatcher.ts:276`, `swarm-dispatcher.ts:174`).
- `[Observed]` Delegation pre-check mints a real-uuid `childRunId` (uuid column type) and enforces depth + visited-set before enqueue; rejection fails the single task, while unexpected gate errors warn and proceed unguarded rather than stalling the swarm (`swarm-dispatcher.ts:286-302`).
- `[Observed]` Parent context grows by summary only: ≤500-token outputs pass through, oversized outputs truncate at 2000 chars with the full text spilled to a `report` artifact (or a random-suffix `artifact:<child>:<random8>` pointer when the store fails) (`delegation-service.ts:85`).
- `[Observed]` Output truncation is lossy by design: 20000 chars on success, 5000 on error fit the row's `outputRef` text column (`swarm-dispatcher.ts:347`, `swarm-dispatcher.ts:360`).
- `[Observed]` Verifier is strict about honesty: the honest fallback passes only when the aggregation itself carries the `Completed X/Y` marker — always, even when counts say `completed === total` (counts prove the aggregator ran, not the artifact) (`swarm-verifier.ts:101`).
- `[Observed]` Task rows cannot be rewound: `updateSwarmTaskStatus` rejects transitions outside `ALLOWED_TRANSITIONS` with a warning (guarded state machine, `swarm-repository.ts:40`, `swarm-repository.ts:195`).
- `[Observed]` Worker resolution never uses the requesting agent as its own worker: the requester is excluded from default eligibility, but a named assignee that IS the requester resolves honestly as a substitution rather than silently rerunning the orchestrator (`swarm-worker-resolver.ts`).
- `[Inferred]` In-memory maps double as a read-after-write coherence layer in DB mode (writes populate mem, reads fall back to mem when the DB is empty; capped at 500 rows) — which also means mem and DB can silently diverge (`swarm-repository.ts:71`, `swarm-repository.ts:226`, `swarm-repository.ts:262`).

## User Decision:

## Architectural Standard (Target)

> Status: Target — new work must satisfy this. Lazy-create completion still exists (2026-09-26: it now runs the SAME cycle+depth guards as `delegate`, so the guard is no longer bypassable), but completion without a prior delegate row is still accepted rather than rejected.

* delegate MUST be a prerequisite for completeDelegation. Completion without a prior delegate row MUST be rejected unless an explicitly labelled unguarded-audit path is chosen (see Q1).

## User Decision (Open — awaiting operator choice)

* Q1: Should lazy-create completion be removed (strict guard) or kept as an audited exception path? (Recommended: strict — remove the bypass.)

## Failure + Resume
- Invalid plan content never rejects the run — fallback plan carries the reason in `fallbackReason`/`rawPlanText` for the report (`swarm-planner.ts:168`, `swarm-planner.ts:171`).
- Invalid DAG rejects `dispatch` with `invalid DAG: ...` before any worker starts; no partial fan-out to clean up (`swarm-dispatcher.ts:162`).
- Delegation rejection (`cycle`/`depth`) fails only the attempting task with the rejection message (`swarm-dispatcher.ts:298`); abort signals break the loop between batches (`swarm-dispatcher.ts:210`) and after a batch leave remaining tasks pending/running with honest abort reasons (`swarm-dispatcher.ts:368`).
- Missing worker results aggregate as failed with `no worker result` / `missing worker result` reasons; `SwarmRuntime` additionally synthesizes rows from the plan when the DB list is empty so every planned task appears in the report (`swarm-aggregator.ts:69`, `swarm-runtime.ts:163`).
- Repository DB errors warn-and-fallback per operation; `deleteByRun` in hermetic mode clears mem only (`swarm-repository.ts:289`).
- Resume is manual: re-executing the run deletes prior rows and replans from scratch — there is no per-task checkpoint resume (`swarm-runtime.ts:66`).

## Gaps
- Swarm task rows have no local file tier: the in-memory `memByRun` fallback is process-local, so in Local mode (no database) swarm plans are lost on desktop restart (2026-09-23 local-mode CRUD audit).
- Schema drift: `db/schema.ts:552` still declares `.references(() => runs.id)` on `delegations.child_run_id` while migration 0024 dropped the constraint — reconcile there (schema.ts was outside this task's editable set) so `drizzle-kit generate` does not re-add the FK.
- Blocked asymmetry: rows persist `blocked` (`swarm-dispatcher.ts:242`, `swarm-dispatcher.ts:257`), but the in-memory `dispatchResults` map records those tasks as `status: "failed"` with the blocked reason (`swarm-dispatcher.ts:239`, `swarm-dispatcher.ts:256`) — aggregator prefers the row status (`swarm-aggregator.ts:72`), but a consumer reading only the result map sees `failed`.
- `completeDelegation` still lazily creates a row when no prior `delegate()` exists (now with the same cycle+depth guards as `delegate` — the bypass is closed; only the strict "reject without prerequisite" target remains open, `delegation-service.ts:214-230`).
- `getVisitedSet` breaks (rather than reports) on revisit, and `getChainDepth`/`getVisitedSet` cap traversal at 100 hops silently — deep or cyclic chains outside the gate return truncated answers (`delegation-service.ts:43`, `delegation-service.ts:59`).
- Delegation rows have no out-of-domain read path: the 2026-09-26 gate trim removed every delegation port (dispatcher consumes them in-domain; `delegation.test.ts` imports internals) — a surface is needed only if an external consumer appears.
- No `listens` observed; whether anything subscribes to `delegation:start`/`delegation:completed` beyond socket fan-out was not traced.

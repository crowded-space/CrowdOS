# Legacy L3 dispatch (retired)
> Type: Feature · Status: retired/deleted · Updated: 2026-09-14

## Intent
Before the Swarm gate existed, one request fanned out to worker/supervisor agent pairs that did stub work in private channels and archived their own evidence. This feature existed so a caller could dispatch a batch of subtasks and get back an aggregated report — and it is now fully deleted (code removed, Swarm gate only).

## Architectural decision
Full deletion (2026-09-14): `agent-spawn-manager.ts`, `spawn-retention-sweeper.ts`, `agentGate.dispatch`, and the `dispatch_agent` tool were removed; `SWARM_LEGACY` flag retired. Swarm gate (`SWARM_V1`) is the only dispatch path. `spawn_requests`/`task_files` tables remain in schema (no new writes; legacy reads return empty) to avoid a destructive migration.

## How it works
`agentGate.dispatch` enters `dispatchAgent`, which throws before touching the DB unless `SWARM_LEGACY=true`. Behind the flag it resolves worker/supervisor templates (auto-seeding fallback rows when absent), inserts a `spawnRequests` row as `in_progress`, and reads the origin channel only for its `categoryId`. Subtasks run in batches of max 5 pairs; overall status is `completed` only when every item completed, then the request row is updated. Per pair: insert a private `pair_private` channel plus `workspace:sync`, insert uniquely-named worker/supervisor instances with their `runtimeStates` rows (Agents-owned lifecycle), emit `agent:spawned`, insert a pending `taskFiles` row, and append a welcome message via `messageGate.append`. The retry loop (`retryCount <= maxRetries`) marks the task file `in_progress`, steps the worker through working (`agentGate.setStatus`) → stub output → best-effort workspace file write → stream plus `messageGate.append` → idle, then the supervisor through working → deterministic stub verdict → stream plus `messageGate.append` → idle; it breaks on success or on `escalate` policy (no retry even when `maxRetries > 0`) and otherwise increments. Teardown emits both `agent:despawned`, waits ~1s so clients witness the stream, deletes transient `runtimeStates` rows, archives the task file, both agents, and the channel with `spawn_verdict`, and emits `workspace:sync`. Separately, `startSpawnRetentionSweeper` runs once per process on an interval and hard-deletes archived `taskFiles`/`agents`/`channels` older than `RETENTION_DAYS` (default 30) across every workspace DB; sweep failures only log. The `dispatch_agent` tool remains the only live caller path into this dispatch, running the swarm `delegate` pre-check first.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Agents.md> | Owns the retired dispatch (`AgentSpawnManager`), the archive teardown, and the retention sweeper |
| <../Domain Spec/Swarm.md> | Owns real task execution (`SWARM_V1`) — the replacement this legacy path must not be confused with |
| <../Domain Spec/Tools.md> | Owns the `dispatch_agent` tool wrapper that still reaches legacy dispatch via the swarm pre-check |
| <../Domain Spec/Workspace.md> | Owns channels/provisioning surfaces the legacy path writes as side effects (private pair channels) |
| <../Domain Spec/Messages.md> | Sole owner of the `messages` table; welcome/stream/verdict rows go through `messageGate.append` |

## Current state
Deleted: spawn-manager, retention sweeper, `agentGate.dispatch`, `dispatch_agent` tool, `SWARM_LEGACY` flag. Do not build on this path — new work goes through the Swarm gate.

## Alignment notes
`none found` — sources removed — `agent-spawn-manager.ts` and `spawn-retention-sweeper.ts` were deleted 2026-09-14 (this doc L8); only `swarm.no-mocks.test.ts:50` still string-references the old spawn path. The kill-flag/batch-5/stub-execution/archive/sweeper claims below are unverifiable against current code, and `Shared/config/env.ts:170` is `PIPELINE_PARALLEL`, not a `SWARM_LEGACY` schema.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Retired stays retired. Legacy L3 dispatch is documented history only, never a live path.
* Swarm gate is the sole execution path. Reintroduction requires a new decision record.
* Authority: Agents, Swarm standards.
## Open gaps
- Whether the `SWARM_LEGACY` escape hatch has a removal release set, or stays indefinitely.
- `delete()` hard-deletes while spawn teardown archives — two deletion semantics, and whether hard-delete orphans `runtimeStates`/`messages` rows is unverified.
- `getById()` returns archived spawn instances and reference validation does not exclude them — an archived agent may be a legal fallback, intent unverified.
- `runSpawnRetentionSweep` and the test reset bypass the gate (tests import the sweeper directly); only the starter is a port.
- `worker.ts` imports `agentGate` only to void it — likely a dead dependency-keepalive, purpose unverified.
- Whether `runtime_states` has a single owner (Runtime vs Agents) is unresolved; both write it.
- `maxRetries` is inert while the stub supervisor never fails — whether the flag path should exercise failure/retry at all is unverified.

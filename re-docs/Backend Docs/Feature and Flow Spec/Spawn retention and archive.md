# Spawn retention and archive
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Spawn evidence must outlive the run for audit, then disappear on a schedule so storage stays bounded. This feature exists so every legacy pair's task file, agents, and channel are archived (never inline-destroyed) at teardown, and a periodic sweeper hard-purges only archives older than the retention window.

## Architectural decision
Archive-then-purge, auditability first: pair teardown archives the task file, both agents, and the channel with a `spawn_verdict` and only deletes transient `runtimeStates` rows; the sweeper hard-deletes solely rows whose `archivedAt` predates the cutoff `[Observed]`. The sweeper is once-per-process on an interval, fans out across every workspace DB, logs only non-empty purges, and never throws — timer failures are logged `[Observed]`. Retention (`RETENTION_DAYS`, default 30) and cadence (`RETENTION_SWEEP_MS`, default 6h) share one fallback rule: negative/non-numeric falls back to default `[Observed]`.

## How it works
Pair teardown emits both `agent:despawned`, waits ~1s so clients witness the stream, deletes the transient `runtimeStates` rows, archives the task file, both agents, and the channel with `spawn_verdict`, and emits `workspace:sync`. Separately, `startSpawnRetentionSweeper` runs once per process: each sweep computes cutoff as now minus `RETENTION_DAYS`, walks every workspace DB via `forEachWorkspaceDb` (serial, best-effort, handle-deduped), and inside each handle hard-deletes archived `taskFiles`, `agents`, and `channels` with `archivedAt < cutoff`, accumulating `{ purgedTaskFiles, purgedAgents, purgedChannels }`. Non-empty totals are console-logged; interval-timer failures are caught and logged, never thrown. The starter is the only gate port — the per-run sweep and the test reset are imported directly (tests bypass the gate). Startup wiring lives in `index.ts` and `create-app.ts`; there is no catch-up for missed intervals.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Agents.md> | Owns nothing live — archive teardown and the sweeper were deleted 2026-09-14 (see Legacy L3 dispatch (retired) L8); the Agents doc links are stale |
| <../Domain Spec/Workspace.md> | Owns the multi-DB fan-out (`forEachWorkspaceDb`) the sweeper borrows to reach every workspace DB |

## Current state
Live as documented: teardown archives rather than destroys; the sweeper purges only pre-cutoff archived rows across all workspace DBs; defaults are 30 days / 6h with fallback on bad values; empty sweeps stay silent; failures only log. The sweeper timer is started, not gated per-run.

## Alignment notes
`none found` — sources removed — `agent-spawn-manager.ts` and `spawn-retention-sweeper.ts` were deleted 2026-09-14 (see Legacy L3 dispatch (retired) L8); the archive-teardown/cutoff/logging/starter/env claims below are unverifiable against current code.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* runSpawnRetentionSweep plus test reset go through the gate. Tests importing the sweeper file directly is forbidden.
* Delete semantics are explicit: hard-delete cascades or documents orphan rule. Two silent semantics are forbidden.
* Missed-interval catch-up after restart has an explicit boot-sweep rule.
* Retention drop-list covers every spawned kind or explicitly lists exclusions. RETENTION_DAYS zero has an explicit intended-or-footgun contract. Authority: Agents standard.
## Open gaps
- `runSpawnRetentionSweep` and the test reset bypass the gate (tests import the sweeper file directly); only the starter is a port — gate-shape stability does not cover sweep changes.
- `delete()` hard-deletes while spawn teardown archives — two deletion semantics, and whether hard-delete orphans `runtimeStates`/`messages` rows is unverified.
- No sweeper catch-up for missed intervals (restarts, downtime) — whether a boot-time sweep was intended is unverified.
- Whether the retention drop-list covers every spawned artifact kind (e.g. spawned `messages`, `runtime_states` leftovers, sandbox files) was not diffed — only `taskFiles`/`agents`/`channels` purge.
- `RETENTION_DAYS=0` is accepted by the fallback rule (only negative/non-numeric fall back) — whether zero-day purge is intended or a misconfiguration footgun is unverified.

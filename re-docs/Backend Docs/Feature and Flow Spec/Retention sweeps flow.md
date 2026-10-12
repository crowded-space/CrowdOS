# Retention sweeps flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
Storage must stay bounded without destroying anything an operator might still need — spawn evidence for audit, artifacts for inspection, suppressions that should lift, approvals that must default-deny, runs that must stay resumable. This flow exists so every periodic purge has exactly one owner, each purges only its own rows, and the one deliberate overlap (`waiting_for_approval` runs) is owned by Approvals, never by the orphan reaper.

## Architectural decision
Archive/restore-then-purge, never inline destroy: spawn teardown/purge was deleted 2026-09-14 (no `agent-spawn-manager.ts`/`spawn-retention-sweeper.ts` under `packages/`); the memory suppression sweep *restores* (elapsed `suppressed` → `active`) rather than deleting (`memory-lifecycle.ts:114-141`) `[Observed]`. Every sweeper fans out serially across workspace DBs via `forEachWorkspaceDb` with per-target best-effort catch, so one dead database never stalls the rest (`workspace-database-runtime.ts:160-183`) `[Observed]`. The orphan sweep deliberately excludes `waiting_for_approval`, which belongs to the Approvals TTL path (`orphan-sweep.ts:19-23`) `[Observed]`. Scheduling is topology-aware: inline mode starts process-local timers on boot, bullmq mode suppresses them on the API side and the worker owns the repeatables (`create-app.ts:289-322`, `maintenance-worker.ts:54-85`) `[Observed]`.

## How it works
1. Spawn retention (Agents): REMOVED 2026-09-14 — `startSpawnRetentionSweeper`/`spawn-retention-sweeper.ts` no longer exist under `packages/`; only a test string-references the old path.
2. Artifact retention (Artifacts): `runArtifactRetentionSweep(now)` derives `before` from the same `RETENTION_DAYS` (default 30; `0` purges everything before now), hard-deletes `createdAt < before`, and logs only when `purged > 0` — with no in-domain timer; scheduling is the caller's job (`artifacts-repository.ts:171-198`).
3. Memory suppression + caps (Memories): `startMemorySweeper` runs once per process on `MEM_SUPPRESS_SWEEP_MS` (default 10min); each tick flips up to 500 elapsed `suppressed` rows back to `active` with one audit row each, while `enforceNoteCap` archives lowest-importance/oldest overflow beyond `MEM_NOTE_CAP` (500) and `enforceCapsAllAgents` fans out in chunks of 5 with per-agent isolation (`memory-lifecycle.ts:114-141`, `memory-lifecycle.ts:151-214`, `memory-lifecycle.ts:224-247`).
4. Approval expiry (Approvals): `startApprovalSweeper` fires after a 5s delay on a 30s interval; per DB a single `UPDATE pending → expired WHERE expiresAt < now RETURNING` runs, then each expired row resumes its `waiting_for_approval` run to `running` (default-deny: the tool fails safely, the run continues) and emits `approval.decided` with `decision: expired` (`approval-sweeper.ts:11-71`).
5. Orphan reaping (Runs): on `ORPHAN_SWEEP_MS` (default 30s) the sweep selects rows with `updatedAt < now - ORPHAN_AFTER_MS` (default 60s, min 10s) in live candidate states — explicitly excluding `waiting_for_approval` — and walks each stale row `→ orphaned → resumable` with a `run.status_changed` emit per hop, self-healing stranded `orphaned`/`cancelling` rows on the next pass (`orphan-sweep.ts:8-23`, `orphan-sweep.ts:54-110`).
6. Overlap notes: `RETENTION_DAYS` is read by both Agents and Artifacts (one knob, two sweepers); `waiting_for_approval` liveness is owned solely by the approval sweeper plus the executor's poll loop, never the orphan sweep; memory cap-archiving and spawn purging both touch `agents` rows but on disjoint predicates (cap archives lowest-importance active memory overflow per agent; spawn purges pre-cutoff archived spawn instances).
7. In bullmq mode the API suppresses local timers and the maintenance worker owns the `orphan-resume` and `suppress-expiry` repeatables (sweep bodies ported as-is); inline mode runs all starters on API boot via the heartbeat system (`create-app.ts:289-322`, `maintenance-worker.ts:54-85`, `agent-heartbeat.ts:51-63`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Agents.md> | Owns spawn archive teardown and the `RETENTION_DAYS`/`RETENTION_SWEEP_MS` archive-purge sweeper |
| <../Domain Spec/Artifacts.md> | Owns time-based hard purge + `RETENTION_DAYS` retention sweep (no in-domain timer) |
| <../Domain Spec/Memories.md> | Owns suppression-restore sweep + per-agent cap-archive + multi-DB fan-out sweep starter |
| <../Domain Spec/Approvals.md> | Owns TTL expiry (`pending → expired`) with default-deny run resume + emit; sole owner of `waiting_for_approval` liveness |
| <../Domain Spec/Runs.md> | Owns the orphan reaper (`→ orphaned → resumable`, `waiting_for_approval` excluded) |
| <../Domain Spec/Workspace.md> | Supplies `forEachWorkspaceDb` fan-out every sweeper borrows |
| <../Domain Spec/Queue.md> | Owns repeatable sweep topology in bullmq mode (worker owns repeatables, API suppresses local timers) |

Related in this folder: [Recovery and resume](./Recovery%20and%20resume.md) — orphan→resumable detail and resume handoff; [Artifacts and retention](./Artifacts%20and%20retention.md) — artifact store design; [Spawn retention and archive](./Spawn%20retention%20and%20archive.md) — spawn archive design.

## Current state
Real in both modes: all five sweepers run with the cadences above (30s orphan / 30s approvals / 10min memory / 6h spawn; artifact sweep has no in-domain timer). Purges are hard-deletes with no undo (spawn, artifacts); memory suppression flips restore rather than delete; approval expiry resumes rather than fails runs. Empty sweeps stay silent everywhere except per-target warn-and-continue on errors.

## Alignment notes
`none found` — sweep predicates, cutoffs, per-hop emits, the `waiting_for_approval` exclusion (`orphan-sweep.ts:19-23` vs `approval-sweeper.ts:33-42`), and inline-vs-bullmq ownership all match the cited code and are consistent across the six domain docs. `RETENTION_DAYS` sharing between Agents and Artifacts is confirmed in code, not drift — but it is a coupling (see gaps).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* runArtifactRetentionSweep has one scheduled owner with a documented timer. Never-firing sweeps are forbidden.
* RETENTION_DAYS has one owner and one semantic, or spawn and artifact windows split into independent knobs. Shared-knob ambiguity is forbidden.
* Missed-interval catch-up after restart has an explicit boot-sweep rule. Silent missed sweeps are forbidden.
* purgeExpired is batch-bounded. Unbounded single-statement purges are forbidden.
* Spawn purge covers every spawned kind or explicitly lists exclusions. Agents table has one documented owner across memory cap-archiving and spawn purging. Authority: Artifacts, Agents, Memories standards.
## Open gaps
- Who schedules `runArtifactRetentionSweep` in production is unverified — it has no in-domain timer and no observed repeatable; it may never fire.
- `RETENTION_DAYS` couples spawn and artifact purges to one knob; whether a shared window is intended or two independent windows were meant is unverified.
- No sweeper catches up missed intervals after restarts/downtime — whether a boot-time sweep was intended is unverified.
- `purgeExpired` (artifacts) has no batch limit — a large expired backlog deletes unbounded rows in one statement; lock/timeout behavior unverified.
- Whether the spawn purge covers every spawned artifact kind (spawned `messages`, `runtime_states` leftovers, sandbox files) was not diffed — only `taskFiles`/`agents`/`channels` purge.
- Memory cap-archiving and spawn purging both write `agents` rows — single-owner semantics for the table are unresolved (see `Agents.md` Gaps).

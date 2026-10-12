# Runs

## Purpose
Durable run-lifecycle store for agent executions. It owns run rows, guards every status write through a state machine, and persists checkpoints plus file-compensation records so crashed runs can be swept to resumable and resumed without re-executing completed work.

## Feature Scope
In-scope:
- Run row CRUD + status lifecycle (`runs` table).
- State-machine-guarded transitions with concurrency guard (`WHERE status = from`) and one CAS-retry.
- Progress checkpoints (`watermarkSeq`, `completedCallIds`, `historyRef`, `updatedAt`).
- File-compensation journal (`runs_compensation`) + undo via inverse ops (refusal-first validation).
- Orphan detection sweep: live states at 60s, non-heartbeating `created`/`queued` at 10× (`orphaned` → `resumable`) and `resumable` → `queued` resume.
Non-goals (other domains):
- Queue delivery, retries, repeatable jobs → Queue (`queueGate.enqueueRun`, `queueGate.mode()`).
- Execution, prompt assembly, token accounting → Runtime (`runtime-executor.ts`, `runtimeGate.execute`).
- Approval policy/TTL/default-deny → Approvals (Runs only exposes `waiting_for_approval` states).
- File I/O and risk classification → Tools (`Guard.validatePath`, `tool-executor.ts`).
- Transport (REST/socket payloads, auth) → Routes/Sockets (call `runsGate`, never contain logic).
- Workspace sharding/DB routing → Workspace (`forEachWorkspaceDb` is borrowed, not owned).

## Expect
- Transition legality: caller must request an edge in `TRANSITIONS`; illegal `from → to` returns `null`, never throws, never writes. `[Observed]`
- Terminal immutability: `completed`/`failed`/`cancelled` accept no outgoing edge except same-state no-op. `[Observed]`
- Idempotency: same-state `from === to` is a legal no-op returning `{ changed: false }`; callers must treat `null` as rejected and `changed: false` as already-there. `[Observed]`
- CAS: a lost `WHERE status = from` race is not a rejection — `applyTransition` re-reads and retries once, so `null` after the retry means the race survived twice or the edge became illegal (`runs-repository.ts:113-131`). `[Observed]`
- Checkpoint atomicity: checkpoint writes are single-statement in-DB merges (monotonic watermark via `greatest()`, `completedCallIds` union-deduped in SQL); callers must not read-modify-write checkpoints themselves. `[Observed]`
- Undo validation: unknown inverse op, store-time-truncated (`truncated: true`) restore, or `priorHash` mismatch → `{ ok: false }`, the journal row is kept, and nothing touches the filesystem (`runs-service.ts:53-66`). `[Observed]`

## Flow
1. Create: `runsGate.create({ agentId, channelId, workspaceId, runtimeType })` goes through the single write resolver `resolveWriteDb` (`runs-repository.ts:51`, called at `runs-repository.ts:80`): a dual-tier `workspaceId` resolves via `dbForWorkspace`; a local-only/workspace-less create resolves `getDb()` (or `null` when no database is configured → run-less execution). Readers use the same resolver family (`resolveDb`, `runs-repository.ts:69-71`), so write and read always land on the same handle for the same (absent) threading. `RUNS_ENABLED=false` short-circuits to `null` (`runs-repository.ts:74`). Env URLs are never consulted (`shared/config/database.ts:329-340`).
2. Start walk: Runtime opens the run and walks `created → starting → running` one `stateGate.applyRunTransition` per hop (`runtime-executor.ts:104,199`, `state/state-gate.ts:22`); each hop re-reads current status (`runs-repository.ts:114`), validates via `transition()` (`runs-repository.ts:117`), then updates with `WHERE id AND status = from` (`runs-repository.ts:123-127`), retrying once on a lost race (`runs-repository.ts:113-131`), and emits `run.status_changed` only when changed (`state-gate.ts:23-48`).
3. Mid-run transitions: tool/approval code moves `running ↔ waiting_for_tool / waiting_for_approval / retrying / compacting` via `runsGate.transition` (`tool-executor.ts:468,515,542,545,695,719,730,732`); approval expiry moves `waiting_for_approval → running` (`approval-sweeper.ts:41`).
4. Checkpoint: after each tool call, Runtime calls `touchCheckpoint(runId, { watermarkSeq, completedCallIds })`, which runs a single-statement `jsonb_set` merge with monotonic watermark and `jsonb_agg(distinct)` union (`runs-repository.ts:179-209`); numeric overload merges watermark only (`runs-repository.ts:164-178`); both return `false` when no row matched or the statement failed (`runs-repository.ts:177,209,212`). Heartbeat keeps `updatedAt` fresh every 15s (`runtime-executor.ts:136`, `touchRunHeartbeat` at `runs-repository.ts:216-225`, also boolean).
5. Compensation journal: before `write_file`/`edit_file`/`delete_file`, callers build an inverse via `buildCompensationInverse` (stores a 20k prefix for >20k priors, sha256 over the STORED content, `truncated: true` flag — `runs-repository.ts:274-294`) and append via `addCompensation` with `seq = max+1` and up to 5 `23505` retries (`runs-repository.ts:296-330`); callers `tool-registry.ts:269,321,402`, `coding-runtime.ts:233-241,348-356` (both coding-runtime handlers journal before `fs.writeFile` as of RUN-003, 2026-10-07).
6. Complete/fail/cancel: `closeRun` walks `completing → verifying → completed`, or `cancelling → cancelled`, or direct `→ failed` (`runtime-executor.ts:206-228`); gate shortcuts `complete`/`fail`/`cancel` wrap `applyTransition` (`runs-repository.ts:134,139,144`), with `cancel` doing the two-hop `cancelling → cancelled` inline and a checked first hop (a failed cancelling write returns instead of stranding, `runs-repository.ts:145-146`).
7. Orphan sweep: periodic `sweepOrphanedRuns` scans every workspace DB plus the shared handle. Two candidate tiers: LIVE states at `ORPHAN_AFTER_MS` (`orphan-sweep.ts:26-42`, excludes `waiting_for_approval`, includes self-heal `orphaned`/`cancelling`) and non-heartbeating `created`/`queued` at 10× (`PENDING_ORPHAN_AFTER_MS`, `orphan-sweep.ts:17-18`) so a queue backlog older than 60s but inside 10min is never reaped. Stale rows go `→ orphaned → resumable` with a `run.status_changed` emit per hop (`orphan-sweep.ts:97-104`); stranded `orphaned`/`cancelling` rows are self-healed to `resumable`/`cancelled` (`orphan-sweep.ts:81-95`); `FOR UPDATE SKIP LOCKED` batch of 50 (`orphan-sweep.ts:67-78`); workspace fan-out `orphan-sweep.ts:110` + shared-handle sweep `orphan-sweep.ts:114`.
8. Resume: `POST /api/runs/:id/resume` or `run:resume` socket calls `resumeRun` (`runs-service.ts:13-40`), which only accepts `status === 'resumable'`, transitions `→ queued`, emits `run.status_changed`, and returns `{ run, checkpoint }` (gate port `runs-gate.ts:44`, `routes/runs.ts:9`, `register-socket-server.ts:978`); route then re-enqueues via `queueGate.enqueueRun` (bullmq, `routes/runs.ts:19`) or inline `runtimeGate.execute` (`routes/runs.ts:55`); executor re-walks `queued → starting → running` and skips `completedCallIds` (`runtime-executor.ts:94-104`, dedupe `runtimes/agentic-runtime.ts:29,175-208`).
9. Undo: admin `POST /api/runs/:id/compensations/:compId/undo` or `run:compensation:undo` calls `undoCompensation` (`runs-service.ts:42-107`), which validates the stored inverse FIRST (unknown op / `truncated: true` / `priorHash` mismatch → `{ ok: false }`, journal row kept, `runs-service.ts:53-66`), then applies the `delete`/`restore` inverse under `Guard.validatePath`, deletes the row only on success, and returns `{ ok, entries }` — the route/socket caller owns the single `run.compensations` emit (`routes/runs.ts:83`, `register-socket-server.ts:1083`).

## Current Implementation
- `runs/run-state-machine.ts` → pure guard, no I/O. `RUN_STATES` lists 16 states (`run-state-machine.ts:1`); `TERMINAL_RUN_STATES = completed/failed/cancelled` (`run-state-machine.ts:22`); `TRANSITIONS` adjacency map — `created` includes `orphaned` so a non-heartbeating fresh run is reapable (`run-state-machine.ts:26-30`); `transition()/canTransition()/assertTransition()/isTerminal()/allowedTransitions()` (`run-state-machine.ts:69-117`).
- `runs/runs-repository.ts` → DB owner. ONE resolver pair for every read AND write: `resolveWriteDb` (`:51`, workspaceId → `dbForWorkspace`, else `getDb()` or null) and `resolveDb` (`:69`, read fallback to `getDb()`), so a row can never be written to one handle and read from another. Functions: `createRun`/`applyTransition` (CAS retry-once loop `:113-131`)/`completeRun`/`failRun`/`cancelRun`/`getRunById`/`touchCheckpoint`/`touchRunHeartbeat` (both boolean, `.returning` rowcount)/`buildCompensationInverse`/`addCompensation` (write-side resolver, degrades to `null`)/`listCompensations`/`getCompensation`/`deleteCompensation`/`listRunsByStatus` (gate port, guarded) plus `isRunsEnabled()` kill-switch.
- `runs/runs-service.ts` → composed ops. `resumeRun` (`resumable → queued` + emit + checkpoint return, `:13`) and `undoCompensation` (refusal-first validation, Guard-checked fs inverse, row delete only on success, returns entries for caller emit, `:42`).
- `runs/runs-gate.ts` → thin facade. Re-exports repository functions verbatim; adds `resumeRun`/`undoCompensation` ports (`:44,:50`); lazily delegates `sweepOrphanedRuns`/`startRunOrphanSweeper` to `orphan-sweep.ts` — the starter port is `async` (`:56-59`) so the boot `await` + try/catch actually works and import rejections surface.
- `runs/orphan-sweep.ts` → stale-run reaper. `LIVE_ORPHAN_STATUSES` (live states + self-heal `orphaned`/`cancelling`, excludes `waiting_for_approval` and `created`/`queued`) (`:26-42`); `PENDING_ORPHAN_STATUSES = created, queued` at 10× threshold (`:17-18`); `sweepOrphanedRuns` fans out via `forEachWorkspaceDb` + `runWithDb` (`:110`) then sweeps the shared handle too (`:114`); `startRunOrphanSweeper` interval timer with `unref` (`:121-128`). No stop/reset exports (removed — zero callers).
- State machine states: `created, queued, starting, running, waiting_for_tool, waiting_for_approval, retrying, compacting, completing, verifying, completed, failed, cancelled, cancelling, orphaned, resumable`. Guard location: `run-state-machine.ts:26` (map) enforced at `runs-repository.ts:117` (`transition(current.status, to)`) and `WHERE status = from` (`runs-repository.ts:123-127`).
- Types (from `db/schema.ts:50,69,969,976`): `RunStatus` (pgEnum `run_status`), `RunCheckpoint { watermarkSeq, completedCallIds, historyRef?, updatedAt }`, `CompensationInverseOp { op: delete|restore, path, priorHash?, priorContentRef? }` (service reads an extra `truncated?` flag from the JSONB), `RunRow`/`CompensationRow` (drizzle `$inferSelect`), `CreateRunInput { parentRunId?, agentId, channelId, workspaceId?, runtimeType }`, `CheckpointPatch { watermarkSeq?, completedCallIds?, historyRef? }`, `TransitionResult { row, from, to, changed, reason }`, `TransitionVerdict { ok, from, to, noop, reason }`.

## Ports
- `CreateRunInput` — input for creating a run row (agent/channel/workspace/runtime + optional parent).
- `RunRow` — `runs` record type.
- `TransitionResult` — `{ row, from, to, changed, reason }` transition outcome.
- `CheckpointPatch` — partial checkpoint merge input.
- `CompensationRow` — `runs_compensation` record type.
- `RunCheckpoint` — checkpoint JSON payload type.
- `CompensationInverseOp` — `delete | restore` inverse-op type.
- `RunStatus` — run status enum type (re-exported from `db/schema.ts`).
- `RunState` — state-machine state type (same value set as `RunStatus`).
- `TransitionVerdict` — `{ ok, from, to, noop, reason }` guard verdict type.
- `isTerminal` — true for `completed | failed | cancelled`.
- `runsGate.create` — inserts a `created` run; `null` when disabled or no database resolves (see `runs-gate.ts:30`).
- `runsGate.complete` — guarded transition to `completed`.
- `runsGate.fail` — guarded transition to `failed` with error code (default `RUN_FAILED`).
- `runsGate.cancel` — two-hop `cancelling → cancelled`. First hop checked - a failed cancelling write returns instead of stranding (2026-09-25 audit fix).
- `runsGate.touchCheckpoint` — atomic single-statement checkpoint merge (number or patch overload); `boolean`, `false` when no row matched or the statement failed.
- `runsGate.touchRunHeartbeat` — refreshes `updatedAt` only; `boolean`, `false` when no row matched.
- `runsGate.transition` — single guarded `applyTransition(runId, to, { reason, errorCode, workspaceId? })`. The optional `workspaceId` routes through the SAME resolver reads use; no external caller threads it yet, so unthreaded calls land on `getDb()` on both sides (consistent, but split-DB rows are only readable by callers that thread it — Gaps).
- `errorCode` is sticky (RUN-001 fixed): `undefined` leaves the stored code untouched so a reason-only hop never erases the last failure; explicit `null` clears it; a string sets it. Pinned by `apply-transition.test.ts` (preserves / explicit-null-clears cases).
- `cancelRun` returns the committed hop-1 (`cancelling`) row when hop 2 is rejected by a concurrent move (RUN-002 fixed); the orphan sweeper heals it from there instead of the caller reading a committed cancel as a failure.
- `cancelRun` returns the committed hop-1 (`cancelling`) row when hop 2 is rejected by a concurrent move (RUN-002 fixed); the orphan sweeper heals it from there instead of the caller reading a committed cancel as a failure. Checkpoint writes refuse terminal rows (RUN-010 fixed); compensation delete has a scoped `deleteRunCompensation(runId, compId)` variant (RUN-013 fixed); `getMetaByIds` serves cross-domain metadata (RUN-012 fixed).
- `CompensationInverseOp` carries the typed `truncated?: boolean` flag (RUN-005 fixed); `buildCompensationInverse` no longer casts to hide it.
- `runsGate.getById` — fetch one run by id (`null` when missing/disabled); optional `workspaceId`.
- `runsGate.resumeRun` — lives in `runs-service.ts` (gate only delegates): `resumable` -> `queued` + emit; returns `{ run, checkpoint }` or `null`.
- `runsGate.addCompensation` — appends journal row with monotonic `seq`; write-side resolver degrades to `null` (never throws) when no database resolves.
- `runsGate.listCompensations` — lists journal rows for a run ordered by `seq`.
- `runsGate.getCompensation` — fetches one journal row by `(runId, compId)`.
- `runsGate.deleteCompensation` — deletes one journal row (port since 2026-09-25; was imported but unexposed).
- `runsGate.listRunsByStatus` — rows by status set; `isRunsEnabled()`-guarded, `[]` on DB error. Gate port since 2026-09-25; still zero production callers (kept by closed decision Q3, Gaps notes the needle).
- `runsGate.undoCompensation` — lives in `runs-service.ts`: refusal-first (unknown op / truncated restore / hash mismatch → `{ ok: false }`, row kept), then applies inverse under Guard (via `tools-gate`, not past it), deletes row on success, returns `{ ok, error?, entries? }` WITHOUT emitting - the route/socket caller owns the single `run.compensations` emit (double-emit fix 2026-09-25).
- `runsGate.buildCompensationInverse` — `delete` for new files, `restore` (sha256 over the STORED content + `truncated: true` flag when the >20k prefix is clipped); the service REFUSES to apply flagged rows outright (silent-truncation fix 2026-09-26).
- `runsGate.sweepOrphanedRuns` — lazy delegate to `orphan-sweep.ts`; sweeps stale runs, returns count.
- `runsGate.startRunOrphanSweeper` — lazy delegate to `orphan-sweep.ts`; `async` (`Promise<void>`), awaits the dynamic import so boot try/catch sees failures (was a fire-and-forget `void`, fixed 2026-09-26).

## Relations
Gates this domain calls:
- `workspace-gate.ts` — `forEachWorkspaceDb` for multi-DB sweep fan-out (`orphan-sweep.ts:3,110`).
- `event-broker-gate.ts` — dynamic `EventBroker` for `run.status_changed` emits (`runs-service.ts:20`, `orphan-sweep.ts:44-58`); never subscribes.
- Non-gate internals used: `shared/config/database.ts` (`getDb`, `dbForWorkspace`, `runWithDb`, `isDatabaseConfigured`), `db/schema.ts` (table/type defs). Guard comes via `tools-gate.ts` (`runs-service.ts:85`); `channel-mount-gate` resolves the undo root (`runs-service.ts:73-78`).
Known outside callers of `runsGate`:
- Runtime: `runtime-executor.ts` (create `:197`, get, heartbeat `:136`; transitions via `stateGate.applyRunTransition` → `state/state-gate.ts:22`), `runtimes/agentic-runtime.ts` (touchCheckpoint `:273`), `runtimes/coding-runtime.ts` + `tools/tool-registry.ts` (buildInverse/addCompensation), `runtimes/research-runtime.ts` (child-run create/transition).
- Tools: `tool-executor.ts` (`waiting_for_approval ↔ running` walks).
- Routes: `routes/runs.ts` (resume `:9`/undo `:83`/compensations), `routes/approvals.ts` (get/transition on decision).
- Sockets: `shared/sockets/register-socket-server.ts` (create `:882`, resume `:978`, undo `:1083`, approval-resume `:1156`).
- Sweeps/bootstrap: `approvals/approval-sweeper.ts` (get/transition), `swarm/swarm-dispatcher.ts` (touchCheckpoint), `queue/maintenance-worker.ts` (`sweepOrphanedRuns` in bullmq mode, `:65`), `create-app.ts` (`startRunOrphanSweeper` on boot, `:376`).
- Type-only: `event-broker/event-types.ts` imports `RunStatus`.
Tables shared with other domains (FK → `runs.id`, owned by others or joint-read):
- `approval_requests.run_id` (Approvals), `delegations.parent_run_id/child_run_id`, `swarm_tasks.run_id`, `artifacts.run_id`, `token_usage_log.run_id` (all cascade/set-null readers of `runs`); `workspaces` (read-only `rootPath` lookup in `undoCompensation`).

## Emits-Listens
- `run.status_changed` (emits — `resumeRun` `runs-service.ts:22-37`, sweep `orphan-sweep.ts:44-58`; executor-driven emits happen in `state/state-gate.ts:30` from `TransitionResult` this domain returns)
- `run.compensations` (NOT emitted by this domain — `undoCompensation` returns `entries` and the route/socket caller emits once)

## Owns
- `runs` (writes: insert, status/checkpoint/heartbeat updates)
- `runs_compensation` (writes: insert, delete on successful undo only)

## Flags
- `RUNS_ENABLED` — `false` disables all writes/reads in repository (`runs-repository.ts:39`).
- `ORPHAN_AFTER_MS` — staleness threshold for live states, min 10s, default 60s (`orphan-sweep.ts:8-11`).
- Pending threshold — `created`/`queued` reuse the same env value ×10 (default 10min), derived constant `PENDING_ORPHAN_AFTER_MS` (`orphan-sweep.ts:17`); no separate env flag (ponytail).
- `ORPHAN_SWEEP_MS` — sweep interval, min 5s, default 30s (`orphan-sweep.ts:20-24`).

## Decisions
- Single choke point `applyTransition` for every status write + `WHERE status = from` guard. `[Observed]` — why: concurrent writers (executor, sweep, approvals) cannot skip the machine or clobber each other.
- One resolver for every runs read AND write (`resolveWriteDb`/`resolveDb`). `[Observed]` — why: split-DB correctness is a property of the repository, not of callers; a threaded `workspaceId` routes both sides to the workspace record DB, unthreaded calls land on `getDb()` for both write and read, so behavior is consistent regardless of threading. Workspace-less/local-only creates never leak into the shared pool on the write side (`resolveWriteDb` → `null` → degrade). `dbForWorkspace(null)` throws `NO_DATABASE` (`runs-repository.ts:51-71`) — reads do NOT mirror that throw; they fall back to `getDb()` so a handle is always returned.
- CAS loss ≠ illegal transition: retry the transition once on a lost `WHERE` race, then report the real outcome. `[Observed]` — why: callers (executor walk) must not treat a lost race as a state-machine rejection; illegal still returns `null`, retry-survived-twice warns and returns `null` (type unchanged for outside consumers).
- Terminal states immutable; `cancelling` is the only exit funnel to `cancelled`. `[Observed]` — why: cancel is async two-hop, sweep heals crashes between hops.
- Checkpoint as atomic in-DB `jsonb_set` merge with monotonic watermark + set-union dedupe. `[Observed]` — why: parallel `executeBatch` writers must not lose `completedCallIds` (see P04 comments).
- Checkpoint/heartbeat failures warn-and-swallow and return `false`, never throw. `[Observed]` — why: progress tracking is best-effort; a checkpoint error must not fail the run, but callers can now see the miss.
- Compensation journal with `UNIQUE(run_id, seq)` + up to 5 retries on `23505`; `restore` stores a 20k prefix with sha256 over the STORED content plus a `truncated` flag. `[Observed]` — why: ordered undo log without unbounded payload growth, and the hash makes silent corruption detectable.
- Undo validates before it mutates: unknown op / `truncated: true` / hash mismatch → `{ ok: false }` and the journal row is KEPT. `[Observed]` — why: a >20k store-time prefix must never be applied as if it were the prior content; the row survives for the operator (silent-truncation fix 2026-09-26).
- Undo executes filesystem inverse under `Guard.validatePath` and deletes the row only on success. `[Observed]` — why: undo is destructive, so path-escape checks precede mutation.
- Orphan path is two-hop `→ orphaned → resumable`, never direct to `failed`/`queued`. `[Inferred]` — why: preserves checkpoint for explicit resume decision instead of auto-retry or silent drop.
- `created`/`queued` are sweep candidates but at 10× the live threshold (`PENDING_ORPHAN_AFTER_MS`). `[Observed]` — why: neither state heartbeats (heartbeat only runs during execute, `runtime-executor.ts:134-138`), so the 60s live threshold would reap a merely-slow queue; at 10min a pending row is a genuine zombie (enqueue lost / worker gone) and reaping it to `resumable` still requires an explicit resume before re-execution. Dropped-`queued`-entirely would strand real zombies; reaping to `failed` would lose the checkpoint — threshold widening is the smallest fix that keeps both properties.
- `waiting_for_approval` excluded from sweep candidates; liveness depends on 15s heartbeat. `[Observed]` — why: approval waits (up to 5min) and long LLM calls outlive the 60s threshold.
- `resumeRun` only from `resumable`, returns checkpoint for caller to re-enqueue. `[Observed]` — why: Runs owns state, Queue/Runtime own delivery — resume context crosses the boundary as data, not execution.
- Gate does dynamic `import()` for broker/DB/Guard instead of top-level gate-to-gate imports. `[Inferred]` — why: avoids cycles and keeps the gate importable without booting brokers.

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this. Current code largely matches; metric emission is the gap.
Single choke point applyTransition for every status write, guarded by TRANSITIONS plus WHERE status equals from, with one retry on a lost CAS race. Direct run-table writes outside the repository are forbidden.
Terminal states completed, failed, cancelled are immutable except same-state no-op. cancelling is the only funnel to cancelled.
Checkpoint writes are atomic single-statement in-DB merges with monotonic watermark and set-union dedupe. Callers must not read-modify-write checkpoints.
Checkpoint and heartbeat failures warn-and-swallow plus metric emission. Silent console-only failure is not acceptable.
resumeRun accepts only resumable to queued, returns the checkpoint, and is single-use. Runs owns state; Queue and Runtime own delivery and execution.
Orphan path is two-hop to orphaned to resumable, never direct to failed or queued, preserving the checkpoint for an explicit resume decision. Non-heartbeating created/queued are candidates only past the pending threshold (10× ORPHAN_AFTER_MS).
waiting_for_approval is excluded from orphan sweep candidacy; approval liveness depends on the run heartbeat and the Approvals sweeper.
Undo refuses unknown/truncated/hash-mismatched inverse ops and keeps the journal row; it never applies store-time-truncated content.
CLOSED 2026-09-25: listRunsByStatus and deleteCompensation are gate ports.
RunStatus and RunState must share one source of truth with a compile-time equality check.
## User Decision (Open - awaiting operator choice)
Q1: Confirm metric emission for swallowed checkpoint and heartbeat errors, and name the metric sink.
Q2: Single source for the status value sets - DB enum or state-machine type - and who owns it?
Q3: CLOSED 2026-09-25 - both are public ports.
Q4: Confirm checkpointSeq mirror column is legacy and removable, or name its consumer.
## Failure + Resume
- Illegal transition / missing row / disabled domain → `applyTransition` returns `null`; same-state returns `{ changed: false }` (`runs-repository.ts:114-121`); a lost CAS race is retried once and only reports rejection if the retry also loses (`runs-repository.ts:113-131`); `complete`/`fail`/`cancel` map `null` to `null` row (`runs-repository.ts:134-149`); executor treats rejected walks as fatal and refuses stale execution (`runtime-executor.ts:250-254`).
- Checkpoint/heartbeat errors are caught, `console.warn`, and now return `false` (`runs-repository.ts:210-213,222-225`); `listCompensations`/`listRunsByStatus` return `[]` on DB error (`runs-repository.ts:270-272`, `runs-repository.ts:297-300`).
- Compensation insert retries up to 5 times on unique-violation `23505`, else warns and returns `null` (`runs-repository.ts:245-260`); `undoCompensation` returns `{ ok: false, error }` and keeps the row for: missing row, unknown inverse op, `truncated: true` restore, hash mismatch, no resolvable workspace root, Guard rejection, or fs error (`runs-service.ts:47-66,80-84,104-106`); `delete` inverse tolerates `ENOENT`, `restore` recreates parent dirs (`runs-service.ts:88-95`).
- Sweep failures are caught and warned per-DB, never throw (`orphan-sweep.ts:106-108`); `FOR UPDATE SKIP LOCKED` + limit 50 prevents worker contention (`orphan-sweep.ts:67-78`); timer uses `unref` so it never holds the process open (`orphan-sweep.ts:126`).
- Resume: only `resumable → queued` succeeds; any other status or missing row returns `null`, surfaced as HTTP 400 `run not resumable` or socket `not_resumable` (`runs-service.ts:14-18`, `routes/runs.ts:10-12`, `register-socket-server.ts:978`); second resume after `queued` returns `null` (single-use); executor re-walks to `running` and throws on stale end-state (`runtime-executor.ts:94-100`).
- Bootstrap: inline mode starts the sweeper on boot through the async gate port (`create-app.ts:375-377`); bullmq API mode suppresses local timers and delegates to the maintenance worker's repeatable `orphan-resume` job (`maintenance-worker.ts:65`).

## Gaps
- `CreateRunInput.parentRunId` is accepted by `runs-repository.ts:11` and the `runs.parent_run_id` FK exists; `research-runtime.ts` passes it through `runsGate.create` (no direct repository import).
- Split-DB threading is wired INSIDE the repository (write and read share one resolver) but NO caller outside `runs/` ever passes `workspaceId` into `transition`/`getById`/`touch*`/`resumeRun` — a row created WITH a workspaceId is only visible to readers that thread the same id. Until callers thread it, dual-tier runs effectively resolve both sides through `getDb()` only if the create is unthreaded. `shared/config/database.ts:325` ("workspace-handle threading is complete for runs") overstates this — file not owned by this domain, flagged for its owner (2026-09-26).
- `listRunsByStatus` is a gate port with zero production callers (guard + `[]`-on-error wired 2026-09-26; kept by closed decision Q3 — remove only if the operator reopens it).
- `runsGate.complete`/`fail`/`cancel` shortcuts have zero production callers (executor and sweeps drive their own walks); zombie rows are now reaped by the sweep instead, so the ports are conveniences, not load-bearing.
- `routes/runs.ts` resume returns HTTP 200 even when `queueGate.enqueueRun` throws (`:31-33`, logged only) or no agent resolves (`:48-54`) — route file not editable in the 2026-09-26 pass; fix belongs to Routes.
- `runtime-executor.ts:105-107` still logs-and-reuses a fetched run in a non-walkable status (e.g. a `resumable` row picked up without resume context): execution proceeds and the close walk then fails and is swallowed by `closeRun`'s catch (`:225-227`), leaving the row resumable for an explicit resume (checkpoint dedupe prevents double-execution). Executor not editable in this pass — Runtime to decide whether reuse should throw.
- `RunStatus` (DB enum) vs `RunState` (machine type) are duplicate value sets with no compile-time equality check; drift would only surface at runtime via `unknown state` verdicts.
- `undoCompensation` workspace-root resolution lives in `runs-service.ts` and fails loudly when no root resolves (no sandbox fallback); Guard comes via `tools-gate` (2026-09-25 audit fix).
- No `listens` observed in this domain; whether any worker subscribes to `run.status_changed` / `run.compensations` for side effects (vs socket fan-out only) was not traced beyond emit sites.
- `checkpointSeq` bigint column mirrors `checkpoint.watermarkSeq` but its consumer (ordering vs display vs resume cutoff) was not found — possible legacy duplicate.
- Env-flag minima (`ORPHAN_AFTER_MS >= 10s`, `ORPHAN_SWEEP_MS >= 5s`) silently clamp invalid values to defaults rather than erroring; operator misconfiguration is invisible.
- RUN-003 fixed 2026-10-07: both coding-runtime handlers now journal compensation BEFORE `fs.writeFile` (`coding-runtime.ts:233-241`, `348-356`); the "before mutate" claim in Flow item 5 is now true for every call site. Test: `apply-transition.test.ts:135`.
- RUN-004 fixed 2026-10-07: journal-insert failure now emits structured `logWarn` stage `runs.compensation_journal_failed` (`runs-repository.ts:318`) plus warn lines at `coding-runtime.ts:239/354` and `tool-registry.ts:273/324/406`. Test: `apply-transition.test.ts:158`.
- Drift: Flow item 5 stale refs FIXED in place 2026-10-07 (actual journal sites `tool-registry.ts:269,321,402`, `coding-runtime.ts:233-241,348-356`). Remaining cross-domain drift: Tools.md:126 still says journaling "failures swallowed" + stale ref `tool-registry.ts:288` — owned by Tools, not editable in this pass.
- RUN-006 fixed 2026-10-07: resume responses now carry additive `delivery: queued|inline|failed` (+ `deliveryDetail` on failure) — `routes/runs.ts:28,47,84,93` (HTTP 200 kept for compat) and `register-socket-server.ts:1028,1046-1050,1075,1078` (socket ack). Test: `apply-transition.test.ts:231`.
- RUN-026 fixed 2026-10-07: executor refuses a fetched row in any non-executable status without resumeContext (`runtime-executor.ts:108-111`, was warn-and-reuse); resume-context path unchanged (queued/resumable walks). Test: `apply-transition.test.ts:267`.
- RUN-030 fixed 2026-10-07: queue worker refuses the stale non-resume backlog job of a swept/resumed run - a row in `queued` (resume-exclusive) or `resumable` is skipped before any agent/executor work (`run-worker.ts:123-136`, `refuseNonResumeJob` `run-worker.ts:38-47`); resume jobs (resumeContext) pass through. Test: `apply-transition.test.ts:326`.
- RUN-031 fixed 2026-10-07: queue worker refuses `parentRunId` research child-trace rows (`child_trace_row`) before execution - the trace job no longer triggers a second runtime for the sub-question in bullmq mode (`run-worker.ts:42`). Test: `apply-transition.test.ts:347`.

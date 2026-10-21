# Queue

## Purpose
Durable delivery for run execution plus time-driven housekeeping. It owns BullMQ transport (three Redis queues, retries, repeatable jobs, workers) and bridges queued jobs into Runtime execution, with an inline no-op fallback so dev/test runs without Redis.

## Feature Scope
In-scope:
- Queue mode selection (`inline` vs `bullmq`) and Redis connection lifecycle.
- `runs` queue: deduped run-job enqueue + worker that resolves the agent and awaits full Runtime execution inline.
- `maintenance` queue: 9 repeatable housekeeping jobs (librarian delta, heartbeats, orphan sweeps, suppression expiry, retention, full snapshot, approval expiry, thread expiry — THR-007).
- `scheduler` queue: delayed/cron user-scheduled triggers that persist a system message and emit it; inline fires with a target agent also start that agent's run.
- Health probe (waiting/failed counts) and graceful drain (stop workers, close queues/connections).
Division of labor (Runs vs Queue vs Runtime):
- Runs owns run rows, the status state machine, checkpoints, and the compensation journal — Queue never writes run state.
- Queue owns delivery: transport, deduped jobIds, 3-attempt retries, repeatable scheduling, worker slots — it never executes agent logic itself.
- Runtime owns execution: routing, context assembly, LLM calls, tool loops, token accounting — Queue only hands it `(agent, channelId, userInput, runId)` and awaits the result.
Non-goals (other domains):
- Run lifecycle/state transitions → Runs (`runsGate.transition`, `resumeRun`, `sweepOrphanedRuns`).
- Prompt assembly, LLM calls, tool execution → Runtime (`runtimeGate.execute`).
- Schedule creation UX/cron parsing → Tools (`system_scheduler` tool calls `queueGate.getSchedulerQueue` directly).
- Approval policy/expiry decisions → Approvals (Queue only fires the `approval-expire` repeatable).
- Agent identity/heartbeat bookkeeping → Agents / Shared (`agent-heartbeat.ts` handlers).
- Transport payloads/auth → Routes/Sockets (call `queueGate`, never contain queue logic).

## Expect
- [Observed] Inline mode is a total no-op: `enqueueRun` returns `null`, `getFailedJobs` returns `[]`, `scheduleMaintenance`/workers return without connecting (`queues.ts:111-112`, `queues.ts:197`, `repeatables.ts:22`).
- [Observed] `enqueueRun` jobId is deterministic `{channelId}:{agentId}:{messageId}`; a duplicate jobId returns the existing id instead of throwing (`queues.ts:129-135`, `queues.ts:119`).
- [Observed] Callers must persist the run row BEFORE enqueueing and pass its real DB id; a provisional id can never match, so the executor would open a phantom row per retry (`register-socket-server.ts:874-882`, `register-socket-server.ts:888-898`).
- [Observed] Run jobs run the full multi-iteration runtime inside the worker process — no worker threads; long quiet stretches rely on 30s `updateProgress` + `extendLock` heartbeats, not lock renewal alone (`run-worker.ts:57-71`, `run-worker.ts:57-71`).
- [Observed] Maintenance dispatch matches on `job.name` first, `job.data.kind` second; unknown names/kinds return `null` silently (`maintenance-worker.ts:221`, `maintenance-worker.ts:239`).
- [Observed] `healthCheck` never throws: every Redis/queue probe is individually try/caught and degrades to `{ connected: false, waiting: 0, failed: 0 }` (`queue-gate.ts:11-14`, `queue-gate.ts:55`).
- [Observed] `drain` is best-effort per stage: each stop/close failure is logged and the rest still run (`queue-gate.ts:69-96`, `queue-gate.ts:77`).
- [Observed] 2026-10-20 (A3) An inline fire with `targetAgentId` starts one run after the message is persisted: busy rejection is shared with the socket trigger (`DuplicateRunError` / `Shared/core/active-runs.ts`), the channel pin is passed as both run `runtimeType` and `preferredRuntime`, and the run row is created via `runsGate` before `runtimeGate.execute`. Missing/paused/offline targets and busy pairs post a `System Warning` message instead of running. Rows without a target keep the old fan-out-only behavior.
- [Inferred] `getFailedJobs` only inspects the `runs` queue — failed maintenance/scheduler jobs have no gate-visible listing.

## Flow
1. Mode: `queueGate.mode()` reads `QUEUE_MODE` (`connection.ts:14-17`); anything but `bullmq` is `inline`, and `getRedisConnection`/`createRedisConnection` return `null` in inline mode (`connection.ts:29-31`, `connection.ts:41-42`).
2. Enqueue: `enqueueRun` returns `null` in inline mode (`queues.ts:111-112`); in bullmq mode it builds `jobId = channel:agent:message` (`queues.ts:111`) and adds a `run` job with 3 attempts + 60s exponential backoff + 1h/7d retention (`queues.ts:30-35`); duplicate jobId resolves to `{ id: jobId, jobId }` (`queues.ts:119`).
3. Socket fan-out: on user message in bullmq mode the socket layer persists one run row per target agent, enqueues with the real `runId`, and emits `run.queued` (`register-socket-server.ts:882-898`, `register-socket-server.ts:882-898`, `register-socket-server.ts:882-898`); paused/offline agents are filtered to warnings instead (`register-socket-server.ts:882-898`).
4. Run worker: `scheduleMaintenance` starts the run worker (`repeatables.ts:28`); `startRunWorker` opens a `runs` Worker with concurrency `max(1, min(4, DB_POOL_MAX - 6))`, 15min lock, 30s stall interval (`run-worker.ts:124-128`, `run-worker.ts:138-148`); `processRunJob` taps `tool:complete` for per-iteration `updateProgress`, runId-filtered (runId-less emitters count as before, `run-worker.ts:40-41`), heartbeats every 30s with `extendLock(token, 900000)` (`run-worker.ts:61-71`), resolves the agent via `getById` with `list()` fallback (`run-worker.ts:77-88`), then awaits `runtimeGate.execute({ agent, channelId, workspaceId, userInput, broker, explicitRuntime, runId, resumeContext })` — `explicitRuntime` travels in the job (`EnqueueRunInput.explicitRuntime`, socket-persisted) and is sanitized to known types, else Auto (`run-worker.ts`, `queues.ts:9`).
5. Maintenance scheduling: `scheduleMaintenance` starts run + maintenance workers, then `upsertJobScheduler` for each of the 9 `REPEATABLES` (`repeatables.ts:26`, `repeatables.ts:31` — `librarian-delta` 10m, `heartbeats-touch` 15s, `orphan-sweep` 20s, `orphan-resume` 30s, `suppress-expiry` 10m, `retention` 6h, `snapshot-full` 15s, `approval-expire` 30s, `thread-expire` 60s in `repeatables.ts:21`).
6. Maintenance execution: `maintenanceProcessor` routes `librarian-delta → IndexBuilder.reindexStaleChannels` (`maintenance-worker.ts:9`), `heartbeats-touch → touchWorkingAgents` (`maintenance-worker.ts:24-31`), `orphan-sweep → sweepOrphans` (`maintenance-worker.ts:41-51`), `orphan-resume → runsGate.sweepOrphanedRuns` (`maintenance-worker.ts:58-66`), `suppress-expiry → memoriesGate.runMemorySweep` (`maintenance-worker.ts:73-80`), `retention → spawn-retention + budget reconcile [spawn subsystem removed 2026-09-14] (`maintenance-worker.ts:93-99`), `snapshot-full → build + emit runtime:snapshot` (`maintenance-worker.ts:120-150`, `maintenance-worker.ts:202`), `approval-expire → sweepApprovalsOnce` (`maintenance-worker.ts:106-113`).
7. Scheduler: `schedulerProcessor` routes every `scheduled*` name (plus `kind`/task-shape fallbacks) to `handleScheduledTrigger` (`scheduler-worker.ts:91-104`); the handler persists a `system-scheduler` message in one transaction (sequence + insert) and emits `message:new`, falling back to an ephemeral emit when the DB is unreachable (`scheduler-worker.ts:30-50`, `scheduler-worker.ts:70`, `scheduler-worker.ts:51-70`); it then emits `scheduled:triggered` for observability (`scheduler-worker.ts:93`).
8. Tool-driven schedules: the `system_scheduler` tool persists the row first (`queueGate.saveSchedule`, A1) and then hands it to whichever tier owns timers. BullMQ mode books cron (`upsertJobScheduler`, `scheduled:cron`) or a delayed one-shot (`q.add`, `scheduled:trigger`); inline mode calls `queueGate.armSchedule`, and the Queue domain owns the `setTimeout`, the persisted `nextRun`, and the fire (`scheduler-rearm.ts`). Inline cron forms outside `*/N * * * *` (N 1-60) are rejected before the row is written. 2026-10-20 (A2). 2026-10-20 (A3): the inline fire then calls `dispatchScheduledRun(row, content, broker)`; a `targetAgentId` row starts one run for that agent, a row without one stays fan-out only, and the BullMQ worker path is not wired.
9. Resume: `POST /api/runs/:id/resume` calls `resumeRun`, then in bullmq mode enqueues with `runId` + extra `resumeContext`/`resumeFrom` payload, else executes inline via `runtimeGate.execute` fire-and-forget (`routes/runs.ts:9`, `routes/runs.ts:19`, `routes/runs.ts:35`).
10. Observe/drain: `healthCheck` pings Redis and sums `waiting+active+delayed` / `failed` across all three queues (`queue-gate.ts:11-14`, `queue-gate.ts:69-96`); `drain` stops run, maintenance, and scheduler workers, then closes queues and the shared connection, logging per-stage failures (`queue-gate.ts:60`).
11. Boot topology: the `worker` process requires bullmq mode, starts the approval sweeper, then `scheduleMaintenance` + `startSchedulerWorker`, and drains on SIGTERM/SIGINT with a 30s cap (`worker.ts:36-40`, `worker.ts:42-50`, `worker.ts:68-101`, `worker.ts:54`); the API process suppresses all local sweep timers in bullmq mode and probes Redis to warn when sweeps have no owner (`create-app.ts:391-396`, `create-app.ts:391-396`, `create-app.ts:406-409`). 2026-10-20 (A2): inline boot calls `queueGate.rearmSchedules()` and shutdown calls `queueGate.disarmAll()` (`create-app.ts`).
12. Inline re-arm/recalibration (`scheduler-rearm.ts`): `rearmSchedules(now)` lists active rows unscoped and, per row, recomputes the fire time from the wall clock instead of replaying history - an overdue one-shot fires once as catch-up then deactivates, a future one-shot arms the remainder, and a cron arms the next boundary strictly after `now` (missed ticks are skipped, never replayed). A cron the local tier cannot compute is reported in `skipped`, never fired at an unknown time. `armSchedule` clears any existing timer for the row before registering the new one, persists `nextRun`, and `unref`s the timer. BullMQ mode returns `{ mode: "bullmq", armed: 0, ... }` and touches nothing (Redis owns those timers). A run captures the timer generation before its list read, so a `disarmAll` that lands mid-rearm cancels it (nothing armed, nothing fired); concurrent calls are single-flight and share one report, so one overdue row cannot fire twice.
13. Inline target dispatch (`scheduler-dispatch.ts`, 2026-10-20 A3): `dispatchScheduledRun` returns immediately for a row with no `targetAgentId`. Otherwise it resolves the agent in the row's workspace (`agentGate.getById`), skips with the exact notice for missing/paused/offline, claims the shared busy key (`runKey`, `beginRun`; `DuplicateRunError` → notice, no run), reads the channel pin (`channelGate.getSettings`, failures degrade to `null`), creates the run row (`runsGate.create`, failure degrades to `runId: null` so the runtime creates it), then starts `runtimeGate.execute` with `runId`, the scheduled message as `userInput`, and the pin as `preferredRuntime`. It is started, not awaited, because boot re-arm awaits the fire; rejections are logged and the busy key is released in `finally`. Setup errors release the key and post `System error processing @<agent>: <message>`.

## Current Implementation
| File | Role |
| ---- | ---- |
| `queue/connection.ts` | Mode switch, Redis URL default, shared + fresh connections, close/reset helpers |
| `queue/queues.ts` | Queue singletons, job defaults, `enqueueRun` dedupe, `closeQueues`, `getFailedJobs`, `getJobOptions` |
| `queue/repeatables.ts` | 9 `REPEATABLES` specs, `scheduleMaintenance` (starts workers + upserts schedulers), `removeMaintenanceSchedulers` |
| `queue/run-worker.ts` | `runs` Worker: `processRunJob` bridge to `runtimeGate.execute` with progress/extendLock heartbeats |
| `queue/maintenance-worker.ts` | `maintenance` Worker: 9-handler processor (sweeps, snapshot emit, approval expiry, thread expiry) |
| `queue/scheduler-worker.ts` | `scheduler` Worker: trigger handler persisting + emitting scheduled messages |
| `queue/scheduler-local-store.ts` | Local file tier for scheduled tasks (`scheduler/scheduled_tasks.json`): persists a schedule before it is armed and owns the next-fire-time calculation |
| `queue/scheduler-rearm.ts` | Inline timer tier: `armSchedule`/`rearmSchedules`/`disarmAll`, boot recalibration, and the fire (`message:new` + `scheduled:triggered`) |
| `queue/scheduler-dispatch.ts` | Inline target dispatch: resolves the agent, applies busy/paused/offline/missing skips, reads the channel pin, persists the run row, starts `runtimeGate.execute` |
| `queue/queue-gate.ts` | Thin facade + locally-defined `healthCheck`/`drain`; exposes only the 15 gate ports |

Key functions/types: `getQueueMode` (`connection.ts:14`), `getRedisUrl` default `redis://localhost:6379` (`connection.ts:19-23`), `enqueueRun` (`queues.ts:111`), `getJobOptions` attempts 3 / backoff 60s-120s-240s / lock 15min (`queues.ts:173-181`), `RUNS_QUEUE_NAME`/`MAINTENANCE_QUEUE_NAME`/`SCHEDULER_QUEUE_NAME` (`queues.ts:5`), `resolveRunWorkerConcurrency` (`run-worker.ts:124-128`).

## Ports
- `EnqueueRunInput` — `{ runId?, channelId, agentId, messageId, userInput, workspaceId? }` run-job input; 2026-09-25: + optional `resumeContext?`/`resumeFrom?` (untyped ferry, checkpoint shape owned by runs), `enqueueRun` throws on empty channelId/agentId/messageId.
- `queueGate.mode` — returns `inline` or `bullmq` (`queue-gate.ts`).
- `queueGate.enqueueRun` — deduped `run` enqueue; `null` in inline mode.
- `queueGate.scheduleMaintenance` — starts run + maintenance workers, upserts the 9 repeatables.
- `queueGate.healthCheck` — `{ mode, connected, waiting, failed }` across all three queues; 2026-09-25: 2s per-Redis-call cap (`maxRetriesPerRequest:null` queues forever on outage).
- `queueGate.drain` — stops all three workers, closes queues and the shared connection.
- `queueGate.getFailedJobs` — failed `runs`-queue jobs with reasons (limit default 100, capped 200).
- `queueGate.getSchedulerQueue` — scheduler `Queue` or `null` (used by the Tools scheduler paths).
- `queueGate.startSchedulerWorker` — starts the scheduler worker (idempotent singleton).
- `queueGate.saveSchedule` — persists a schedule row (`scheduleInput`) in the workspace local store and returns the stored row. The Queue domain owns the next-fire-time calculation: a one-shot gets `now + delaySeconds`, an every-N-minutes cron gets its next boundary, and a cron form the local tier cannot track gets `nextRun: null`. Called by the Tools domain before the schedule is armed.
- `queueGate.listActiveSchedules` — active schedule rows; a named workspace reads only its own file, an unscoped call fans out over the candidate workspace scopes (boot re-arm).
- `queueGate.updateNextRun` — sets the next fire time of an existing schedule; `false` when no row matches.
- `queueGate.deactivateSchedule` — marks a schedule inactive (the row stays in the file as history); `false` when no row matches.
- `queueGate.armSchedule` — 2026-10-20 (A2) inline tier only: recomputes the fire time from `now` (cron → next boundary, one-shot → stored `nextRun`), persists it, replaces any existing timer for the row, and returns the armed row. No-op in bullmq mode.
- `queueGate.rearmSchedules` — 2026-10-20 (A2) boot re-arm: recalibrates every active row against the wall clock (overdue one-shot fires once as catch-up, future rows arm the remainder, cron arms the next boundary), returns `rearmReport { mode, armed, firedCatchUp, skipped }`. BullMQ mode reports `armed: 0` and arms nothing.
- `queueGate.disarmAll` — 2026-10-20 (A2) clears every inline timer (shutdown), leaving persisted rows untouched; it also bumps an internal generation so a fire or rearm already in flight cannot register a timer after shutdown.
- `rearmReport` — `{ mode, armed, firedCatchUp, skipped: { id, reason }[] }` type re-exported from `scheduler-rearm.ts`.

## Relations
Gates this domain calls (all dynamic `import()`, never top-level):
- `runtime-gate.ts` — `runtimeGate.execute` from the run worker (`run-worker.ts:15`).
- `agent-gate.ts` — `getById`/`list` agent resolution in the run worker (`run-worker.ts:77-88`).
- `event-broker-gate.ts` — single shared broker per job/handler, no fresh instance (`run-worker.ts:25-32`, `maintenance-worker.ts:11-14`).
- `runs-gate.ts` — `sweepOrphanedRuns` for `orphan-resume` (`maintenance-worker.ts:58`).
- `memories-gate.ts` — `runMemorySweep` for `suppress-expiry` (`maintenance-worker.ts:69`).
- 2026-10-20 (A2) inline fire path (`scheduler-rearm.ts`): `message-gate.ts` (`messageGate.append`, persist-then-emit with ephemeral fallback), `event-broker-gate.ts` (`getSharedBroker`), and `shared/sockets/register-socket-server.ts` (`globalBroker` fallback) are dynamic imports; the last one must stay dynamic because the socket server statically imports `queue-gate.ts`.
- 2026-10-20 (A3) target dispatch (`scheduler-dispatch.ts`), all dynamic imports: `agents/agent-gate.ts` (`getById`), `channels/channel-gate.ts` (`getSettings`), `runs/runs-gate.ts` (`create`), `runtime/runtime-gate.ts` (`execute`), `messages/message-gate.ts` (`append` for skip notices). The shared busy registry lives in `shared/core/active-runs.ts` (static, Shared is exempt).
- Non-gate internals used: `shared/core/index-builder.ts`, `shared/core/agent-heartbeat.ts`, `shared/core/token-tracker.ts`, `shared/core/sequence-number.ts` + `ulid.ts`, `approvals/approval-sweeper.ts`, `agents/agent-gate.ts` retention entry, `db/schema.ts` + `shared/config/database.ts` (scheduler/snapshot paths).
Verified outside callers of `queueGate`:
- `worker.ts` (mode gate, `scheduleMaintenance`, `startSchedulerWorker`, `drain`).
- `Shared/sockets/register-socket-server.ts` (mode checks, per-agent `enqueueRun`, resume re-enqueue at `:887`).
- `routes/runs.ts` (resume enqueue vs inline branch).
- `routes/queue.ts` + `routes/health.ts` (failed-jobs listing, health probe).
- `create-app.ts` (bullmq health probe on boot; `rearmSchedules` on inline boot + `disarmAll` on stop, A2).
- `tools/tool-registry.ts` (scheduler cron + delayed paths; `armSchedule` for inline, A2).
- `runtime/runtimes/research-runtime.ts` (mode read + optional sub-run trace enqueue at `:432`, `:485`).
Tables shared with other domains:
- `messages` (Queue WRITES scheduler-trigger rows; Messages owns the table — see Owns).

## Emits-Listens
- `runtime:snapshot` (emits, maintenance `snapshot-full`)
- `message:new` (emits, scheduler trigger persist/ephemeral)
- `scheduled:triggered` (emits, scheduler trigger + inline fire; payload id = schedule row id)
- `tool:complete` (taps — run worker subscribes per-job for `updateProgress` only, not a domain subscription)

## Owns
- BullMQ `runs` queue (writes: run jobs; reads: failed-job listing, counts)
- BullMQ `maintenance` queue (writes: 9 repeatable schedulers)
- BullMQ `scheduler` queue (writes: delayed + cron scheduled jobs; consumed by scheduler worker)
- `messages` (shared-write: scheduler-trigger persists only; Messages owns the table)
- Inline schedule timers (`scheduler-rearm.ts` timer map, `unref`'d) - process memory only; the durable fact is the persisted `nextRun` in the Queue local store (A2)

## Flags
- `QUEUE_MODE` — `bullmq` enables Redis/BullMQ; anything else (default `inline`) is no-op (`connection.ts:14`).
- `REDIS_URL` — Redis endpoint, default `redis://localhost:6379`; read only when connecting (`connection.ts:19-23`).
- `DB_POOL_MAX` — sizes run-worker concurrency as `max(1, min(4, poolMax - 6))`, default pool 20 (`run-worker.ts:124-128`).

## Decisions
- [Observed] Inline mode preserves synchronous behavior with zero Redis dependency — dev/tests never connect (`queues.ts:111-112`, `worker.ts:36-40`).
- [Observed] Compose default is api+postgres inline; redis+worker are opt-in behind `--profile queue` (`docker-compose.yml`). BullMQ stays for Murder-scale fan-out only — schema and topology freeze: no new queues/tables for §34-pending features.
- [Observed] Deterministic `channel:agent:message` jobId makes retries and double-delivery idempotent at the queue layer (`queues.ts:119`).
- [Observed] Attempts 3 with 60s exponential backoff and 15min lock: run jobs may block up to 5min on approval waits, so a shorter lock would false-stall busy jobs (`queues.ts:30-35`, `run-worker.ts:141-147`).
- [Observed] Single-owner sweeps: bullmq API suppresses local timers; the worker owns all repeatables via the maintenance queue (`create-app.ts:391-396`, `repeatables.ts:21`).
- [Observed] Scheduler persists before emitting and degrades to ephemeral emit when the DB is down — scheduled fire is honest either way (`scheduler-worker.ts:30-50`, `scheduler-worker.ts:51-70`).
- [Observed] Gate exposes `getSchedulerQueue` but NOT `getRunsQueue`/`getMaintenanceQueue` — only the Tools scheduler path gets raw queue access (`queue-gate.ts:98-106`).
- [Observed] Worker entry keeps `agentGate`/`memoriesGate` imports alive via `void` so bundling/tree-shaking keeps those domains linked (`worker.ts:33-34`).
- [Inferred] Per-queue Redis connections (one per queue + one per worker + shared) trade connection count for failure isolation — a wedged worker conn cannot block enqueue (`queues.ts:51-56`, `run-worker.ts:134`).
- [Observed] 2026-10-20 (A1) A schedule is persisted to the local store BEFORE it is armed, and a schedule that cannot be persisted is not armed at all — the tool call fails loudly instead of arming a schedule that dies with the process. The Queue domain computes `nextRun`; the Tools domain only states the intent (cron OR delay).
- [Observed] 2026-10-20 (A2) Inline timers are owned by the Queue domain (`scheduler-rearm.ts`), not by the Tools domain that requested them. The persisted row is the authority: boot recalibrates from the wall clock, so a restart neither loses a schedule nor replays missed cron ticks.
- [Observed] 2026-10-20 (A2) Catch-up policy is asymmetric on purpose: an overdue one-shot fires exactly once (the user asked for that one event and it is still meaningful), while cron skips missed boundaries (N missed ticks should not become N messages). Both rewrite `nextRun` so a second boot does not replay.
- [Observed] 2026-10-20 (A2) Inline cron that the local tier cannot compute is rejected at booking (`Unsupported cron for inline mode`) instead of being persisted with `nextRun: null`; `rearmSchedules` still skips-and-reports such a row if one exists from an older version. A persisted schedule that can never be armed is a silent loss.
- [Observed] 2026-10-20 (A3) A scheduled fire starts a run only when the row names a target agent. The run goes through the same gates as a socket trigger (agent status, shared busy key, channel pin, persisted run row), and the fire never awaits execution - boot re-arm must not block on a model call. BullMQ scheduling is intentionally not wired to the dispatcher in this change.
- [Inferred] The local tier tracks only the every-N-minutes cron form — the same form the inline scheduler accepts. Any other expression is left with `nextRun: null` (BullMQ owns it in bullmq mode); a tracked-but-uncomputable schedule would be re-armed at the wrong time, which is worse than not tracking it.

## User Decision:

## Architectural Standard (Target)

> Status: Target — documents the invariant new work must satisfy. Current code still uses channel:agent:message job identity and per-job fresh brokers as noted in Flow/Relations; do not claim the target as already implemented.

* Job identity MUST bind the durable runId (plus attempt) so a resumed run can never resolve to a stale completed job. The channel:agent:message key alone is retired as the sole identity.
* Resume delivery MUST be atomic with its report: the resume route MUST surface enqueue failure to the caller (no silent log-and-return-success). Inline resume MUST await execution or explicitly mark the fire-and-forget loss window.
* Workers MUST NOT rely on per-job fresh in-process brokers for events any consumer needs. Worker-produced events MUST publish via the durable cross-process transport defined in the EventBroker standard, until which the single-process limitation MUST be declared wherever BullMQ mode is offered.
* Failed maintenance and scheduler jobs MUST have gate-visible listing (extend getFailedJobs or add dedicated ports). Silent log-only housekeeping failure is not acceptable.

## User Decision (Open — awaiting operator choice)

* Q1: Confirm the runId-bound jobId format (e.g. run:<runId>:attempt:<n>) and whether the legacy key stays as a secondary dedupe hint.
* Q2: Is BullMQ a supported production topology, or is inline (desktop-forced) the production path with BullMQ as legacy? The docs currently claim both without ranking them.

## Failure + Resume
- Inline mode: every mutating op is a silent no-op (`null`/`[]`/`undefined`); callers must branch on `mode()` themselves — the gate never throws for being inline (`queues.ts:111-112`, `queues.ts:197`, `queue-gate.unit.test.ts:31`).
- Duplicate enqueue: BullMQ jobId conflict returns `{ id: jobId, jobId }` instead of throwing (`queues.ts:119`); unknown errors rethrow (`queues.ts:129-135`).
- Job failure: 3 attempts with 60s/120s/240s backoff (`queues.ts:173-181`); exhausted run jobs land in the DLQ surfaceable via `getFailedJobs` (7d `removeOnFail` retention in `queues.ts:30-35`); completed jobs age out after 1h (`queues.ts:30-35`).
- Worker crashes: `stalled`/`failed`/`error` events only log with jobId — no paging, no auto-recovery beyond BullMQ retry (`run-worker.ts:149-154`); 15min lock + 30s progress heartbeats keep long jobs from false-stalling (`run-worker.ts:57-71`).
- Maintenance handler failures log and rethrow so the job retries per queue backoff (`maintenance-worker.ts:18-20`); `handleRetention` runs spawn-retention then budget-reconcile, and a first-half failure still attempts the second half independently (`maintenance-worker.ts:87`).
- Scheduler DB outage: falls back to ephemeral `message:new` (sequenceNumber 0) then throws so BullMQ retries with backoff — 2026-09-25 fix, was silent success (`scheduler-worker.ts:51-70`).
- Inline fire failure: the timer callback never rejects; a failed fire logs, a failed persist degrades to an ephemeral `message:new`, and a missing broker warns and drops the message (no silent console-only fire). Boot re-arm failures are per-row: one bad row is reported in `skipped` and the rest still arm (`scheduler-rearm.ts`, A2).
- Drain: per-stage try/catch with `[queue] drain:` logging; worker SIGTERM/SIGINT path caps drain at 30s then force-exits (`queue-gate.ts:69-96`, `worker.ts:68-101`).
- Resume: `routes/runs.ts` enqueue failures only log (`request.log.error`) and still return the resumed run — the caller cannot tell delivery failed (`routes/runs.ts:31`); inline resume `execute` is fire-and-forget (`void`, `routes/runs.ts:55`).

## Gaps
- `getFailedJobs` covers only the `runs` queue; maintenance/scheduler failures are log-only with no listing port (`queues.ts:184-197`).
- `heartbeats-touch` actually touches (Q-1 fixed): `touchWorkingAgents` exported from `agent-heartbeat.ts` so the bullmq maintenance worker resolves it; live agents no longer risk orphan-sweep in bullmq mode.
- `stopRunWorker`/`stopMaintenanceWorker`/`stopSchedulerWorker` and `removeMaintenanceSchedulers` exist but are not gate ports — only `drain` can stop workers publicly (`queue-gate.ts:98-106`).
- Resume enqueue `resumeContext`/`resumeFrom` are now typed `EnqueueRunInput` optionals (2026-09-25); precedence (`resumeContext ?? resumeFrom ?? null`, worker `run-worker.ts:23`) still unenforced and `@ts-ignore` call sites not yet cleaned.
- Research sub-run trace enqueues use `messageId: res-sub-{idx}-{Date.now()}` (fresh per call, never deduped) and run fully inline anyway — purpose (audit noise vs real dispatch) is unverified (`research-runtime.ts:412-417`).
- Whether `run.queued` (emitted by the socket layer, not this domain) has any consumer beyond socket fan-out was not traced (`register-socket-server.ts:898`).
- `DB_POOL_MAX` couples Redis worker slots to the PG pool size; the `-6` headroom constant and interaction with concurrent API load are unverified (`run-worker.ts:124-128`).
- Inline timers remain process-memory only (a `setTimeout` cannot outlive the process); A2 makes that window non-silent by re-arming from the persisted row on boot, but a fire that was due while the process was down is caught up only for one-shots - cron skips it by design.
- The inline fire path emits through the in-process broker (`getSharedBroker` / `globalBroker`), so a fire in the API process reaches API sockets only; cross-process delivery in bullmq mode is a separate open item (see Architectural Standard).
- 2026-10-20 (A1) A schedule whose `nextRun` is `null` can still be produced by a direct `queueGate.saveSchedule` call; `rearmSchedules` skips and reports it rather than firing at an unknown time (A2).
- 2026-10-20 (A2, deferred to A3): in bullmq mode the store row is a record only. The BullMQ worker neither writes `nextRun` back nor deactivates one-shots after they fire, so active rows accumulate there; only a failed booking is compensated (the row is deactivated before the error is returned). Known gap, not fixed.
- 2026-10-20 (A2): inline catch-up is at-least-once, not exactly-once. If `localDeactivateSchedule` fails after a one-shot fire (an fs error), the row stays active and the next boot replays it. Known, not fixed.

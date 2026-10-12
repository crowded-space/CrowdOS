# Queue

## Purpose
Durable delivery for run execution plus time-driven housekeeping. It owns BullMQ transport (three Redis queues, retries, repeatable jobs, workers) and bridges queued jobs into Runtime execution, with an inline no-op fallback so dev/test runs without Redis.

## Feature Scope
In-scope:
- Queue mode selection (`inline` vs `bullmq`) and Redis connection lifecycle.
- `runs` queue: deduped run-job enqueue + worker that resolves the agent and awaits full Runtime execution inline.
- `maintenance` queue: 9 repeatable housekeeping jobs (librarian delta, heartbeats, orphan sweeps, suppression expiry, retention, full snapshot, approval expiry, thread expiry — THR-007).
- `scheduler` queue: delayed/cron user-scheduled triggers that persist a system message and emit it.
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
- [Inferred] `getFailedJobs` only inspects the `runs` queue — failed maintenance/scheduler jobs have no gate-visible listing.

## Flow
1. Mode: `queueGate.mode()` reads `QUEUE_MODE` (`connection.ts:14-17`); anything but `bullmq` is `inline`, and `getRedisConnection`/`createRedisConnection` return `null` in inline mode (`connection.ts:29-31`, `connection.ts:41-42`).
2. Enqueue: `enqueueRun` returns `null` in inline mode (`queues.ts:111-112`); in bullmq mode it builds `jobId = channel:agent:message` (`queues.ts:111`) and adds a `run` job with 3 attempts + 60s exponential backoff + 1h/7d retention (`queues.ts:30-35`); duplicate jobId resolves to `{ id: jobId, jobId }` (`queues.ts:119`).
3. Socket fan-out: on user message in bullmq mode the socket layer persists one run row per target agent, enqueues with the real `runId`, and emits `run.queued` (`register-socket-server.ts:882-898`, `register-socket-server.ts:882-898`, `register-socket-server.ts:882-898`); paused/offline agents are filtered to warnings instead (`register-socket-server.ts:882-898`).
4. Run worker: `scheduleMaintenance` starts the run worker (`repeatables.ts:28`); `startRunWorker` opens a `runs` Worker with concurrency `max(1, min(4, DB_POOL_MAX - 6))`, 15min lock, 30s stall interval (`run-worker.ts:124-128`, `run-worker.ts:138-148`); `processRunJob` taps `tool:complete` for per-iteration `updateProgress`, runId-filtered (runId-less emitters count as before, `run-worker.ts:40-41`), heartbeats every 30s with `extendLock(token, 900000)` (`run-worker.ts:61-71`), resolves the agent via `getById` with `list()` fallback (`run-worker.ts:77-88`), then awaits `runtimeGate.execute({ agent, channelId, workspaceId, userInput, broker, explicitRuntime, runId, resumeContext })` — `explicitRuntime` travels in the job (`EnqueueRunInput.explicitRuntime`, socket-persisted) and is sanitized to known types, else Auto (`run-worker.ts`, `queues.ts:9`).
5. Maintenance scheduling: `scheduleMaintenance` starts run + maintenance workers, then `upsertJobScheduler` for each of the 9 `REPEATABLES` (`repeatables.ts:26`, `repeatables.ts:31` — `librarian-delta` 10m, `heartbeats-touch` 15s, `orphan-sweep` 20s, `orphan-resume` 30s, `suppress-expiry` 10m, `retention` 6h, `snapshot-full` 15s, `approval-expire` 30s, `thread-expire` 60s in `repeatables.ts:21`).
6. Maintenance execution: `maintenanceProcessor` routes `librarian-delta → IndexBuilder.reindexStaleChannels` (`maintenance-worker.ts:9`), `heartbeats-touch → touchWorkingAgents` (`maintenance-worker.ts:24-31`), `orphan-sweep → sweepOrphans` (`maintenance-worker.ts:41-51`), `orphan-resume → runsGate.sweepOrphanedRuns` (`maintenance-worker.ts:58-66`), `suppress-expiry → memoriesGate.runMemorySweep` (`maintenance-worker.ts:73-80`), `retention → spawn-retention + budget reconcile [spawn subsystem removed 2026-09-14] (`maintenance-worker.ts:93-99`), `snapshot-full → build + emit runtime:snapshot` (`maintenance-worker.ts:120-150`, `maintenance-worker.ts:202`), `approval-expire → sweepApprovalsOnce` (`maintenance-worker.ts:106-113`).
7. Scheduler: `schedulerProcessor` routes every `scheduled*` name (plus `kind`/task-shape fallbacks) to `handleScheduledTrigger` (`scheduler-worker.ts:91-104`); the handler persists a `system-scheduler` message in one transaction (sequence + insert) and emits `message:new`, falling back to an ephemeral emit when the DB is unreachable (`scheduler-worker.ts:30-50`, `scheduler-worker.ts:70`, `scheduler-worker.ts:51-70`); it then emits `scheduled:triggered` for observability (`scheduler-worker.ts:93`).
8. Tool-driven schedules: the `system_scheduler` tool uses `queueGate.mode()` + `getSchedulerQueue()` + `startSchedulerWorker()` for cron (`upsertJobScheduler`, `scheduled:cron`) and one-shot delayed (`q.add`, `scheduled:trigger`) paths, with an inline `setInterval` fallback when bullmq is unavailable (`tool-registry.ts:671-680`, `tool-registry.ts:671-680`, `tool-registry.ts:728-745`, `tool-registry.ts:728-745`).
9. Resume: `POST /api/runs/:id/resume` calls `resumeRun`, then in bullmq mode enqueues with `runId` + extra `resumeContext`/`resumeFrom` payload, else executes inline via `runtimeGate.execute` fire-and-forget (`routes/runs.ts:9`, `routes/runs.ts:19`, `routes/runs.ts:35`).
10. Observe/drain: `healthCheck` pings Redis and sums `waiting+active+delayed` / `failed` across all three queues (`queue-gate.ts:11-14`, `queue-gate.ts:69-96`); `drain` stops run, maintenance, and scheduler workers, then closes queues and the shared connection, logging per-stage failures (`queue-gate.ts:60`).
11. Boot topology: the `worker` process requires bullmq mode, starts the approval sweeper, then `scheduleMaintenance` + `startSchedulerWorker`, and drains on SIGTERM/SIGINT with a 30s cap (`worker.ts:36-40`, `worker.ts:42-50`, `worker.ts:68-101`, `worker.ts:54`); the API process suppresses all local sweep timers in bullmq mode and probes Redis to warn when sweeps have no owner (`create-app.ts:391-396`, `create-app.ts:391-396`, `create-app.ts:406-409`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `queue/connection.ts` | Mode switch, Redis URL default, shared + fresh connections, close/reset helpers |
| `queue/queues.ts` | Queue singletons, job defaults, `enqueueRun` dedupe, `closeQueues`, `getFailedJobs`, `getJobOptions` |
| `queue/repeatables.ts` | 9 `REPEATABLES` specs, `scheduleMaintenance` (starts workers + upserts schedulers), `removeMaintenanceSchedulers` |
| `queue/run-worker.ts` | `runs` Worker: `processRunJob` bridge to `runtimeGate.execute` with progress/extendLock heartbeats |
| `queue/maintenance-worker.ts` | `maintenance` Worker: 9-handler processor (sweeps, snapshot emit, approval expiry, thread expiry) |
| `queue/scheduler-worker.ts` | `scheduler` Worker: trigger handler persisting + emitting scheduled messages |
| `queue/queue-gate.ts` | Thin facade + locally-defined `healthCheck`/`drain`; exposes only the 8 gate ports |

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

## Relations
Gates this domain calls (all dynamic `import()`, never top-level):
- `runtime-gate.ts` — `runtimeGate.execute` from the run worker (`run-worker.ts:15`).
- `agent-gate.ts` — `getById`/`list` agent resolution in the run worker (`run-worker.ts:77-88`).
- `event-broker-gate.ts` — single shared broker per job/handler, no fresh instance (`run-worker.ts:25-32`, `maintenance-worker.ts:11-14`).
- `runs-gate.ts` — `sweepOrphanedRuns` for `orphan-resume` (`maintenance-worker.ts:58`).
- `memories-gate.ts` — `runMemorySweep` for `suppress-expiry` (`maintenance-worker.ts:69`).
- Non-gate internals used: `shared/core/index-builder.ts`, `shared/core/agent-heartbeat.ts`, `shared/core/token-tracker.ts`, `shared/core/sequence-number.ts` + `ulid.ts`, `approvals/approval-sweeper.ts`, `agents/agent-gate.ts` retention entry, `db/schema.ts` + `shared/config/database.ts` (scheduler/snapshot paths).
Verified outside callers of `queueGate`:
- `worker.ts` (mode gate, `scheduleMaintenance`, `startSchedulerWorker`, `drain`).
- `Shared/sockets/register-socket-server.ts` (mode checks, per-agent `enqueueRun`, resume re-enqueue at `:887`).
- `routes/runs.ts` (resume enqueue vs inline branch).
- `routes/queue.ts` + `routes/health.ts` (failed-jobs listing, health probe).
- `create-app.ts` (bullmq health probe on boot).
- `tools/tool-registry.ts` (scheduler cron + delayed paths).
- `runtime/runtimes/research-runtime.ts` (mode read + optional sub-run trace enqueue at `:432`, `:485`).
Tables shared with other domains:
- `messages` (Queue WRITES scheduler-trigger rows; Messages owns the table — see Owns).

## Emits-Listens
- `runtime:snapshot` (emits, maintenance `snapshot-full`)
- `message:new` (emits, scheduler trigger persist/ephemeral)
- `scheduled:triggered` (emits, scheduler trigger + Tools inline fallback)
- `tool:complete` (taps — run worker subscribes per-job for `updateProgress` only, not a domain subscription)

## Owns
- BullMQ `runs` queue (writes: run jobs; reads: failed-job listing, counts)
- BullMQ `maintenance` queue (writes: 9 repeatable schedulers)
- BullMQ `scheduler` queue (writes: delayed + cron scheduled jobs; consumed by scheduler worker)
- `messages` (shared-write: scheduler-trigger persists only; Messages owns the table)

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
- Scheduler one-shot `delayMs` path and inline `setInterval` fallback lifecycles (leak on restart, no persistence) were not exhaustively traced past `tool-registry.ts:725`, `tool-registry.ts:761-766`.

# Queue delivery and housekeeping
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Runs must reach execution exactly once even when producers retry, and periodic housekeeping must run somewhere exactly once without every process firing its own timers. This feature exists so enqueue is idempotent at the transport layer and time-driven work (sweeps, heartbeats, retention, snapshots) has a single owner per deployment topology.

## Architectural decision
Delivery and scheduling are separated from state and execution: Queue never writes run rows and never runs agent logic — it hands `(agent, channelId, userInput, runId)` to Runtime and awaits the result `[Observed]`. Enqueue idempotency uses a deterministic `channel:agent:message` jobId so retries and double-delivery collapse to one job instead of throwing `[Observed]`. Inline mode is a total no-op (no Redis, `enqueueRun` returns `null`) so dev and tests never connect `[Observed]`. In bullmq mode a single owner holds all timers: the API suppresses local sweep timers and the worker owns the repeatables via the maintenance queue `[Observed]`. The rejected alternative is per-process timers plus caller-side dedupe; the shipped shape puts dedupe in the jobId and ownership in the worker topology `[Inferred]`.

## How it works
Mode comes from `QUEUE_MODE` — anything but `bullmq` is `inline`, and connections return `null` in inline mode. In bullmq mode `enqueueRun` builds the deterministic jobId and adds a `run` job with 3 attempts, 60s exponential backoff, and 1h/7d retention; a duplicate jobId resolves to the existing id. On a user message the socket layer persists one run row per target agent first (a provisional id would never match, so the real DB id is required), enqueues with it, and emits `run.queued`; paused/offline agents become warnings instead. The `runs` worker runs the full multi-iteration runtime inside the worker process (no worker threads), keeping long jobs alive with 30s `updateProgress` plus `extendLock` heartbeats against a 15min lock, with concurrency derived from `DB_POOL_MAX`. The `maintenance` queue holds 9 repeatables (`librarian-delta`, `heartbeats-touch`, `orphan-sweep`, `orphan-resume`, `suppress-expiry`, `retention`, `snapshot-full`, `approval-expire`, `thread-expire` 60s — THR-007) upserted via `upsertJobScheduler`, each dispatched by `job.name` first and `job.data.kind` second. The `scheduler` queue carries delayed and cron user triggers: the handler appends a `system-scheduler` message via `messageGate.append` (ephemeral emit when the DB is down), then emits `scheduled:triggered`. The `system_scheduler` tool books BullMQ jobs in bullmq mode and falls back to honest inline timers otherwise. `healthCheck` pings Redis and sums waiting/failed across all three queues without ever throwing; `drain` stops all three workers then closes queues and connections, best-effort per stage. Boot topology: the `worker` process requires bullmq mode and drains on SIGTERM/SIGINT with a 30s cap; the API process probes Redis to warn when sweeps have no owner.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Queue.md> | Owns transport, deduped jobIds, retries, the 9 repeatables, scheduler triggers, health probe, and drain |
| <../Domain Spec/Runs.md> | Owns run rows, the status machine, checkpoints, and the compensation journal — Queue never writes run state |
| <../Domain Spec/Runtime.md> | Owns execution: routing, context assembly, LLM calls, tool loops — Queue only hands over `(agent, channelId, userInput, runId)` |
| <../Domain Spec/Tools.md> | Owns schedule creation UX: the `system_scheduler` tool calls `queueGate.getSchedulerQueue` directly |
| <../Domain Spec/Approvals.md> | Owns approval policy and expiry decisions — Queue only fires the `approval-expire` repeatable |
| <./Recovery and resume.md> | Owns the resumed-run delivery timeline (`resumeRun` → re-enqueue with `resumeContext` → worker handoff) — see that doc, not duplicated here |

## Current state
Real in both modes: inline no-op behavior, deterministic jobId dedupe, 3-attempt run jobs with backoff, the 9 repeatables with name-first dispatch, scheduler persist-then-emit with ephemeral fallback, non-throwing health probe, and best-effort drain. Bullmq-only: run-worker bridge into `runtimeGate.execute`, single-owner sweep topology, cron/delayed scheduler jobs. Nothing in this feature is stub or flag-gated beyond `QUEUE_MODE` itself selecting the transport. Known rough edges that are real: `getFailedJobs` covers only the `runs` queue, resume extras ride outside the typed input, and inline resume plus bullmq enqueue failures are fire-and-forget/log-only.

## Alignment notes
`none found` — sampled claims verified: deterministic jobId and duplicate resolution (`queues.ts:108-121`), inline no-op returns, the 9 `REPEATABLES` with `upsertJobScheduler` (`repeatables.ts:10-36`), run-worker concurrency/lock/heartbeat shape (`run-worker.ts`), per-stage drain, and the single-owner sweep split (`create-app.ts` vs worker entry). No contradiction between the Queue domain doc and cited code on the sampled paths. 2026-10-07: `thread-expire` (60s) added to `REPEATABLES` and dispatched to `handleThreadExpire` (`maintenance-worker.ts:130`), which sweeps each workspace DB + the ambient handle via `threadGate.archiveExpired` (THR-007).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Job identity binds runId plus attempt. channel:agent:message alone is retired as sole identity.
* Resume delivery is atomic with its report. Silent log-and-return-success is forbidden.
* Workers never rely on per-job fresh brokers for needed events. Durable cross-process transport or declared single-process limit. Failed maintenance and scheduler jobs have gate-visible listing. Authority: Queue, EventBroker standards.
## Open gaps
- `getFailedJobs` covers only the `runs` queue; maintenance/scheduler failures are log-only with no listing port.
- Stop/remove-scheduler helpers exist but are not gate ports — only `drain` can stop workers publicly.
- Resume payload typing and precedence (`resumeContext` over `resumeFrom`) are unenforced (`routes/runs.ts`, `run-worker.ts`).
- Research sub-run trace enqueues use fresh per-call `messageId`s and run inline anyway — purpose unverified.
- Whether `run.queued` has any consumer beyond socket fan-out was not traced.
- `DB_POOL_MAX - 6` headroom coupling worker slots to the PG pool is unverified under concurrent API load.
- Scheduler one-shot `delayMs` and inline `setInterval` fallback lifecycles (leak on restart, no persistence) were not exhaustively traced.

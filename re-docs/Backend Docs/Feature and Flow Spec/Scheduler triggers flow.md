# Scheduler triggers flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
An agent (or operator) can ask for work to happen later — once after a delay or repeatedly on a cron — without holding a run open. This flow exists so a schedule booking becomes a durable BullMQ job (or an honest inline timer when Redis is absent) that fires by persisting a real `system-scheduler` message and emitting it, whether or not anything downstream starts a run.

## Architectural decision
Persist-before-emit with an ephemeral fallback: the fire handler writes the `system-scheduler` message via `messageGate.append` (sequence + insert + `message:new`) first, degrading to an unpersisted (sequenceNumber 0) emit when the DB is down — so a scheduled fire is honest either way `[Observed]` (`scheduler-worker.ts:42-90`, `message-service.ts:387-406`). Booking and firing are split across domains: Tools owns the schedule-creation UX (cron parsing, BullMQ booking, inline fallback), Queue owns the durable trigger (scheduler queue + worker + emits), Messages owns the row `[Observed]`. Inline mode never pretends to be durable: one-shot delays become `setTimeout`, crons become `setInterval` (only `*/N * * * *` understood, else a silent 60s fixed interval), all tracked in memory-only `activeSchedules` that restarts lose `[Observed]` (`tool-registry.ts:599-653`).

## How it works
1. The `system_scheduler` tool (absent when `SYSTEM_SCHEDULER_ENABLED=false`) takes a channel task plus either a cron expression or a `delayMs`: the cron path books a repeatable BullMQ job via `upsertJobScheduler` (`scheduled:cron`), the one-shot path adds a delayed job (`scheduled:trigger`) — both carrying channel/task/message/workspace (`tool-registry.ts:554-591`).
2. When BullMQ is unavailable, the same call falls back to honest inline timers: `setInterval` for cron, `setTimeout` for one-shots, each firing `honestSchedulerEmit` and tracked in `activeSchedules` (`tool-registry.ts:603-653`).
3. In bullmq mode the scheduler worker (started via `startSchedulerWorker`, idempotent singleton) routes every `scheduled*` name — plus `kind`/task-shape fallbacks — to `handleScheduledTrigger` (`scheduler-worker.ts:91-104`).
4. The handler persists a `system-scheduler` message via `messageGate.append` (sequence + insert + `message:new`) (`scheduler-worker.ts:43-71`); when the DB is unreachable it emits an ephemeral `message:new` (sequenceNumber 0, unpersisted id) instead (`scheduler-worker.ts:72-90`).
5. It then emits `scheduled:triggered` for observability (`scheduler-worker.ts:93`); the Tools inline fallback emits the same event alongside its message (`tool-registry.ts:131`).
6. Downstream of the emit, delivery is socket fan-out (`message:new` to the channel); whether any trigger automatically starts a run — and which agent it would run as — was not observed (see gaps).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Tools.md> | Owns schedule creation UX: the `system_scheduler` tool (cron/delayed booking, inline timer fallback, `activeSchedules`) |
| <../Domain Spec/Queue.md> | Owns the durable trigger: scheduler queue, `schedulerProcessor` → `handleScheduledTrigger`, persist-then-emit, `scheduled:triggered` |
| <../Domain Spec/Messages.md> | Sole owner of the `messages` table; the trigger row goes through `messageGate.append` |
| <./Queue delivery and housekeeping.md> | Owns the transport topology (inline no-op vs bullmq, repeatables, drain, health) — see that doc, not duplicated here |

## Current state
Real in both modes: BullMQ delayed + repeatable (cron) bookings, transactional persist-then-emit firing, ephemeral fallback on DB outage, `scheduled:triggered` observability emit, inline `setTimeout`/`setInterval` fallbacks, `SYSTEM_SCHEDULER_ENABLED` kill-switch (default on). Bullmq-only: durable jobs that survive restarts. Nothing in this flow is stub beyond the inline cron's `*/N`-only parsing.

## Alignment notes
`none found` — sampled claims verified: cron vs one-shot booking paths (`tool-registry.ts:554-591`), inline fallbacks (`tool-registry.ts:603-653`), transactional persist + `message:new` (`scheduler-worker.ts:42-70`), ephemeral fallback (`scheduler-worker.ts:73-87`), `scheduled:triggered` emit (`scheduler-worker.ts:93`), worker routing (`scheduler-worker.ts:91-104`). No contradiction between the Queue/Tools domain docs and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Scheduler fire has an explicit run contract: whether it starts a run, as which agent, via which enqueue path. Trails ending at fan-out are forbidden.
* Inline schedules are durable or explicitly ephemeral with a documented loss window. Silent restart loss is forbidden.
* Inline cron either supports full cron or rejects non-conforming expressions. Silent 60s fallback is forbidden.
* Scheduler-queue failures have gate-visible listing. Log-only scheduler failures are forbidden. Stop and remove helpers are gate ports or explicitly drain-only. Authority: Queue, Tools standards.
## Open gaps
- Whether a scheduler fire starts a run (and if so, as which agent, via which enqueue path) was not observed — the trail ends at `message:new` + `scheduled:triggered` fan-out.
- Inline schedules live in memory-only `activeSchedules` — restarts lose them silently, and the one-shot `delayMs` lifecycle was not exhaustively traced.
- Inline cron understands only `*/N * * * *`; any other expression becomes a silent 60s fixed interval — misconfiguration is invisible.
- Scheduler-queue job failures are log-only with no gate-visible listing (`getFailedJobs` covers only the `runs` queue).
- Stop/remove-scheduler helpers exist but are not gate ports — only `drain` can stop scheduler workers publicly.

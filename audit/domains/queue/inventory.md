# Queue Domain — Inventory (READ-ONLY audit, phases 1–4)
Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd
Branch: main @ 22bb8a0 (no branch created; no commits; git unchanged except audit/)
Scope: packages/server/src/queue + its callers, routes, jobs, persistence, events, config, tests.

## Files (9, all read)
| File | LoC(ish) | Role |
| --- | --- | --- |
| connection.ts | 68 | Mode switch, REDIS_URL default, shared/fresh Redis conns, close/reset |
| queues.ts | 218 | 3 Queue singletons + per-queue conns, job defaults, enqueueRun dedupe, closeQueues, getJobOptions, getFailedJobs |
| repeatables.ts | 56 | 8 REPEATABLES specs; scheduleMaintenance (starts run+maintenance workers, upserts schedulers); removeMaintenanceSchedulers |
| run-worker.ts | 191 | runs Worker: processRunJob → runtimeGate.execute inside runWithDb(dbForWorkspace(ws)) tenant scope (SH-002, 2026-10-07), progress/extendLock heartbeats, agent resolve, stall tuning |
| maintenance-worker.ts | 308 | maintenance Worker: 8 handlers (librarian-delta, heartbeats-touch, orphan-sweep, orphan-resume, suppress-expiry, retention, snapshot-full, approval-expire) |
| scheduler-worker.ts | 158 | scheduler Worker: scheduled:* → persist+emit system message, scheduled:triggered emit |
| queue-gate.ts | 107 | Facade: mode, enqueueRun, scheduleMaintenance, healthCheck, drain, getFailedJobs, getSchedulerQueue, startSchedulerWorker + EnqueueRunInput type |
| queue-gate.unit.test.ts | 119 | Inline-mode unit tests (imports internals in-domain; allowed) |
| queue.integration.test.ts | 165 | Opt-in real-Redis tests (QUEUE_MODE=bullmq or RUN_REDIS_INTEGRATION=1) |

## Exact gate exports (queue-gate.ts)
- type: EnqueueRunInput (queue-gate.ts:9)
- const queueGate (queue-gate.ts:98–107): mode, enqueueRun, scheduleMaintenance, healthCheck, drain, getFailedJobs, getSchedulerQueue, startSchedulerWorker (8 methods)

## Importers
Past-the-gate imports (production): NONE. check-gates.mjs: 0 violations for queue.
In-domain test imports of internals: queue-gate.unit.test.ts:18,69,79,85–86,92,101; queue.integration.test.ts:74,123,133 (allowed by AGENTS §2).
Gate consumers (verified):
- worker.ts:1,17,36,54,57,80 (boot mode gate, scheduleMaintenance, startSchedulerWorker, drain)
- create-app.ts:31,399 (boot Redis probe)
- routes/health.ts:2,16 (GET /api/health → queue section, 5s cache + 500ms race)
- routes/queue.ts:3,12,17,27 (GET /api/queue/failed, GET /api/queue/health)
- routes/runs.ts:3,14,19 (POST /api/runs/:id/resume bullmq branch)
- shared/sockets/register-socket-server.ts:37,474,801,892,989,992 (mode checks; per-agent enqueue; resume re-enqueue)
- tools/tool-registry.ts:190,671,728 (scheduler cron/delayed; removeJobScheduler)
- runtime/runtimes/research-runtime.ts:376,418 (mode read; sub-run trace enqueue)
- Tests/mocks: shared/core/failure-modes.test.ts:5; tools/tool-registry.bullmq.test.ts:21,46,104 (vi.doMock of gate)

## Queues / jobs
- runs (RUNS_QUEUE_NAME, queues.ts:5): job "run", jobId `channel:agent:message` (queues.ts:119), attempts 3, 60s exp backoff, removeOnComplete 1h, removeOnFail 7d (queues.ts:30–35, 121–127).
- maintenance (queues.ts:6): 8 upsertJobScheduler entries (repeatables.ts:10–19): librarian-delta 10m, heartbeats-touch 15s, orphan-sweep 20s, orphan-resume 30s, suppress-expiry 10m, retention 6h, snapshot-full 15s, approval-expire 30s.
- scheduler (queues.ts:7): tool-added "scheduled:cron" (upsertJobScheduler) + "scheduled:trigger" (delayed add) (tool-registry.ts:671–750).
- Worker concurrency: runs max(1,min(4,DB_POOL_MAX-6)) (run-worker.ts:124–128); maintenance 2 (:268); scheduler 4 (:118). lockDuration 900000, stalledInterval 30000, maxStalledCount 1 on all three.

## Persistence / events / routes
- Tables: none owned. Scheduler writes messages via messageGate.append (scheduler-worker.ts:37–50); snapshot reads workspaces/agents/runtimeOverrides (maintenance-worker.ts:141–204); retention → token-tracker reconcile + artifactsGate.runRetentionSweep (:93–108, last call is the uncommitted worktree change).
- Emits: runtime:snapshot (maintenance-worker.ts:207); message:new (messageGate broker path or ephemeral :67); scheduled:triggered (:75; also tool-registry.ts:131). Listens: tool:complete tap for progress only (run-worker.ts:42–52).
- Routes: /api/queue/failed, /api/queue/health, /api/health (queue block), /api/runs/:id/resume.

## Config
- QUEUE_MODE (connection.ts:14–17; env.ts:210), REDIS_URL default redis://localhost:6379 (connection.ts:19–23; env.ts:132), DB_POOL_MAX concurrency coupling (run-worker.ts:124–128), RETENTION_SWEEP_MS RETIRED (env.ts:184, no reader).

## Baseline (exact commands, from packages/server)
- npx vitest run src/queue → 2 files / 19 tests passed (integration file runs but every bullmq test honest-skips without Redis env).
- npx tsc -p tsconfig.json --noEmit → exit 0 (log: audit/domains/queue/baseline-tsc.log).
- node scripts/check-gates.mjs → "Gate rule OK: scanned 361 files across 23 domains ... 0 violations" (queue included; 46 non-fatal test-only findings elsewhere; 3 allowlisted elsewhere).
- git: main; queue/ has 1 pre-existing uncommitted modification: maintenance-worker.ts (+5 lines artifacts retention sweep, ART-3). NOT touched by this audit.

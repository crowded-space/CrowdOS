# Queue Domain — Contracts (as-is, code = truth)
Gate: packages/server/src/queue/queue-gate.ts @ main 22bb8a0 (+1 uncommitted maintenance-worker.ts hunk).

## Gate surface (8 ports + 1 type)
| Port | Signature | Behavior | Evidence |
| --- | --- | --- | --- |
| mode | () => "inline" | "bullmq" | QUEUE_MODE trim/lowercase; anything but "bullmq" → inline | queue-gate.ts:99, connection.ts:14–17 |
| enqueueRun | (EnqueueRunInput) => Promise<{id,jobId} | null> | inline → null; bullmq → deterministic jobId channel:agent:message; duplicate resolves existing; throws on empty keys; other errors rethrow | queue-gate.ts:100, queues.ts:111–136 |
| scheduleMaintenance | () => Promise<void> | inline → no-op; bullmq → startRunWorker + startMaintenanceWorker + upsert 8 schedulers (per-spec errors logged, not thrown) | queue-gate.ts:101, repeatables.ts:21–45 |
| healthCheck | () => Promise<{mode,connected,waiting,failed}> | never throws; 2s cap per Redis call; sums runs(waiting+active+delayed)/maintenance(waiting)/scheduler(waiting+delayed) | queue-gate.ts:11–67 |
| drain | () => Promise<void> | inline → no-op; stop run→maintenance→scheduler workers, closeQueues, closeConnection; per-stage catch+log | queue-gate.ts:69–96 |
| getFailedJobs | (limit=100) => Promise<Job[]> | inline → []; runs queue only; limit clamped ≤200 server-side | queue-gate.ts:104, queues.ts:184–218 |
| getSchedulerQueue | () => Queue | null | raw BullMQ Queue (Tools-only raw access) | queue-gate.ts:105, queues.ts:97–109 |
| startSchedulerWorker | () => Promise<Worker | null> | idempotent singleton; inline → null | queue-gate.ts:106, scheduler-worker.ts:110–132 |

Exported type: EnqueueRunInput (queue-gate.ts:9) = { runId?, channelId, agentId, messageId, userInput, workspaceId?, explicitRuntime?, preferredRuntime?, resumeContext?, resumeFrom? } (queues.ts:9–23).
Not exported (internal): EnqueueResult, getJobOptions, REPEATABLES, getRunsQueue, getMaintenanceQueue, worker getters, all reset* helpers, removeMaintenanceSchedulers, closeQueues, closeConnection, stopRunWorker/stopMaintenanceWorker/stopSchedulerWorker, getRedisConnection/createRedisConnection/getRedisUrl/isInlineMode.

## Caller contracts (observed, some rely on non-gate internals — see ledger Q-9)
- Socket send (bullmq, non-test): persist run row first → enqueueRun(real runId, messageId=userMsg.id, explicit/preferredRuntime) → emit run.queued; persist-fail skips enqueue; paused/offline → warning (register-socket-server.ts:845–906).
- Resume route: bullmq → enqueueRun with @ts-ignore resumeContext/resumeFrom; enqueue failure only logged, 200 still returned (routes/runs.ts:16–33, 69). Inline → void runtimeGate.execute fire-and-forget (:54–64).
- Resume socket: same, messageId=resume:{runId}:{Date.now()} (never dedupes) (register-socket-server.ts:989–1004).
- Tools scheduler: getSchedulerQueue + startSchedulerWorker; cron upsertJobScheduler(id,{pattern}); delayed q.add(jobId=id, delay) → inline setTimeout fallback with unref (tool-registry.ts:671–750); removal removeJobScheduler(id) best-effort (:190–196).
- Research sub-run trace: bullmq-only enqueueRun with fresh messageId res-sub-{idx}-{Date.now()} AND the runtime executes the sub-run inline anyway (research-runtime.ts:415–429) — no consumer for the queued job.
- Worker entry: requires bullmq, else exit(0); drain capped at 30s (worker.ts:17–40, 67–101).
- API boot probe: healthCheck raced with 2s timeout; warns when connected=false (create-app.ts:397–409).

## Cross-domain ports used (all dynamic import, gate-to-gate)
| Gate | Port | Site |
| --- | --- | --- |
| runtime-gate | execute | run-worker.ts:93–120 (2026-10-07 SH-002: wrapped in runWithDb(dbForWorkspace(ws)) when handle resolves; unscoped fallback) |
| agent-gate | getById, list | run-worker.ts:79–88 |
| event-broker-gate | getSharedBroker, EventBroker | run-worker.ts:28–32, maintenance-worker.ts:11,43,60,114,127, scheduler-worker.ts:31 |
| runs-gate | sweepOrphanedRuns | maintenance-worker.ts:64–66 |
| memories-gate | runMemorySweep | maintenance-worker.ts:75–81 |
| approvals/approval-gate | sweepOnce | maintenance-worker.ts:113–118 |
| artifacts/artifacts-gate | runRetentionSweep | maintenance-worker.ts:103–104 (uncommitted) |
| messages/message-gate | append | scheduler-worker.ts:37–50 |
Non-gate internals used: shared/core/index-builder.ts:15–17 (reindexStaleChannels — static), shared/core/agent-heartbeat.ts:26 (touchWorkingAgents — module-private), shared/core/token-tracker.ts:95 (reconcileBudgetUsage), shared/config/database.ts:134, db/schema.ts:141. All Shared/lib/config exempt from gate rule; flagged only for behavior (Q-11/Q-12).

## Gate shape vs Backend Domain Spec "Ports" section
Doc (re-docs/Backend Docs/Domain Spec/Queue.md) Ports list = 8 ports + EnqueueRunInput → matches gate exports exactly. No drift. Doc line-number citations for a few items are stale (e.g. claims queues.ts:129–135 for duplicate handling; actual 130–134; queue-gate.ts:60 for drain; actual 69–96) — cosmetic only.

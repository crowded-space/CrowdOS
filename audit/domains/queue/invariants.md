# Queue Domain — Invariants (expected vs observed)
Legend: [H] holds as claimed · [B] broken / violated · [U] unproven (no test).

## I1 Inline mode is a total no-op (no Redis I/O; gate never throws for being inline)
[H] mode() reads env live (connection.ts:14-17); getRedisConnection/createRedisConnection return null (connection.ts:29-31,41-42); enqueueRun null (queues.ts:112); getFailedJobs [] (queues.ts:197); scheduleMaintenance/worker starts return early (repeatables.ts:22, run-worker.ts:131, maintenance-worker.ts:261, scheduler-worker.ts:111); drain early-returns (queue-gate.ts:70). Tested: queue-gate.unit.test.ts:17-66,84-89.

## I2 Enqueue idempotency: same (channel,agent,message) collapses to one job
[H] Deterministic jobId (queues.ts:119); duplicate -> {id:jobId,jobId} (queues.ts:131-132). Caveat: detection is string-matching on error text ("JobId"/"already exists"/"exists", queues.ts:131) - brittle across BullMQ versions [U for non-matching error shapes]. Retry semantics: the SAME job retries (attempts 3); a completed job is removed after 1h and cannot be re-fired.

## I3 Every run job executes with the real DB runId
[H] Socket persists first, skips enqueue on persist failure (register-socket-server.ts:877-890). [B-variant] Resume paths bypass typing via @ts-ignore (routes/runs.ts:26-29; register-socket-server.ts:999-1002) and research trace enqueues with runId possibly undefined (research-runtime.ts:420).

## I4 Unknown job data never crashes a worker
[H] explicitRuntime/preferredRuntime sanitized to KNOWN_RUNTIMES else undefined (run-worker.ts:13-22); maintenance unknown name+kind -> null (maintenance-worker.ts:250-252); scheduler unknown -> throw (scheduler-worker.ts:102-103, deliberate). Known gap: scheduler name startsWith("scheduled") catches ANY scheduled* job (scheduler-worker.ts:94).

## I5 Long run jobs never false-stall
[H] lockDuration 900000 + stalledInterval 30000 + maxStalledCount 1 (run-worker.ts:145-147); 30s heartbeat updateProgress + extendLock(token,900000) (run-worker.ts:61-71); tool:complete taps update iteration (run-worker.ts:42-52). Heartbeat interval unref'd (:73).

## I6 Maintenance dispatch: name first, data.kind second
[H] maintenance-worker.ts:214-254 (switch name, fallback switch kind). [B] heartbeats-touch handler is a silent no-op: touchWorkingAgents is module-private (agent-heartbeat.ts:31), so the typeof check fails; the in-API 15s toucher only starts when NOT bullmq (agent-heartbeat.ts:51-63; register-socket-server.ts:505-507) -> in bullmq the only working-agent heartbeat refresher (and thus the DB last_heartbeat used by orphan-sweep) never runs. See ledger Q-1 (S1).

## I7 Scheduler fire is honest (persist-or-ephemeral, then retry)
[H] messageGate.append path (scheduler-worker.ts:37-50); DB-down -> ephemeral emit + throw to retry (:51-71). NOTE: the ephemeral emit happens before the retry, so a flaky DB can show a duplicate visible message [Medium, by design-ish].

## I8 healthCheck never throws; bounded latency
[H] per-probe try/catch, 2s per-Redis-call race (queue-gate.ts:16-24), outer catch -> connected:false (queue-gate.ts:64-66). Routes add 5s cache + 500ms race (routes/health.ts:11-34). Counts semantics: waiting includes active+delayed for runs; maintenance counts waiting only (not active/delayed) - minor undercount during active sweeps [Low].

## I9 drain is best-effort per stage; shutdown bounded at 30s
[H] queue-gate.ts:69-96; worker.ts:79-97 caps at 30s then exit(1) on timeout. [U] drain does not clear scheduler jobs or in-flight job completion - untested.

## I10 Concurrency is bounded by PG pool headroom
[H] runs max(1,min(4,DB_POOL_MAX-6)) (run-worker.ts:124-128); scheduler 4 (:118); maintenance 2 (:268). With DB_POOL_MAX=20: 4+4+2=10 worker slots vs pool 20 shared with API - unverified under load [U, S3].

## I11 Failure visibility: only the runs DLQ is listable
[B] getFailedJobs is runs-only (queues.ts:197-199); maintenance/scheduler failures are console-only; exhausted jobs retain 1h then vanish (queues.ts:37-49) with no listing port. Matches doc's known gap; target standard requires a port.

## I12 Idempotent startup: start* functions are singletons; scheduleMaintenance is re-runnable
[H] run-worker.ts:132, maintenance-worker.ts:262, scheduler-worker.ts:112; upsertJobScheduler is idempotent per spec id (repeatables.ts:33).

## I13 Gate-to-gate imports only; facade stays thin
[H] No production file outside queue/ imports past the gate (check-gates 0 violations; only env.ts comment references a filename). Gate has 2 local functions (healthCheck/drain) with logic - thin-ish facade, acceptable (wire + orchestration only). Events are emit-only (no queue-owned listen except the tool:complete progress tap).

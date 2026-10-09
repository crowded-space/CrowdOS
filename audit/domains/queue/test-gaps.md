# Queue Domain — Test Gaps
Baseline: `npx vitest run src/queue` = 2 files / 19 passed; integration file honest-skips every bullmq test unless QUEUE_MODE=bullmq / RUN_REDIS_INTEGRATION=1 + live Redis.

## Covered
- Inline no-ops: mode, enqueueRun null, healthCheck shape, scheduleMaintenance/drain no-op, getFailedJobs [], queue getters null, worker starts null (queue-gate.unit.test.ts:17–89).
- Job options matrix (attempts/backoff/lock/retention) via getJobOptions (unit :68–76; integration :120–127).
- REPEATABLES membership + snapshot 15s (unit :100–111; integration scheduler assertion :129–151, skip-gated).
- Real-Redis: healthCheck connected, enqueue dedupe jobId + opts, scheduleMaintenance schedulers, drain (integration :50–164, all skip-gated).

## Gaps (no test proves behavior)
| # | Gap | Evidence of absence | Risk |
| --- | --- | --- | --- |
| T1 | heartbeats-touch is a no-op in bullmq (Q-1) | no test invokes maintenanceProcessor name "heartbeats-touch"; grep of touchWorkingAgents shows only module-internal uses | S1 regression undetected |
| T2 | run-worker processRunJob: agent resolve, runtimeGate.execute bridge, heartbeat/extendLock, tool:complete iteration, AND the SH-002 tenant wrap (2026-10-07: execute now inside runWithDb(dbForWorkspace(ws)); no test asserts the bound handle) | no test file imports run-worker besides inline start no-op | S1/S2 |
| T3 | scheduler-worker persist→emit→ephemeral fallback→retry | no test imports scheduler-worker; tool-registry.honest.test.ts:292 only covers the tool inline path | S2 |
| T4 | maintenanceProcessor dispatch matrix (8 names + kind fallback + unknown→null) | no test imports maintenance-worker | S2 |
| T5 | duplicate-enqueue path returning {id:jobId,jobId} | integration asserts res2.jobId only, not id equality/creation (integration :101–111); unit :113–118 is a placeholder `expect(true).toBe(true)` | S2 |
| T6 | drain timeout/ordering under a wedged worker | no test | S3 |
| T7 | healthCheck timeouts (2s cap) and count aggregation incl. maintenance active/delayed | no test forces a hang | S3 |
| T8 | drain + reschedule cycle (worker restart) | none | S3 |
| T9 | resume enqueue failure propagation (Q-2) | no test | S2 |
| T10 | maintenance/scheduler failed-job visibility (Q-6) | none | S3 |

T2 (SH-002 wrap portion) RESOLVED 2026-10-07 (impl-tenant-tests-6): `run-worker.scope.test.ts` drives `processRunJob` with a fake Job and asserts the executor runs inside the workspace ALS handle (bare `getDb().__workspaceMarker`): bound ws-a, default-bound (no workspaceId), resolver-null → unscoped with empty `boundCalls`; agent resolve + initial `updateProgress` exercised. Remaining unasserted: `extendLock`/periodic heartbeat, `tool:complete` iteration counting, agent list-fallback path.

## Test hygiene notes
- queue-gate.unit.test.ts:113–118 is a tautology placeholder for the jobId spec — replace with real dedupe assertion (or delete).
- Integration cleanup deletes bull:runs/maintenance/*:repeat keys only (queue.integration.test.ts:40–45); bull:scheduler:* keys are never wiped → cross-run pollution for scheduler tests (none exist yet).
- Cross-domain tests touching queue internals: none found (queue-gate.unit/integration are in-domain; allowed).

# Runs Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/runs/` (11 files), facade `runs-gate.ts`, transport `routes/runs.ts` + socket handlers, persistence (schema + migrations 0001/0003/0007/0008/0009/0024), tests, all call sites, docs.
Method: full read of every domain file, every cross-domain call site (grep verified), schema/migration inspection, boot wiring, queue/worker wiring, e2e + client consumers, test baseline run (`npx vitest run src/runs`, `tsc --noEmit`, `check-gates`, `check-events`).

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| `runs-gate.ts` | 1986 | Facade: 18 ports + 11 type re-exports (exact list below) |
| `runs-repository.ts` | 13140 | DB owner: create/transition/checkpoint/heartbeat/compensation CRUD, DB resolver pair, kill switch |
| `runs-service.ts` | 4810 | Composed ops: `resumeRun` (resumable→queued + emit), `undoCompensation` (refusal-first + Guard-checked fs inverse) |
| `run-state-machine.ts` | 3860 | Pure guard: 16 states, terminal set, TRANSITIONS map, transition/canTransition/assertTransition/isTerminal/allowedTransitions/isRunState |
| `orphan-sweep.ts` | 5494 | Stale-run reaper: two-tier thresholds, two-hop walk + self-heal, interval starter |
| `apply-transition.test.ts` | 2779 | Scripted-DB CAS retry unit tests (4) |
| `checkpoint.test.ts` | 1813 | Compensation inverse builder + orphan edge unit tests (4) |
| `run-state-machine.test.ts` | 6074 | State machine exhaustive unit tests (13) |
| `runs-service.test.ts` | 2219 | undoCompensation refusal-path unit tests (4) |
| `resume.integration.test.ts` | 8717 | Real-DB integration: checkpoint merge, journal, sweep+resume, pending threshold (5) |
| `runs-repository.integration.test.ts` | 6447 | Real-DB integration: transition chain, terminal immutability, cancel walk, fail wrapper (4) |

Naming (AGENTS.md §1): all `*.ts` kebab-case — compliant. Gate is `runs-gate.ts` — compliant. Gate contains two thin async delegates with dynamic imports (`sweepOrphanedRuns`, `startRunOrphanSweeper`) — acceptable thin wiring, no logic/branching/DB.

## 2. Facade surface (exact, `runs-gate.ts:29-59`)

Ports (18):
- `create` → `createRun(input: CreateRunInput): Promise<RunRow | null>` (:30)
- `complete` → `completeRun(runId): Promise<RunRow | null>` (:31)
- `fail` → `failRun(runId, errorCode?): Promise<RunRow | null>` (:32)
- `cancel` → `cancelRun(runId): Promise<RunRow | null>` (:33)
- `touchCheckpoint` → `touchCheckpoint(runId, number | CheckpointPatch, workspaceId?): Promise<boolean>` (:34)
- `touchRunHeartbeat` → `touchRunHeartbeat(runId, workspaceId?): Promise<boolean>` (:35)
- `transition` → wrapper over `applyTransition(runId, to, { reason, errorCode, workspaceId })` (:36-42)
- `getById` → `getRunById(runId, workspaceId?): Promise<RunRow | null>` (:43)
- `resumeRun` → `resumeRun(runId, workspaceId?): Promise<{ run, checkpoint } | null>` (:44)
- `addCompensation` → `addCompensation(runId, entry): Promise<CompensationRow | null>` (:45)
- `listCompensations` → `listCompensations(runId, workspaceId?): Promise<CompensationRow[]>` (:46)
- `getCompensation` → `getCompensation(runId, compId, workspaceId?): Promise<CompensationRow | null>` (:47)
- `deleteCompensation` → `deleteCompensation(compId, workspaceId?): Promise<void>` (:48)
- `listRunsByStatus` → `listRunsByStatus(statuses, staleBefore?, limit=50): Promise<RunRow[]>` (:49)
- `undoCompensation` → `undoCompensation(runId, compId, workspaceId?): Promise<{ ok, error?, entries? }>` (:50)
- `buildCompensationInverse` → pure builder (:51)
- `sweepOrphanedRuns` → async delegate to `orphan-sweep.js` (:52-55)
- `startRunOrphanSweeper` → async delegate, awaits the dynamic import so boot try/catch sees failures (:56-59)

Value re-export: `isTerminal` (:27). Type re-exports (:24-26): `CreateRunInput, RunRow, TransitionResult, CheckpointPatch, CompensationRow, RunCheckpoint, CompensationInverseOp, RunStatus, RunState, TransitionVerdict`.

## 3. Entities / invariants / state machine

16 states: `created, queued, starting, running, waiting_for_tool, waiting_for_approval, retrying, compacting, completing, verifying, completed, failed, cancelled, cancelling, orphaned, resumable` (`run-state-machine.ts:1-18`). Terminals: `completed | failed | cancelled` (:20). Key edges: `created → queued|starting|cancelling|failed|orphaned` (:29); `running → waiting_for_tool|waiting_for_approval|retrying|compacting|completing|cancelling|failed|orphaned` (:31-41); `completing → verifying|completed|failed|cancelling|orphaned` (:45); `orphaned → resumable` (:52); `resumable → queued` (:53); `cancelling → cancelled` only (:51). Same-state = legal no-op (:88-90); terminal = immutable (:91-93).

Persistence: `runs` (uuid PK, parentRunId FK set-null, agentId/channelId/workspaceId text correlation columns, runtimeType, status enum default 'running' in DDL but code always inserts 'created', errorCode, checkpointSeq bigint, checkpoint jsonb, createdAt/updatedAt timestamptz, index on channel_id). `runs_compensation` (text PK, runId FK cascade, seq, toolName, targetPath, inverseOp jsonb, createdAt, UNIQUE(runId,seq), index on runId). Migrations: 0001 (table + 4-value enum), 0003 (enum expanded to 16), 0007 (checkpoint column + compensation table), 0008 (FKs from approvals/delegations/swarm_tasks/artifacts), 0009 (token_usage_log FK set-null), 0024 (drops delegations.child_run_id FK; schema.ts still declares it — known drift, documented in the migration itself).

## 4. Dependency map (Caller → Facade → Use case/service → Port → Adapter + side effects)

```
runtime/runtime-executor.ts
  ├─ runsGate.create (:197) ──────────────┐
  ├─ runsGate.getById (:88)               │
  ├─ runsGate.touchRunHeartbeat (:136)    │
  └─ state/state-gate.ts applyRunTransition (:22)
        └─ runsGate.transition ───────────┤
runtime/runtimes/agentic-runtime.ts        │
  └─ runsGate.touchCheckpoint (:273)      │
runtime/runtimes/coding-runtime.ts         │   runs/runs-repository.ts
  └─ runsGate.buildCompensationInverse    │     ├─ resolveWriteDb / resolveDb
     + addCompensation (:242-243,354-355) │     │    ├─ dbForWorkspace(workspaceId) → workspace record pool
runtime/runtimes/research-runtime.ts       │     │    └─ getDb() → ALS tenant handle or shared pool
  └─ runsGate.create/transition (child)   │     ├─ runs table (W)
tools/tool-executor.ts                     │     ├─ runs_compensation table (W)
  └─ runsGate.transition (approval hops)  │     └─ run-state-machine transition() guard
tools/tool-registry.ts                     │
  └─ buildCompensationInverse             │   runs/runs-service.ts
     + addCompensation (:287-288,335-336, │     ├─ resumeRun: getById→transition→broker.emit
     413-414)                             │     └─ undoCompensation: refusal-first validation
routes/runs.ts                             │          → channelMountGate.effectiveRoot
  ├─ resumeRun (:9)                        │          → Guard.validatePath (tools-gate)
  ├─ getById + listCompensations           │          → fs unlink/writeFile → deleteCompensation
  └─ undoCompensation (:83)                │
routes/approvals.ts                        │   runs/orphan-sweep.ts
  └─ getById + transition (:24,58,77-79)   │     ├─ forEachWorkspaceDb (workspace-gate)
approvals/approval-sweeper.ts              │     ├─ runWithDb(db, sweepOneDb)
  └─ getById + transition (:37,41)         │     ├─ SELECT ... FOR UPDATE SKIP LOCKED limit 50
shared/sockets/register-socket-server.ts   │     ├─ applyTransition ×1-2 per row
  ├─ create (:882), resumeRun (:978)       │     └─ broker.emit run.status_changed per hop
  ├─ listCompensations (:1055)             │
  ├─ undoCompensation (:1083)              │   queues (bullmq mode)
  ├─ getById (:1138,1154)                  │     ├─ maintenance-worker.ts handleOrphanResume → sweepOrphanedRuns
  └─ transition (:1156)                    │     └─ run-worker.ts: job.data.resumeContext → runtimeGate.execute
queue/maintenance-worker.ts (:64-65)       │
  └─ runsGate.sweepOrphanedRuns            │   create-app.ts (:376)
create-app.ts (:376)                       │     └─ runsGate.startRunOrphanSweeper(eventBroker)
  └─ startRunOrphanSweeper                 │
event-broker/event-types.ts (type-only)    │   event-log-service.ts (onAny persistence)
  └─ RunStatus import                      │     └─ run.status_changed classified durable
```

Side effects summary:
- `run.status_changed` emits: `state-gate.ts:30` (executor walks), `runs-service.ts:23` (resume), `orphan-sweep.ts:46` (sweep hops). NOT emitted by `applyTransition` itself — callers own emission.
- `run.compensations`: emitted only by route/socket callers after undo (`routes/runs.ts:90`, socket :1093).
- Filesystem: `undoCompensation` unlink/restore under Guard (`runs-service.ts:88-95`).
- No cache invalidation, no metrics, no spans owned by this domain.

## 5. Cross-domain importers (grep-verified, whole repo)

Facade importers (production):
- `approvals/approval-sweeper.ts:2`, `routes/approvals.ts:3`, `routes/runs.ts:2`, `state/state-gate.ts:7,9`, `tools/tool-executor.ts:12`, `create-app.ts:29` — all import `runs-gate.js` only. Clean.
- Dynamic facade imports inside functions: `runtime/runtime-executor.ts`, `runtimes/agentic-runtime.ts`, `runtimes/coding-runtime.ts`, `runtimes/research-runtime.ts`, `tools/tool-registry.ts`, `shared/sockets/register-socket-server.ts`, `queue/maintenance-worker.ts`.
- Type-only: `event-broker/event-types.ts:3` (`RunStatus`).

Bypass imports past the gate (production): NONE. `check-gates.mjs` reports 0 violations; the only "outside runs/" repository imports are TEST files (below).

Test bypasses (recorded by the repo's own check-gates TEST-ONLY list, non-fatal):
- `approvals/approval-flow.integration.test.ts:10,36` → `runs-repository.js`
- `approvals/approvals.integration.test.ts:9,58` → `runs-repository.js`
- `artifacts/artifacts-gate.test.ts:44,50` → `runs-repository.js`
- `shared/core/failure-modes.test.ts:3` → `run-state-machine.js` (`canTransition`)

Non-gate internals used by the domain (allowed by AGENTS.md exemptions): `shared/config/database.js` (getDb, dbForWorkspace, runWithDb, isDatabaseConfigured, isNoDatabaseError), `db/schema.js`, `workspace-gate.js` (forEachWorkspaceDb), `event-broker-gate.js` (dynamic, getSharedBroker/EventBroker type), `channel-mount-gate.js` (dynamic, effectiveRoot), `tools-gate.js` (dynamic, Guard).

Incoming deps on runs tables from other domains (read-only or FK):
- `observability/cost-ledger.ts:226` — direct SELECT of `runs.id/runtimeType/status` (cross-domain table read past the gate; reads only).
- FKs: `approval_requests.run_id` (cascade), `delegations.parent_run_id` (cascade; child FK dropped in 0024), `swarm_tasks.run_id` (cascade), `artifacts.run_id` (cascade), `token_usage_log.run_id` (set null).

## 6. Entry points

HTTP (`routes/runs.ts`, local-first loopback trust, no role gates):
- `POST /api/runs/:id/resume` — resumeRun → queue re-enqueue (bullmq) or inline `runtimeGate.execute`; returns 200 always if resumeRun succeeds, even when enqueue/agent resolution fails (log-only).
- `GET /api/runs/:id` — run + compensations; 404 when missing.
- `GET /api/runs/:id/compensations` — 404 when run missing.
- `POST /api/runs/:id/compensations/:compId/undo` — 404 run, 400 undo refusal, emits `run.compensations`.
- `GET /api/runs/:id/approvals` (`routes/approvals.ts:22`).

Socket (`register-socket-server.ts`): `user:message` creates+enqueues a run (:882-898); `run:resume` (:961, operator role for apikey); `run:compensations:list` (:1043, admin); `run:compensation:undo` (:1068, admin); `approval:decide` transitions (:1156).

Jobs/schedulers: inline mode — `create-app.ts:376` starts the sweep timer; bullmq mode — `maintenance-worker.ts` repeatables `orphan-resume` every 30s, plus API suppresses local timers (`create-app.ts` boot branch).

## 7. Auth / tenant / ownership

- Auth: none inside the domain. REST runs routes rely on loopback trust (comment at `routes/runs.ts:7`); socket handlers gate apikey roles (resume operator, compensations admin). The rest of the process is behind the global pin/auth hooks.
- Tenant: `x-workspace-id` header → `onRequest` hook resolves the workspace pool and binds `runWithDb` (ALS) for the whole request (`create-app.ts:235-303`). Socket handlers are NOT in an ALS scope; their `runsGate` calls run against `getDb()` → shared pool. The domain's `workspaceId` parameter (present on transition/getById/touch*/resume/undo/list/get/delete compensation) is never passed by any caller (grep: zero production callers pass it).
- Ownership: `runs` and `runs_compensation` owned by this domain; no other domain writes them.

## 8. Config / env

- `RUNS_ENABLED` (default true) — every repository function short-circuits to null/false/[] when `"false"` (`runs-repository.ts:39-41`).
- `ORPHAN_AFTER_MS` (min 10 000, default 60 000), pending threshold = ×10 derived, `ORPHAN_SWEEP_MS` (min 5 000, default 30 000). Invalid values silently clamp to defaults.
- Transitive: `DATABASE_URL` (CLI/tests only by design; runtime uses workspace registry URLs), `DB_POOL_MAX`, queue mode (`QUEUE_MODE`), `APPROVAL_TTL_MS`.

## 9. Docs (drift check)

- `re-docs/Backend Docs/Domain Spec/Runs.md` — Ports match the gate exports exactly (18/18 verified). Flow cites line numbers that are now stale (repository functions shifted; e.g. it cites `runs-repository.ts:113-131` for the CAS loop — actual 106-131; `touchCheckpoint :179-209` — actual 158-213). No behavioral contradiction found.
- `Feature and Flow Spec/Durable runs and checkpoints.md` — contains one stale claim: "research child-run path bypasses the gate via direct repository import" (open gap). FALSE today: `research-runtime.ts:398-405` uses `runsGate.create`. Drift to fix in docs (doc-only; code is correct).
- `Feature and Flow Spec/Compensation undo flow.md` — contains two stale claims: (a) undo workspace-root fallback "process.cwd()/sandbox/default" — FALSE today, `runs-service.ts:66-84` fails loudly when no root resolves; (b) "admin-only undo surface" — REST endpoint has no role gate today (loopback trust); socket is admin-gated. Drift.
- `Recovery and resume.md` alignment notes already record a pointer drift (skip lives in agentic-runtime, not executor) — still accurate as a note.

## 10. Test inventory / baseline

Command: `cd packages/server && npx vitest run src/runs` → **4 files passed, 2 skipped; 26 tests passed, 9 skipped (35 total); duration ~9.8s**.
Skipped reason: both integration files skip when `DATABASE_URL` is unset (`resume.integration.test.ts` probes the DB + `resumable` enum + checkpoint column + compensation table; `runs-repository.integration.test.ts` probes DB + `created` enum value). No `.env` present in `packages/server` at audit time.
Typecheck: `npx tsc -p tsconfig.json --noEmit` → exit 0. Repo gates: `check-gates` 0 violations (46 test-only findings incl. 4 runs bypasses above), `check-events` 0 violations.

Coverage gaps (detailed in test-gaps.md): no tests for resume emit contract, sweep emit contract, cancelRun partial-hop failure, `errorCode` clobbering on reason-only transitions, unthreaded `workspaceId` split-DB behavior, undo filesystem application (success path), event ordering/duplication.

## 11. Boundary assessment

- Gate-only rule: compliant in production code (0 violations). Test bypasses exist and are flagged by the repo's own checker.
- Cycles: none involving runs (runs → workspace/event-broker/channel-mounts/tools gates; all one-directional). `state-gate` depends on runs-gate (gate→gate OK).
- Hidden deps / global state: `orphan-sweep.ts` module-level `started`/`timer` singletons (no stop/reset export — zero callers wanted); `runs-service.ts` dynamic imports of broker each call; `resolveWriteDb`/resolveDb dynamic imports of database module.
- Boundary smell: `cost-ledger.ts` reads the `runs` table directly (cross-domain table read; runs has no read port for "runs by ids"). Recorded in ledger as RUN-012 (S3, read-only).

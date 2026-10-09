# Approvals Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/approvals/` (6 files), facade `approval-gate.ts`, transports `routes/approvals.ts` + `routes/safety.ts` (grants; unregistered), socket `approval:decide`/`approval:list`, persistence (schema + migrations 0008/0012/0014), all call sites, docs. Method: full read of domain files, cross-domain call sites (grep), schema/migration inspection, baseline commands. Time-boxed at 30 min: unverified items marked Low.

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| `approval-gate.ts` | 2545 | Facade: 16 ports + `emitDecided` + `sweepOnce` async delegate; re-exports types + helper values. Dynamic import of sweeper to avoid gate→sweeper→gate cycle (:64-67). |
| `approval-types.ts` | 4578 | Pure policy: risk/status unions, `ApprovalRequest`/`CreateApprovalInput`/`DecideApprovalInput`, TTL consts (read `process.env` directly, :47-58), `isApprovalsEnabled` (:61), `computeScopeHash` (:65, sha256→16 hex), `mapVerdictToRiskClass` (:70), `argsPreviewFromCommand` (:109, 500-char truncate). |
| `approval-repository.ts` | 6794 | DB owner: create/read/reusable/decide/expire. `decide` atomic claim in `withTransaction` (:118-152); `expirePendingApprovals` bulk flip (:158-166); `findReusableGrant` per-requester + global fallback (:72-114). |
| `approval-sweeper.ts` | 3316 | TTL reaper: `sweepApprovalsOnce` fan-out via `forEachWorkspaceDb` + `runWithDb` (:12-19); per-DB expire→resume run→emit (:21-60); `startApprovalSweeper` 5s+30s unref'd timer (:62-71); `stopApprovalSweeper` (:73, zero callers). |
| `approvals.integration.test.ts` | 11355 | Real-DB integration (6 tests): create/risk map, reusable, expiry, double-decide, scope hash. Skips without DATABASE_URL. |
| `approval-flow.integration.test.ts` | 16757 | Real-DB ToolExecutor e2e (4 tests): pause→grant→execute, deny, reusable, TTL expire. Skips without DATABASE_URL. |

Naming: kebab-case `.ts` ✓; gate file `approval-gate.ts` ✓ (AGENTS.md §1/§2).

## 2. Facade surface (exact)

Ports (`approval-gate.ts:33-49`): `create`, `createPending`, `createApproved`, `getById`, `findPending`, `findPendingByRun`, `listByRun`, `findReusableGrant`, `decide`, `expirePendingApprovals`, `sweepExpired`, `sweepOnce` (function, :64), `isEnabled`, `computeScopeHash`, `mapRisk`, `argsPreview`.
Helper: `emitDecided(broker, payload)` (:83-98). Types re-exported (:31): `ApprovalRow, ApprovalRequest, ApprovalRiskClass, ApprovalStatus, CreateApprovalInput, DecideApprovalInput`. Value re-exports (:34-43): `isApprovalsEnabled, computeScopeHash, mapVerdictToRiskClass, argsPreviewFromCommand, APPROVAL_PENDING_TTL_MS, APPROVAL_REUSABLE_TTL_MS`.

## 3. Importers (grep-verified)

Static: `tools/tool-executor.ts:11` (approvalGate + APPROVAL_REUSABLE_TTL_MS); `routes/approvals.ts:2` (approvalGate, emitDecided); in-domain `approval-sweeper.ts:1`.
Dynamic: `tool-executor.ts:430,523,663,723` (emitDecided); `shared/sockets/register-socket-server.ts:1118,1180`; `queue/maintenance-worker.ts:108-113` (sweepOnce).
Gate BYPASS (allowlisted in `scripts/check-gates.mjs:24-37`): `create-app.ts:30` + `worker.ts:45` → `./approvals/approval-sweeper.js`.
Test bypasses (check-gates TEST-ONLY, non-fatal): `approvals.integration.test.ts:9,58` and `approval-flow.integration.test.ts:10,36` → `runs-repository.js`; also tool-registry/tool-executor in the flow test.

## 4. Entry points

REST (`routes/approvals.ts`, registered via routes/index.ts:52): GET /api/approvals?runId= (400 no runId), GET /api/approvals/:id (404), GET /api/runs/:id/approvals (404 run), POST /api/approvals/:id/decision (rateLimit 30/60s; 400 bad decision, 404, 409 non-pending, 409 concurrent), POST /api/approvals/sweep (count only).
REST dead (`routes/safety.ts:35` `safetyRoutes` imported nowhere): /api/channels/:id/safety, /api/workspaces/:id/safety, GET/DELETE /api/approvals/grants (direct `approvalGrants` table access).
Socket: `approval:decide` (operator for apikey; scope only, no expiresAt), `approval:list` (viewer).
Timers/jobs: inline — `create-app.ts:379` `startApprovalSweeper(eventBroker)`; bullmq — `repeatables.ts:18` `approval-expire` every 30s → `maintenance-worker.ts:106-116` `approvalGate.sweepOnce(broker)` (requires shared broker, else job throws).

## 5. Persistence

`approval_requests` (0008:8-20 + FK 0008:48 cascade): id text PK, run_id uuid NOT NULL, tool_name, args_preview jsonb, risk_class enum, status enum default pending, requested_by, decided_by, expires_at tz, scope text, created_at, decided_at. 0012:11-15 adds `scope_type` (enum, NOT NULL default 'once'), `scope_hash`, `workspace_id`, `channel_id`, `thread_id` — all five ABSENT from `db/schema.ts:561-577` (drift).
Indexes: 0012:74-77 (run, channel, scope_hash, status), 0014:18-19 repeats run+status. No (status, expires_at) composite.
`approval_grants` (0012:49-58, schema.ts:1067-1075): only consumer is unregistered `routes/safety.ts:102-120` → dead table+routes.

## 6. Config

`APPROVALS_ENABLED` (env.ts:212, default false), `APPROVAL_TTL_MS` (env.ts:214, numSchema min 1000; tool-executor reads process.env directly so schema bounds NOT applied), `APPROVAL_REUSABLE_TTL_MS` (env.ts:215), legacy `APPROVAL_PENDING_TTL_MS` (approval-types.ts:48). Two TTL sources of truth: types.ts defaults 5min/1h + env.ts clamps — drift.

## 7. Dependency map (Caller → Facade → Repo → Adapter + side effects)

```
tools/tool-executor.ts
  ├ mapRisk/argsPreview/computeScopeHash (gate aliases → types.ts pure)
  ├ findReusableGrant ─┐
  ├ createApproved ────┤→ approval-repository → getDb()/withTransaction (ALS or global pool)
  ├ createPending ─────┤     └→ approval_requests (W)
  ├ getById (wait poll)┘
  ├ emitDecided (gate helper) → broker.emit approval.decided
  ├ emitVia.emit approval.requested (executor-owned)
  └ runsGate.transition waiting_for_approval ↔ running
routes/approvals.ts
  ├ listByRun/getById/decide/sweepExpired → repository (request-scoped ALS db via x-workspace-id)
  ├ emitDecided + runsGate.transition (resume)
  └ sweepExpired: status flip ONLY (no resume/emit)   ← AP-005
shared/sockets/register-socket-server.ts
  └ approvalGate.decide/getById/listByRun (NO ALS/tenant scope)  ← AP-009
queue/maintenance-worker.ts ─ sweepOnce → approval-sweeper
create-app.ts (timer) ─ startApprovalSweeper (direct import, gate bypass)
approval-sweeper.ts
  ├ forEachWorkspaceDb (workspace-gate) → runWithDb per DB   ← AP-003 filter
  ├ approvalGate.expirePendingApprovals (in-domain)
  ├ runsGate.getById/transition
  └ emitDecided via broker (or globalBroker dynamic import)
```

## 8. Baseline (Phase 4)

- `cd packages/server && npx vitest run src/approvals` → **Test Files 2 skipped (2); Tests 10 skipped (10)** (no DATABASE_URL/.env; both files probe-and-skip), duration 2.13s. Zero executed tests.
- `npx tsc -p tsconfig.json --noEmit` → no output, no errors (exit code not captured reliably in this shell; treated pass).
- `node scripts/check-gates.mjs` → "Gate rule OK: scanned 361 files across 23 domains, 0 violations"; 46 test-only findings (12 in approvals tests); 3 allowlisted pre-existing (2 approvals: create-app.ts, worker.ts → approval-sweeper.js).
- `check-events` not run (time-box) — Low confidence, not counted as gap.

## 9. Unknowns (Low confidence)

- Semantics of `getWorkspaceDb(...).source === 'workspace'` vs default single-DB deployments (drives AP-003 severity).
- Whether any deployment path registers `safetyRoutes` other than routes/index.ts (no evidence found → dead).
- Runtime prevalence of split-DB sockets (AP-009 impact).

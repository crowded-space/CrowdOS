# Cost ledger flow
> Type: Flow · Status: drifting · Updated: 2026-09-12

## Intent
Operators need to answer "what did runs cost" with no mandatory collector and no backfill jobs — price edits should reprice history by themselves. This flow exists so spend is derived at read time from raw usage rows joined to current model prices, rolled up per run through pure helpers, and served as both a dashboard and a self-check verifier.

## Architectural decision
Cost is computed at read time from `model_modules.cost_per_1k` and never stored, so price edits retroactively reprice history without backfills (`cost-ledger.ts:61-69`, `cost-ledger.ts:89-104`) `[Observed]`. Rollup is pure (`rollupFromEntries` groups by `runId`, sums tokens/costs, sorts by `lastSeen` desc) so dashboard and verifier share one math path (`cost-ledger.ts:185-217`) `[Observed]`. Run metadata attaches in one batched query with failures swallowed, so run-table outages degrade the ledger instead of breaking it (`cost-ledger.ts:211-228`) `[Observed]`. The verifier compares against a single-row SQL `SUM` ground truth with a 60s cache rather than re-reading the full table per check (`cost-ledger.ts:295-319`) `[Observed]`.

## How it works
1. Token usage rows accumulate in `token_usage_log` (written by Shared TokenTracker, not this domain) keyed by `run_id` with a legacy fallback to unkeyed entries for pre-migration rows (`cost-ledger.ts:62-174`).
2. `getPerRunCostLedger({ runId, channelId, agentId, limit })` joins each usage row to `model_modules` for `cost_per_1k`, probing the `run_id` column first and falling back to unkeyed grouping (`cost-ledger.ts:62-174`); limit clamps to 1–1000 (default 100).
3. `computeRowCostUsd` prices one row as `(rate × (prompt + completion)) / 1000`, returning `null` for null or non-finite `costPer1k` — unpriced rows contribute tokens but no dollars (`cost-ledger.ts:61-69`).
4. `rollupFromEntries` groups entries by `runId` (or `__no_run:channel:agent` when run-less), sums tokens/costs, and sorts by `lastSeen` desc (`cost-ledger.ts:185-217`); `getPerRunRollup` derives these rollups and attaches run `runtimeType`/`status` metadata in one batched read (`cost-ledger.ts:230-246`).
5. `getCostDashboard` batches one ledger fetch (limit 500) with one model-meta lookup, derives `byRun` purely, aggregates `byModel`, and rounds the total to 4dp (`cost-ledger.ts:248-293`).
6. `verifyLedgerAccuracy` compares the dashboard total to a single-row SQL `SUM` ground truth and reports `{ match, ledgerTotal, recomputedTotal, deltaPct }`, matching within 1% with a 60s cache (`cost-ledger.ts:298-319`).
7. Routes serve `GET /api/observability/cost/ledger`, `/cost/dashboard`, `/cost/verify` (admin-guarded when `WORKSPACE_ADMIN_TOKEN` is set), with trace stats attached to `GET /metrics` unless disabled (`routes/observability.ts:103-145`, `routes/metrics.ts:14-27`).
8. Degrade before serving: each cost read resolves the caller's tier and answers an honest empty shape when the workspace is local-tier (no record `databaseUrl`) or when the read fails connection-class; only logic errors still surface as 500 (`routes/observability.ts:24-101`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Observability.md> | Owns row-cost math, ledger reads, pure rollups, dashboard, and verifier — all reads, no table writes |
| <../Domain Spec/Modules.md> | Owns `model_modules.cost_per_1k`, the price source the ledger joins at read time (usage-row writes live in Shared TokenTracker) |
| <../Domain Spec/Runs.md> | Owns the `runs` table; this flow attaches `runtimeType`/`status` as display-only metadata in one batched read |

Related in this folder: [Observability spans and cost ledger](./Observability%20spans%20and%20cost%20ledger.md) — full feature design (spans plus ledger); this flow covers only the usage-rows → dashboard/verify pipeline.

## Current state
Real: usage join with legacy fallback, per-row pricing with null on unpriced models, pure rollups, batched metadata attach, 4dp dashboard, SQL-`SUM` verifier, route exposure with admin gating. Known rough edges that are real: the dashboard fetches 500 rows while the verifier checks 1000 (see below), and near-zero ledgers compare against an absolute floor.

Degradation is real too: a local-tier workspace and an unreachable database both answer `{ totalTokens: 0, totalCostUsd: 0, localMode: true }` rather than erroring, so a polling panel can tell "no spend" from "endpoint broken". The empty shape does not distinguish those two causes from each other (see Open gaps).

## Alignment notes
- Dashboard vs verifier row sets: `getCostDashboard` defaults to limit 500 while `verifyLedgerAccuracy` uses 1000 (`cost-ledger.ts:257-258`, `cost-ledger.ts:303-305`) — the verified total and the served total can cover different rows. Same drift as recorded in [Observability spans and cost ledger](./Observability%20spans%20and%20cost%20ledger.md); status `drifting` for this reason.
- Otherwise the join → price → rollup → dashboard/verify chain matches `Observability.md` Flow §§6-8 with no further contradiction.
- Previously these routes called `getDb()` unguarded, so a database-less workspace answered 500 on every 30s poll; the route layer now owns a tier check plus connection-class degradation (`routes/observability.ts:24-101`). `Observability.md` Flow step 10 records the new boundary.
- `isConnectionError` previously inspected only the top-level error, so drizzle-wrapped driver failures (`cause.code === "ECONNREFUSED"`, no code on the wrapper) were misread as logic errors — that defeated this flow's degradation and every other dual-boot fallback gated by the same predicate. Fixed to walk the `cause` chain with a bounded depth (`shared/config/database.ts:92`).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Dashboard plus verifier share one query scope and limit. Verified total over different rows than served total is forbidden.
* Verifier delta uses true percentage with documented near-zero handling.
* run_id backfill has an explicit documented outcome. Usage-row write semantics plus keying plus dedupe live in TokenTracker contract. Retroactive reprice is an explicit product contract. Authority: Observability standard.
## Open gaps
- Whether a `token_usage_log.run_id` backfill exists for pre-migration rows (vs permanent `__no_run` grouping) is unverified.
- Verifier delta divides by `max(1, dashboard)` (`cost-ledger.ts:315`) — near-zero ledgers compare against an absolute floor, not a true percentage.
- Usage-row write semantics (who writes, keying guarantees, dedupe on retried runs) live in Shared TokenTracker, outside the domain-spec map — write-side correctness was not traced.
- Whether price edits *should* retroactively reprice history (vs point-in-time costing) is a product decision that was never recorded — the code does it, no doc says it should.
- The degraded empty shape is identical for "workspace has no ledger" and "database was unreachable" — a caller cannot tell the two apart; whether the panel needs that distinction is unverified.
- Unprovisioned tenant schema (stale BYODB, 42P01/42703) degrades to the honest empty shapes via `withOutageDegradation` + `isSchemaMismatchError` (2026-10-08); the empty shape stays identical for no-ledger / unreachable / unprovisioned — callers still cannot tell the three apart.

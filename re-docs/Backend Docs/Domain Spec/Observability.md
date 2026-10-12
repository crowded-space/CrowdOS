# Observability

## Purpose
Process-local execution insight in two halves: an in-memory span store (OTel-compatible facade keyed by runId, with optional real-SDK sidecar) for trace reconstruction, and a local-first cost ledger computing USD spend as usage rows × `cost_per_1k` with rollups, dashboard, and a self-check verifier. Dual workspaces read PG; local-tier workspaces read the file truth (`token-usage.json` × local model costs) via the same gate.

## Feature Scope
In-scope:
- Span lifecycle: start/end (sync + async wrappers), error capture, per-run trace reconstruction, stats.
- Cost ledger reads: per-run entries, per-run rollups, by-model dashboard, SQL-aggregate accuracy verifier.
- Pure helpers: row-cost math and entry rollup usable without a DB.
Non-goals (other domains):
- Token counting and usage-row writes → Shared TokenTracker, which dual-writes every completion local-first (`token-usage.json` + file budget) with PG as the replica leg in dual tier (this domain reads both tiers through the same gate).
- Model pricing writes → Modules (`model_modules.cost_per_1k`; this domain only joins it).
- Run lifecycle/status → Runs (this domain attaches `runtimeType`/`status` as display metadata only).
- Metrics transport, auth, enablement → Routes (`routes/observability.ts`, `routes/metrics.ts` own the HTTP surface and its guards).
- Log pipeline → Shared structured-log (`logMetric` is borrowed, not owned).

## Expect
- [Observed] `endSpan` computes `durationMs` rounded to 0.1ms and stores a snapshot copy; the live object stays reachable via the internal id map (`tracing.ts:107-149`).
- [Observed] `endSpan` computes `durationMs` rounded to 0.1ms and stores a snapshot copy; the live object stays reachable via the internal id map (`tracing.ts:107-149`). `endSpan` is idempotent — a double-end returns the span untouched (OBS-009 fixed).
- [Observed] Spans without a `runId` are dropped from storage by contract: `endSpan` still stamps duration/status and closes the OTel sidecar, but the span is not stored and no `__global` bucket exists (OBS-007 fixed; `tracing.ts:159,179`).
- [Observed] Store bounds are 500 spans per run and 1000 run buckets, evicting oldest-first (`tracing.ts:48-49`, `tracing.ts:130-149`).
- [Observed] `withSpan`/`withSpanSync` always end the span and rethrow on error (`tracing.ts:163-193`).
- [Observed] `computeRowCostUsd` returns `null` for null or non-finite `costPer1k`, else `(rate × (prompt + completion)) / 1000` (`cost-ledger.ts:61-69`).
- [Observed] Ledger limit clamps to 1–1000 (default 100); dashboard and verifier both use the clamped limit (default 100 = the served window), so a verify confirms the served total (OBS-004; `cost-ledger.ts:50-55`, `cost-ledger.ts:258-259`, `cost-ledger.ts:310-316`).
- [Observed] `verifyLedgerAccuracy({ limit })` caches 60s per tenant scope+limit and matches within 1% (`cost-ledger.ts:310-335`). Was module-global, served cross-tenant totals (OBS-003 fixed). Ground truth is windowed to the same limit as the dashboard read it checks (default 100 — the served default; explicit limits honored) and delta is a true percentage (OBS-004 fixed). Span registry bounded at 10k with eviction (OBS-001 fixed); `getAllTraces` returns newest-first (OBS-008 fixed). Cross-domain reads go through `runsGate.getMetaByIds` (RUN-012/XD-012 fixed).
- [Observed] `rollupFromEntries` is pure: groups by `runId` (or `__no_run:channel:agent`), sums tokens/costs, sorts by `lastSeen` desc (`cost-ledger.ts:185-217`).
- [Inferred] Hot-path runtime code reaches spans through the gate (`observability-gate.js` dynamic import + `startSpan`), so gate-shape stability covers the actually-called path (`tool-executor.ts:325-327`, `runtime-kernel.ts:68-71`, `context-assembler.ts:49-51`).

## Flow
1. Start: `startSpan(name, { runId, channelId, agentId, parentSpanId, traceId, attributes })` mints a 16-hex `spanId`, inherits or generates the trace id, registers the live object, and best-effort opens a real OTel span when enabled (`tracing.ts:63-105`).
2. End: `endSpan(span, { error, attributes })` stamps end/duration, folds errors into `status/errorMessage/attributes`, emits a `trace.<name>` metric log, stores a copy under the run (run-less spans are never stored — OBS-007), and closes the OTel sidecar (`tracing.ts:107-161`).
3. Wrap: `withSpan`/`withSpanSync` bracket a function, ending clean or with the thrown error before rethrowing (`tracing.ts:163-193`).
4. Read back: `getTrace(runId)` returns copies for one run; `getAllTraces(limit)` groups stored run buckets (newest-first; no `__global` bucket — run-less spans are dropped); `getTraceStats` counts buckets + spans (`tracing.ts:187-198`); tests reset via `clearTracesForTests` (`tracing.ts:209-212`).
5. Instrument: runtime hot paths open `assemble` (context build), `llm` (provider call), `tool` (tool execution), and `persist` (message write) spans with run/channel/agent correlation (`context-assembler.ts:46-47`, `runtime-kernel.ts:52-54`, `tool-executor.ts:325-327`).
6. Ledger: `getPerRunCostLedger({ runId, channelId, agentId, limit, workspaceId })` is local-first: an explicit `workspaceId` reads via `withStoreFallback` (file truth in local tier, PG gap-fill in dual), while legacy unscoped callers keep the ambient-DB path with a file degrade on outage. The PG leg joins `token_usage_log` to `model_modules` for `cost_per_1k`, probing the `run_id` column with a legacy fallback to unkeyed entries; the file leg reads `token-usage.json` and prices via the workspace-aware module gate. `getPerRunRollup` derives pure rollups, attaches run metadata in one batched query, and logs a rollup metric.
7. Dashboard: `getCostDashboard({ limit, workspaceId })` batches one ledger fetch with one workspace-aware model-meta lookup, derives `byRun` purely, aggregates `byModel`, and rounds the total to 4dp.
8. Verify: `verifyLedgerAccuracy({ limit, workspaceId })` compares the dashboard total to a single-row SQL `SUM` ground truth over the SAME newest-N window (default 100 = the served dashboard default) and reports `{ match, ledgerTotal, recomputedTotal, deltaPct }` with a true-percentage delta (OBS-004). In local tier the SQL leg fails soft and the check trivially matches the file total.
9. Serve: `GET /api/observability/trace/:runId`, `/traces`, `/cost/ledger`, `/cost/dashboard`, `/cost/verify` expose the gate (admin-guarded when configured); cost reads thread `x-workspace-id` through as `workspaceId` and mark file-truth answers with `localMode: true` (`routes/observability.ts`); `GET /metrics` and `/api/metrics` attach trace stats to the perf snapshot unless disabled (`routes/metrics.ts:14-27`).
10. Degrade: the three cost reads serve real file totals in local tier (zero spend until runs record usage locally), never an honest-zero mask over hidden spend; a connection-class failure from a database-backed read degrades to the local mirror instead of 500-ing. Trace reads are process-local memory and never degrade. Logic errors still propagate.

## Current Implementation
- `observability/tracing.ts` → span facade + store. `TraceSpan`/`StartSpanOptions`/`SpanStatus` (`tracing.ts:17-43`); `traceStore` (runId → spans) + `spanById` live map with 500/1000 bounds (`observability/tracing.ts:46-49`); `isOtelEnabled` reads `OTEL_ENABLED` (`tracing.ts:51-53`); `startSpan`/`endSpan`/`withSpan`/`withSpanSync`/`getTrace`/`getAllTraces`/`getSpanById`/`clearTracesForTests`/`getTraceStats` (`tracing.ts:63-213`).
- `observability/cost-ledger.ts` → spend math + reads. `CostLedgerEntry`/`PerRunCostRollup`/`CostDashboard` (`cost-ledger.ts:12-46`); `computeRowCostUsd`/`getPerRunCostLedger`/`rollupFromEntries`/`attachRunMeta`/`getPerRunRollup`/`getCostDashboard`/`verifyLedgerAccuracy` with 60s per-scope verify cache and windowed ground truth (`cost-ledger.ts:52-334`).
- `observability/observability-gate.ts` → thin facade. Re-exports 5 types and wires 15 functions into `observabilityGate`; no logic (`observability-gate.ts`).
- `routes/observability.ts` → HTTP surface + the local-tier/outage degradation boundary for the three cost reads (`isLocalTierRead`, `withOutageDegradation`, `emptyDashboard`/`emptyLedger`/`emptyVerify`); trace reads pass straight through (`routes/observability.ts:34-88`).
- `routes/observability.test.ts` → regression coverage for the screenlock-targeting and local-tier/outage contracts, asserting both through the real server factory with a temp registry.

## Ports
- `TraceSpan` — span record type (`traceId/spanId/parent/run/channel/agent/attributes/status/errorMessage`).
- `StartSpanOptions` — span start options type.
- `CostLedgerEntry` — one usage-row-plus-cost record type.
- `PerRunCostRollup` — per-run token/cost aggregate type.
- `CostDashboard` — `{ totalCostUsd, totalTokens, totalRuns, byRun, byModel, generatedAt }` type.
- `observabilityGate.startSpan` — starts a span (optionally under an OTel sidecar).
- `observabilityGate.endSpan` — ends a span with optional error/attributes.
- `observabilityGate.withSpan` — runs an async fn inside a span, rethrowing on error.
- `observabilityGate.withSpanSync` — runs a sync fn inside a span, rethrowing on error.
- `observabilityGate.getTrace` — returns span copies for one run.
- `observabilityGate.getAllTraces` — returns spans grouped by run (runId only; no synthetic bucket).
- `observabilityGate.getSpanById` — returns one live span by id (parent-chain traversal).
- `observabilityGate.getTraceStats` — returns `{ totalRuns, totalSpans }` counts.
- `observabilityGate.clearTracesForTests` — clears the in-memory trace store.
- `observabilityGate.getPerRunCostLedger` — lists cost ledger entries by filter (one clamped limit).
- `observabilityGate.getPerRunRollup` — ledger entries rolled up by run with run metadata.
- `observabilityGate.rollupFromEntries` — pure entry-to-rollup grouping.
- `observabilityGate.getCostDashboard` — aggregated cost dashboard (one clamped limit).
- `observabilityGate.verifyLedgerAccuracy` — ledger-vs-SQL-SUM check within 1% over the same window (`{ limit? }`, default 100).
- `observabilityGate.computeRowCostUsd` — USD cost for one usage row.
- `observabilityGate.clampLimit` — one limit helper (`OBS_LIMIT_DEFAULT=100`, `OBS_LIMIT_MAX=1000`).

## Relations
Gates this domain calls:
- None. Shared-only: `shared/core/structured-log.ts` (`logMetric`), `shared/config/database.ts` (`getDb`), `db/schema.ts` (`tokenUsageLog`, `modelModules`, `runs`).
Known outside callers:
- Routes: `routes/observability.ts` (trace + ledger + dashboard + verify reads); `routes/metrics.ts` (`getTraceStats` attached to perf snapshot).
- Runtime hot paths via `observabilityGate` (dynamic import, null-safe): `tools/tool-executor.ts` (`tool` spans), `runtime/kernel/runtime-kernel.ts` (`llm`/`persist` spans), `runtime/kernel/context-assembler.ts` (`assemble` spans); `tool:complete` also flows as a broker event, not a span.
- Tests: `observability/tracing.test.ts`, `shared/core/failure-modes.test.ts`, `memories/embeddings.test.ts`.
Tables shared with other domains (read-only here, owned elsewhere):
- `token_usage_log` (TokenTracker writes; `run_id` FK → `runs.id` with set-null), `model_modules` (Modules owns; `cost_per_1k` is the price source), `runs` (Runs owns; single batched metadata lookup).

## Emits-Listens
- None — `logMetric` structured-log writes are not broker events; this domain neither emits nor subscribes.

## Owns
- None — the trace store is process-local memory (not a table/queue) and the ledger writes no tables; all DB access here is read-only.

## Flags
- `OTEL_ENABLED` — `true` opens a real `@opentelemetry/api` sidecar span per `startSpan` (best-effort dynamic import, failures swallowed), default false (`tracing.ts:51-53`, `tracing.ts:80-102`).
- `METRICS_ENABLED` — `false` disables the `GET /metrics` + `/api/metrics` routes entirely; read at route layer, not here (`routes/metrics.ts:12`).
- `WORKSPACE_ADMIN_TOKEN` — when set, additionally admin-guards the observability routes; read at route layer, not here (`routes/observability.ts:99`). Metrics routes are unguarded.

## Decisions
- [Observed] OTel as optional sidecar over an in-memory store — why: tracing must work in tests and flag-off deployments with zero hard dependencies (`tracing.ts:5-15`, `tracing.ts:80-102`).
- [Observed] Bounded store with oldest-first eviction (500/run, 1000 runs) — why: long-lived processes must not grow trace memory without bound (`tracing.ts:48-49`, `tracing.ts:130-149`).
- [Observed] `endSpan` stores a copy while the id map keeps the live object — why: reconstructions are stable snapshots even if holders mutate spans later (`tracing.ts:141`, `tracing.ts:78`).
- [Observed] Cost computed at read time from `cost_per_1k`, never stored — why: price edits retroactively reprice history without backfills (`cost-ledger.ts:61-69`, `cost-ledger.ts:89-104`).
- [Observed] Run metadata attached in one batched query, errors swallowed — why: `N+1` lookups and run-table outages must not break the ledger (`cost-ledger.ts:211-228`).
- [Observed] Verifier compares against a single-row SQL `SUM` windowed to the same limit, with a 60s per-scope cache — why: windowed re-reads keep the check like-for-like and cheap; periodic self-check suffices (`cost-ledger.ts:310-335`).
- [Observed] `run_id`-missing fallback to unkeyed entries — why: rollback-safe pre-migration (`cost-ledger.ts:120-161`).
- [Inferred] Route-layer (not gate) owns enablement and admin gating — why: the gate stays import-safe for hot paths while exposure policy lives with transport (`routes/metrics.ts:12`, `routes/observability.ts:99`).
- [Observed] A local-tier or unreachable database answers an honest empty cost shape, not an error — why: the ledger is derived from PG-only tables, so "no ledger rows" and "endpoint broken" must be distinguishable to the polling panel, and a 30s poll must never 500 (`routes/observability.ts:24-101`). Same boundary `local-mode-guard.ts` applies to modules/skills/providers.
- [Observed] Only connection-class failures degrade; logic errors still propagate — why: masking a real defect as "zero spend" would hide bugs behind a plausible number (`routes/observability.ts:117-144`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. OTel sidecar plus bounded store stay; trace identity, endpoint wiring, and ledger scope are the gaps.
OTel stays an optional sidecar over an in-memory store with zero hard dependencies. Tests and flag-off deployments trace without an exporter.
Bounded store with oldest-first eviction stays. Long-lived processes never grow trace memory without bound.
endSpan stores a copy while the id map keeps the live object. Reconstructions are stable snapshots.
getTraceStats MUST exclude the global bucket from run counts. Inflated run counts are forbidden.
Trace ids MUST be 32-hex OTel standard or explicitly labeled non-OTel with a documented collector mapping. Silent 48-hex drift is forbidden.
OTEL_EXPORTER_OTLP_ENDPOINT MUST be read or removed. Documented-but-unread config is forbidden.
In-memory traces vanishing on restart plus no cross-instance view MUST be a declared single-process limitation until shared trace shipping exists.
getCostDashboard plus verifyLedgerAccuracy MUST share one query scope and limit. Verified total over different rows than served total is forbidden.
Verifier delta MUST use a true percentage with documented near-zero handling. Silent max(1,dashboard) floor is forbidden.
token_usage_log.run_id backfill MUST be documented: backfilled or permanent no-run grouping, never unverified.
Cost computed at read time from cost_per_1k is retroactive repricing and MUST be an explicit product contract. Silent retroactive reprice is forbidden.
## Failure + Resume
- OTel import/create/end failures are caught and swallowed — tracing silently degrades to in-memory only (`tracing.ts:92-101`, `tracing.ts:83-101`).
- `withSpan`/`withSpanSync` record the error on the span, then rethrow — observability never suppresses caller errors (`tracing.ts:163-193`).
- Run-metadata and model-meta lookups fail soft (`catch {}` → missing fields, `[]` fallback) — dashboard still renders from ledger rows (`cost-ledger.ts:224-236`, `cost-ledger.ts:260-266`).
- Pre-migration schema (no `run_id`) falls back to unkeyed entries grouped by channel+agent (`cost-ledger.ts:120-161`, `cost-ledger.ts:185-189`).
- Store overflow evicts the least-recently-written run bucket / oldest span silently; run-less spans never enter the store (OBS-007), so they consume no budget (`tracing.ts:180-198`).
- No resume mechanics: spans are fire-and-forget records; costs recompute from source tables on every read.
- Cost reads: local-tier workspace or `NO_DATABASE` → empty shape with `localMode: true` (200, not 500); unreachable database (connection-class) → same empty shape; a logic error → still a 500, deliberately (`routes/observability.ts:117-144`).

## Gaps
- Run-less spans are silently dropped (no store, no counter) — pinned contract; operator visibility of run-less work depends on the `trace.<name>` metric log, not `/traces` or `/metrics` stats.
- Generated trace ids are 48 hex chars (32+16), not the 32-hex OTel standard — correlation with external OTel collectors is unverified (`tracing.ts:59-61`).
- `OTEL_EXPORTER_OTLP_ENDPOINT` has no references under `server/src` — configured endpoints may be silently ignored .
- In-memory traces vanish on restart and are invisible across instances — multi-process deployments have no shared trace view; no bullmq-ported trace shipping observed.
- The empty cost shapes report `localMode: true` and zero totals but do NOT distinguish "workspace has no ledger" from "database briefly unreachable" — a caller cannot tell which. Whether the panel needs that distinction is unverified.
- `shouldDegradeCostRead`-style tier resolution runs per cost request; whether the ≤60s `tierContextFor` record cache makes that cheap enough under a polling panel was not measured.
- Resolved 2026-10-07: OBS-004 — `verifyLedgerAccuracy({ limit })` verifies the same window the served dashboard read uses (default 100, explicit limit honored; cache keyed scope+limit); ground-truth SUM is windowed via subquery to the same newest-N rows; delta is a true percentage `|a-b|/max(|a|,|b|)` with the near-zero rule "both sides < $0.0001 => delta 0" (`cost-ledger.ts:310-335`). Tests: `cost-ledger-verify.test.ts:82`.
- Whether `token_usage_log.run_id` backfill exists for pre-migration rows (vs permanent `__no_run` grouping) is unverified.
- Resolved 2026-10-07: OBS-001 spanById registry bounded at 10k oldest-first (`tracing.ts:52,92`); OBS-002 fast/run-less spans closed via pending-promise OTel handshake (`tracing.ts:102,127,172-179,201`); OBS-004 windowed ground truth + true-percentage delta (`cost-ledger.ts:310-335`); OBS-007 run-less spans dropped by contract, absent from all reads (`tracing.ts:159,179`). Tests: `tracing.test.ts:85,100,126`, `cost-ledger-verify.test.ts:82`.

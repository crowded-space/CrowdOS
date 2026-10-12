# Observability spans and cost ledger
> Type: Feature · Status: drifting · Updated: 2026-09-12

## Intent
Operators need to answer "what did a run do, and what did it cost" with no mandatory collector. This feature keeps execution insight process-local: an in-memory span store reconstructs per-run traces, and spend is derived at read time from usage rows joined to model prices, served through a dashboard plus a self-check verifier.

## Architectural decision
Tracing works with zero hard dependencies because the store is in-memory first and OTel is an optional best-effort sidecar, so tests and flag-off deployments get traces for free [Observed]. Cost is computed at read time from `cost_per_1k` and never stored, so price edits retroactively reprice history without backfills [Observed]. The store is bounded (500 spans per run, 1000 run buckets, oldest-first eviction) so long-lived processes cannot grow trace memory without bound [Observed]. Run metadata attaches in one batched query with failures swallowed, so run-table outages degrade the ledger instead of breaking it [Observed]. The shipped shape keeps spans as fire-and-forget memory while only cost reads touch the DB; the rejected alternative is a durable span pipeline, of which no trace was observed [Inferred].

## How it works
It starts in Observability: `startSpan(name, { runId, channelId, agentId, parentSpanId, traceId, attributes })` mints a 16-hex `spanId`, inherits or generates the trace id, registers the live object, and best-effort opens a real OTel span when enabled. `endSpan` stamps end/duration (rounded to 0.1ms), folds errors into `status/errorMessage/attributes`, emits a `trace.<name>` metric log, stores a snapshot copy under the run (or the `__global` bucket when run-less), and closes the OTel sidecar; `withSpan`/`withSpanSync` bracket a function and always end the span, rethrowing on error. Runtime hot paths open `assemble` (context build), `llm` (provider call), `tool` (tool execution), and `persist` (message write) spans with run/channel/agent correlation. Reads go through `getTrace(runId)` for one run, `getAllTraces` for all buckets except `__global`, and `getTraceStats` for counts. The ledger side joins `token_usage_log` to `model_modules` for `cost_per_1k` (probing the `run_id` column with a legacy fallback to unkeyed entries), derives pure per-run rollups via `rollupFromEntries`, and serves `getCostDashboard` (one ledger fetch batched with one model-meta lookup, `byModel` aggregation, total rounded to 4dp) plus `verifyLedgerAccuracy` (dashboard total vs a single-row SQL `SUM`, match within 1%, 60s cache). Routes expose `GET /api/observability/trace/:runId`, `/traces`, `/cost/ledger`, `/cost/dashboard`, `/cost/verify` (admin-guarded when configured), and `GET /metrics` plus `/api/metrics` attach trace stats to the perf snapshot unless disabled.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Observability.md> | Owns the span store, lifecycle wrappers, row-cost math, ledger reads, dashboard, and verifier |
| <../Domain Spec/Runtime.md> | Instrumented hot paths: `assemble`, `llm`, `tool`, and `persist` spans with run/channel/agent correlation |
| <../Domain Spec/Runs.md> | Owns the `runs` table; this feature attaches `runtimeType`/`status` as display-only metadata in one batched read |
| <../Domain Spec/Modules.md> | Owns `model_modules.cost_per_1k`, the price source the ledger joins at read time (token-row writes live in Shared TokenTracker, HTTP surface in Routes) |

## Current state
Real: span lifecycle with error capture, per-run reconstruction, pure rollup helpers, per-run ledger reads, by-model dashboard, SQL-aggregate verifier, route exposure with metrics attach. Flag-gated: real OTel sidecar only when `OTEL_ENABLED=true` (failures swallowed, in-memory remains source of truth). Legacy: `run_id`-missing fallback to unkeyed `__no_run:channel:agent` grouping for pre-migration rows. Known rough edges that are real: hot paths import `tracing.ts` directly past the gate, `__global` inflates run counts, and the dashboard/verifier cover different row sets (see below).

## Alignment notes
- Gate bypass: `Observability.md` Expect already flags that runtime hot paths reach spans through the gate (`tool-executor.ts:325-327`, `runtime-kernel.ts:68-71`, `context-assembler.ts:49-51`) — verified in code, so gate-contract stability does not cover the actually-called path.
- `__global` run inflation: `getTraceStats` counts every bucket including `__global` (`tracing.ts:209-212`), so run counts inflate once run-less spans exist — doc Gaps and code agree, behavior unverified as intended.
- Dashboard vs verifier row sets: `getCostDashboard` defaults to limit 500 while `verifyLedgerAccuracy` uses 1000 (`cost-ledger.ts:257-258`, `cost-ledger.ts:303-305`) — the verified total and the served total can cover different rows.
- Trace-id shape: generated ids are 48 hex chars (32+16, `tracing.ts:59-61`), not the 32-hex OTel standard — correlation with external collectors is unverified.
- Dead endpoint config: `OTEL_EXPORTER_OTLP_ENDPOINT` has no references under `server/src` — a configured endpoint is silently ignored.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Spans stay assemble, llm, tool, persist with run, channel, agent correlation.
* Dashboard plus verifier share one query scope and limit. Different-row verification is forbidden.
* Trace ids are 32-hex OTel or explicitly non-OTel with mapping. Unread exporter config is forbidden.
* Cost at read time from cost_per_1k is an explicit retroactive-reprice contract. Authority: Observability standard.
## Open gaps
- `getSpanById` exists in `tracing.ts` but is not a gate port — parent-chain traversal has no public path.
- Whether `token_usage_log.run_id` backfill exists for pre-migration rows vs permanent `__no_run` grouping is unverified.
- In-memory traces vanish on restart and are invisible across instances — no shared trace view for multi-process deployments.
- Verifier delta divides by `max(1, dashboard)` (`cost-ledger.ts:315`) — near-zero ledgers compare against an absolute floor, not a true percentage.
- Store overflow silently evicts the oldest run bucket / oldest span; whether any consumer needs an eviction signal is unverified.

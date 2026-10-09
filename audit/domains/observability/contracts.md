# Observability Domain - Contracts (Phase 2, one row per gate port)

Legend - Pre: preconditions; Val: validation; Res: result; Err: error surface; Tenant: scoping; Idem: idempotency; Side: side-effects/ordering; Obs: observability side-effects; Perf.

## Gate ports (observability-gate.ts:9-26)

| Port | Pre | Val | Res | Err | Tenant | Idem | Side | Obs | Perf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| startSpan(name, opts) :63 | - | - | TraceSpan; spanId 16hex; traceId 48hex or parent traceId | never throws; OTel failures swallowed | none (runId optional) | new span per call | spanById.set (unbounded - OBS-001); async OTel sidecar when OTEL_ENABLED | none until endSpan | O(1) |
| endSpan(span, opts) :107 | span from startSpan | - | TraceSpan | never throws (OTel close swallowed) | none | NOT idempotent (OBS-009) | duration stamp; error fold; logMetric trace.<name>; stores snapshot under runId only (run-less dropped - OBS-007); evicts oldest bucket/span | 1 logMetric per call | O(1) amortized |
| withSpan(name, opts, fn) :153 | - | - | T (fn result) | rethrows fn error after endSpan(error) | - | per call | ends span exactly once | metric via endSpan | awaits fn |
| withSpanSync :171 | - | - | T | rethrows | - | per call | same as withSpan | metric via endSpan | sync |
| getTrace(runId) :187 | - | - | TraceSpan[] (array copy) | - | none | read-only | returns stored snapshots (shallow - OBS-014) | - | O(n) |
| getAllTraces(limit=100) :191 | - | count cap only | {runId, spans}[] | - | - | read-only | Map insertion order = OLDEST first (OBS-008) | - | O(limit) |
| getSpanById(spanId) :200 | - | - | live TraceSpan or undefined | - | - | read-only | returns the LIVE object, not snapshot | - | O(1) |
| getTraceStats() :209 | - | - | {totalRuns, totalSpans} | - | - | read-only | counts all stored buckets (run-less spans never stored) | - | O(runs) |
| clearTracesForTests() :205 | tests only | - | void | - | - | - | clears traceStore + spanById | - | O(1) |
| getPerRunCostLedger(opts) :71 | DB configured (route guards) | limit clamp 1..1000 default 100; runId/channelId/agentId filters | CostLedgerEntry[] | throws DB errors (route degrades connection-class only) | ambient getDb() (ALS) | read-only | legacy fallback path (limit before in-memory filters - OBS-005) | - | 1 join + limit |
| getPerRunRollup(opts) :239 | - | - | PerRunCostRollup[] sorted lastSeen desc | throws (same) | ambient | read-only | +1 batched runs lookup (errors swallowed); logMetric cost.ledger.rollup | 1 logMetric | O(n) |
| rollupFromEntries(entries) :185 | - | - | PerRunCostRollup[] | never | - | pure | group key runId else __no_run:channel:agent; sums tokens/costs | - | O(n log n) |
| getCostDashboard(opts) :257 | - | limit clamp default 100 | CostDashboard (total 4dp) | throws | ambient | read-only | + moduleGate.model.list + runs lookup (both swallowed) | - | O(n) |
| verifyLedgerAccuracy() :303 | - | - | {match, ledgerTotal, recomputedTotal, deltaPct} | throws | ambient; 60s module-global cache NOT workspace-keyed (OBS-003) | cache 60s | SQL SUM ground truth full-table vs dashboard limit 1000 (scope mismatch - OBS-004) | - | 1 SQL + dashboard |
| computeRowCostUsd(row, costPer1k) :61 | - | null/non-finite rate -> null | number or null | never | - | pure | none | - | O(1) |
| clampLimit = clampObsLimit(raw) :53 | - | min 1, max 1000, default 100 | number | - | - | pure | - | - | O(1) |

Flat value exports (gate :7): clampObsLimit, OBS_LIMIT_MAX=1000, OBS_LIMIT_DEFAULT=100.
Type exports (gate :6): TraceSpan, StartSpanOptions, CostLedgerEntry, PerRunCostRollup, CostDashboard.

## Route contracts (routes/observability.ts)

- All 5 routes: preHandler admin only when WORKSPACE_ADMIN_TOKEN set (:99); otherwise loopback trust (local-first).
- /trace/:runId (:103) and /traces (:109): process-local memory, no DB, no degradation. /traces documents recent traces but returns oldest-first (OBS-008).
- /cost/ledger (:117), /cost/dashboard (:132), /cost/verify (:141): local-tier workspace or connection-class DB failure -> honest empty shape with localMode:true, HTTP 200; logic errors propagate (:101-145, withOutageDegradation :79-88).
- Cost routes resolve tier per request via tierContextFor + resolveTier (:34-45).

## Cross-domain

- Reads token_usage_log + model_modules + runs. Runs table read bypasses runs-gate (OBS-013). No writes. No broker events. No tables/queues owned.

# Observability Domain - Invariants, Races (Phase 3)

Status: Enforced (code+test) / Enforced (code only) / Broken / Gap (unverified).

## 1. Entities

TraceSpan: traceId, spanId, parentSpanId, name, startTimeMs, endTimeMs, durationMs, attributes, status ok|error, errorMessage, runId/channelId/agentId. CostLedgerEntry: runId, agentId, channelId, modelModuleId, token counts, costUsd, timestamp. PerRunCostRollup: per-run aggregates + entries + firstSeen/lastSeen + runtimeType/status meta.

## 2. Invariants

| ID | Invariant | Evidence | Status |
| --- | --- | --- | --- |
| INV-1 | Ended span with runId is reconstructable via getTrace; traceId/spanId truthy; duration >= 0 | tracing.ts:129-141; tracing.test.ts:8-26 | Enforced (test) |
| INV-2 | Store bounded: 500 spans/run, 1000 buckets, oldest evicted first | tracing.ts:48-49,133-140 | Enforced (code; eviction untested TG-11) |
| INV-3 | Run-less spans are NOT stored (no __global bucket) | tracing.ts:129-130 | Enforced (code); docs contradict (OBS-007) |
| INV-4 | endSpan emits exactly one trace.<name> metric per call | tracing.ts:116-127 | Broken for double-end (OBS-009) |
| INV-5 | withSpan/withSpanSync always end the span and rethrow on error | tracing.ts:153-184; tracing.test.ts:47-62 | Enforced (test for withSpan; sync untested) |
| INV-6 | cost = rate*(prompt+completion)/1000; null/non-finite rate -> null | cost-ledger.ts:61-69; tracing.test.ts:41-46; failure-modes.test.ts:260-264 | Enforced (test) |
| INV-7 | Ledger limit clamped 1..1000, default 100 | cost-ledger.ts:50-54,78,258 | Enforced (code) |
| INV-8 | rollupFromEntries is pure: groups runId else __no_run:channel:agent; sums; sorts lastSeen desc | cost-ledger.ts:185-217 | Enforced (code) |
| INV-9 | Verifier reports match when delta <= 1% vs SQL SUM | cost-ledger.ts:303-322 | Broken in edge scopes (OBS-004); zero dashboard total forces delta 0 |
| INV-10 | Domain performs no DB writes | cost-ledger.ts selects only | Enforced (code) |
| INV-11 | Domain emits/listens no broker events | grep clean; docs Emits-Listens none | Enforced |
| INV-12 | Cost routes degrade to honest empty (localMode:true, 200) on local tier or connection outage; logic errors propagate | routes/observability.ts:34-101,117-145; routes/observability.test.ts (6 tests) | Enforced (test) |
| INV-13 | Production code imports only the gate | check-gates 0 violations; rg 0 direct tracing/cost-ledger imports outside domain | Enforced (tool) |
| INV-14 | Traces are process-local; vanish on restart; no cross-instance view | tracing.ts:46 (Map) | Declared limitation (docs) |
| INV-15 | Hot paths (assemble/llm/tool/persist) correlate via runId/channel/agent | context-assembler.ts:49-51; runtime-kernel.ts:68-71,191-193; tool-executor.ts:325-327 | Enforced (code) |
| INV-16 | Child span with parentSpanId inherits parent traceId when parent is in spanById | tracing.ts:65 | Enforced (code; untested TG-16) |

## 3. Races / lifecycle hazards

- OTel sidecar attach race: startSpan kicks an async dynamic import and assigns __otelSpan later (tracing.ts:83-102); endSpan reads it synchronously (:144-151) - fast spans never end the sidecar (OBS-002).
- verifyCache is module-global across workspaces (OBS-003); first caller in a 60s window wins for all tenants.
- Bucket eviction is insertion-order, not LRU; an active run bucket can be evicted while receiving spans (OBS-011).
- Double endSpan duplicates stored spans + metrics (OBS-009).

## 4. Broken / drift invariants (defects)

INV-4, INV-9 broken in edge cases; INV-3 and verifier/dashboard scope documented wrongly (OBS-007, OBS-016). See bug-ledger.csv.

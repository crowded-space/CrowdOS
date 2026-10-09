# Observability Domain - Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: packages/server/src/observability (4 files), facade observability-gate.ts, transport routes/observability.ts + routes/metrics.ts, all callers (grep-verified), persistence (schema + migration 0009), config/env, tests, docs. Time-boxed 20 min; items not fully traced are marked Low-confidence.

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| observability-gate.ts | 1659 | Thin facade: 5 type re-exports, 3 flat value re-exports, 16 gate ports, no logic |
| tracing.ts | 6783 | In-memory span store + optional OTel sidecar; start/end/wrappers/reads/stats |
| cost-ledger.ts | 12669 | Read-only cost ledger: row math, ledger query (legacy fallback), rollups, dashboard, verifier with 60s cache |
| tracing.test.ts | 2828 | 4 unit tests via gate: span record/reconstruct, cost math, withSpan ok/error |

Naming: all *.ts kebab-case (AGENTS.md 1 compliant). Gate is thin wire/re-export only (compliant).

## 2. Facade surface (exact, observability-gate.ts:1-26)

Type exports (5, :6): TraceSpan, StartSpanOptions, CostLedgerEntry, PerRunCostRollup, CostDashboard.
Flat value exports (3, :7): clampObsLimit, OBS_LIMIT_MAX=1000, OBS_LIMIT_DEFAULT=100.
Gate ports (16, :9-26): startSpan, endSpan, withSpan, withSpanSync, getTrace, getAllTraces, getSpanById, getTraceStats, clearTracesForTests, getPerRunCostLedger, getPerRunRollup, rollupFromEntries, getCostDashboard, verifyLedgerAccuracy, computeRowCostUsd, clampLimit.
Domain internals (not reachable past gate): genId/genTraceId/isOtelEnabled, traceStore, spanById, MAX_SPANS_PER_RUN=500, MAX_RUNS=1000, attachRunMeta, verifyCache.

## 3. Dependency map (Caller -> Facade -> impl -> side effects)

Production callers (all through the gate; zero direct tracing.js/cost-ledger.js imports outside the domain - rg verified):
- routes/observability.ts:3-4 - gate + flat exports (clampObsLimit, OBS_LIMIT_MAX) + types; 5 GET routes (:103-145).
- routes/metrics.ts:4,16,24 - getTraceStats attached to perf snapshot under try/catch.
- tools/tool-executor.ts:325-327 - dynamic gate import; tool span (ends :813/:819).
- runtime/kernel/runtime-kernel.ts:68-71 - dynamic; llm span (ends :74/:77); persist span :191-193 (ends :216/:223).
- runtime/kernel/context-assembler.ts:49-51 - dynamic; assemble span (ends :98/:101).
- Client: packages/client/components/workspace/RightSidebar.tsx:72 - polls GET /api/observability/cost/dashboard with x-workspace-id.
Tests (gate imports): tracing.test.ts; memories/embeddings.test.ts:3,7; shared/core/failure-modes.test.ts:4 (20 tests use gate).
In-domain deps: shared/core/structured-log (logMetric), shared/config/database (getDb), db/schema (tokenUsageLog, modelModules, runs), modules/module-gate (moduleGate.model.list).
Cross-domain: reads runs table directly in attachRunMeta (cost-ledger.ts:226, past runs-gate - OBS-013; cross-ref RUN-012).
check-gates: 0 violations across 361 files/23 domains; TEST-ONLY finding routes/observability.test.ts -> workspace-registry.js.

## 4. Entry points

HTTP: GET /api/observability/trace/:runId, /traces, /cost/ledger, /cost/dashboard, /cost/verify (adminPreHandler only when WORKSPACE_ADMIN_TOKEN is set, routes/observability.ts:99); GET /metrics + /api/metrics (routes/metrics.ts:14-27, disabled when METRICS_ENABLED=false). Registered at routes/index.ts:25,54.
Jobs/sockets/events: none. Domain is in-memory + read-only; no broker emit/listen (grep clean).

## 5. Persistence

Reads only: token_usage_log (schema.ts:370-384; run_id uuid FK->runs ON DELETE set null, index :382), model_modules.cost_per_1k, runs (id/runtimeType/status). Migration 0009 adds run_id + FK + cost_ledger_per_run view (0009:6-10, 35-48). No writes from this domain.

## 6. Config/env

OTEL_ENABLED (env.ts:240, default false; read tracing.ts:52). METRICS_ENABLED (routes/metrics.ts:12). WORKSPACE_ADMIN_TOKEN (routes/observability.ts:99). OTEL_EXPORTER_OTLP_ENDPOINT: documented, zero code refs (OBS-017). OBS limits default 100 / max 1000 (cost-ledger.ts:50-51).

## 7. Docs

re-docs/Backend Docs/Domain Spec/Observability.md and Feature and Flow Spec/Observability spans and cost ledger.md. Drift found (OBS-016): __global claims, dashboard-fetches-500 claim, hot-paths-import-tracing-directly claim, stale line refs. Docs sync NOT performed (read-only audit; AGENTS.md 6 noted).

## 8. Baseline (exact commands + results)

| Command (packages/server) | Result |
| --- | --- |
| npx vitest run src/observability | 1 file, 4 tests passed (2.43s) |
| npx vitest run src/routes/observability.test.ts | 1 file, 6 tests passed (10.74s) |
| npx vitest run src/shared/core/failure-modes.test.ts | 1 file, 20 tests passed (5.94s) |
| npx vitest run src/memories/embeddings.test.ts | 1 file, 4 tests passed (2.33s) |
| npx tsc -p tsconfig.json --noEmit | exit 0 (TSC_OK) |
| node scripts/check-gates.mjs | 0 violations, 361 files, 23 domains; 3 allowlisted pre-existing (none observability); observability TEST-ONLY: routes/observability.test.ts -> workspace-registry.js |

Git: branch main; no production edits; only audit/ added. No commit (per AGENTS.md flow).

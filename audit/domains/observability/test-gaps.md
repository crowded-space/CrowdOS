# Observability Domain - Test Gaps (Phase 4)

## Baseline (exact commands + results, run during audit)

| Command (cwd packages/server) | Result |
| --- | --- |
| `npx vitest run src/observability` | 1 file, 4 tests passed (2.43s) |
| `npx vitest run src/routes/observability.test.ts` | 1 file, 6 tests passed (10.74s) |
| `npx vitest run src/shared/core/failure-modes.test.ts` | 1 file, 20 tests passed (5.94s) |
| `npx vitest run src/memories/embeddings.test.ts` | 1 file, 4 tests passed (2.33s) |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 (TSC_OK) |
| `node scripts/check-gates.mjs` | Gate rule OK: 361 files, 23 domains, 0 violations; 3 pre-existing allowlisted (none observability); observability TEST-ONLY finding: routes/observability.test.ts -> workspace-registry.js |

No failures. Gaps below are untested behaviors; no tests added (read-only audit).

## Gaps (mapped to ledger IDs)

| # | Gap | Ledger | Why it matters |
| --- | --- | --- | --- |
| TG-1 | No test for spanById growth / eviction bound | OBS-001 | Unbounded memory on hot path |
| TG-2 | No test that a fast span still closes the OTel sidecar (needs @opentelemetry/api mock) | OBS-002 | Sidecar silently no-ops |
| TG-3 | No test that verifyCache is tenant/workspace safe | OBS-003 | Cross-tenant bleed |
| TG-4 | No test pinning dashboard-vs-verifier scope/limit semantics or zero-total handling | OBS-004 | Verifier meaningless in edge scopes |
| TG-5 | No fallback-path filter test (filter-before-limit) | OBS-005 | Silent under-report pre-migration |
| TG-6 | No test that non-column errors rethrow from the ledger probe | OBS-006 | Real defects masked as legacy data |
| TG-7 | No test pinning run-less span contract (drop vs bucket) | OBS-007 | Operator blind spot / doc drift |
| TG-8 | No test for getAllTraces recency vs oldest-first | OBS-008 | Stale traces under load |
| TG-9 | No double-endSpan idempotency test | OBS-009 | Duplicate spans/metrics |
| TG-10 | No eviction test (active bucket vs oldest-first) | OBS-010 | Silent span loss at scale |
| TG-11 | No mutation-after-end snapshot isolation test | OBS-011 | Trace corruption by holders |
| TG-12 | No route test that /metrics follows admin policy when WORKSPACE_ADMIN_TOKEN set | OBS-012 | Auth inconsistency |
| TG-13 | No gate-contract test that observability never touches runs table directly | OBS-013 | Boundary erosion |
| TG-14 | No parent-chain traceId inheritance test (parentSpanId in spanById) | INV-16 | Untested correlation path |
| TG-15 | No test that withSpanSync ends span + rethrows | INV-5 | Untested wrapper |
| TG-16 | No real-DB test for cost-ledger SQL (join, fallback probe, attachRunMeta) - route tests only cover degradation paths | OBS-004/005/006 | Adapter-level drift untested |
| TG-17 | No test that OTEL_EXPORTER_OTLP_ENDPOINT is either read or rejected at boot | OBS-016 | Documented-but-unread config |

## Coverage verdict

Tracing lifecycle happy paths are well pinned (store, wrappers, error capture, math). Boundary/route degradation has dedicated regression tests. Untested: memory bounds, idempotency, tenant cache, verifier scope, fallback filters, eviction, OTel sidecar timing, and the entire cost-ledger SQL surface (no real-DB suite).

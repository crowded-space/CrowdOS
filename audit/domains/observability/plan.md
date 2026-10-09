# Observability Domain - Ordered Fix Plan (proposal only; no implementation this turn)

## Rewrite decision

INCREMENTAL REFACTOR (preferred). The domain is small (2 source files + thin gate), gate-compliant, zero cycle, with sound seams: tracing store vs cost reads. The high-severity findings (OBS-002/003/004/007/009) are localized defects in existing paths, not architectural dead ends. A rewrite would risk the 34 pinned tests + hot-path dynamic-import contract for no structural gain. Keep facade contract unchanged.

## Architecture assessment (A-E)

- A. Facade: thin, wire-only, no logic; 16 ports + 3 flat exports; slight over-surface (OBS-017) and one doc mismatch (OBS-019). Compliant with AGENTS.md 2.
- B. Domain split: tracing.ts / cost-ledger.ts is a clean two-halves decomposition (memory traces vs DB-derived cost). No further split needed; verifyCache is the only module-global state (OBS-003).
- C. Persistence: read-only over token_usage_log x model_modules x runs; migration 0009 complete (run_id + FK + view). Risks: broad catch fallback (OBS-006), fallback filter-after-limit (OBS-005), runs table read past gate (OBS-013).
- D. Isolation: production imports are gate-only (check-gates 0 violations); the one leak is a table read (OBS-013). Tenant scoping of cost reads relies on ambient ALS getDb() and per-request tier checks - sound, except verifyCache (OBS-003).
- E. Operations: honest degradation is well designed and tested; gaps are /metrics auth parity (OBS-012), OTel exporter config never read (OBS-016), trace visibility limits (OBS-007/008/010) and process-local traces (OBS-014, accepted).

## Ordered steps

| # | Step | Files / symbols | IDs | Tests | Compat | Migration / rollback | Verify |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | endSpan idempotency guard (ended flag; return span on re-end) | tracing.ts:107-141 | OBS-009 | double-end unit | Internal only | None (revert commit) | vitest src/observability |
| 2 | Bound spanById (LRU or delete on bucket evict) | tracing.ts:47,78,133-141,200-206 | OBS-001, OBS-010 | bound + eviction unit | Internal | None | vitest src/observability |
| 3 | Verifier scope fix: same limit for dashboard+ground truth; true percentage w/ documented near-zero; tenant-key or drop cache | cost-ledger.ts:301-322; routes/observability.ts:141-145 | OBS-003, OBS-004 | scope + cache isolation + zero-total unit | Response shape unchanged | None | vitest observability + routes |
| 4 | Run-less span contract: keep drop, fix docs (Domain Spec Expect/Gaps, Feature Spec) + pin test; align getAllTraces recency | tracing.ts:129-130,191-198; re-docs Observability.md + Feature doc | OBS-007, OBS-008, OBS-015, OBS-019 | contract + recency unit | Behavior: getAllTraces order (route docs already say recent) | None | vitest + docs review |
| 5 | Ledger probe robustness: detect column, rethrow non-column errors; fallback filters before limit | cost-ledger.ts:96-158 | OBS-005, OBS-006 | fallback harness unit | Internal | None | vitest (needs harness) |
| 6 | OTel sidecar correctness: single boot init or promise handshake; read OTEL_EXPORTER_OTLP_ENDPOINT or remove from docs/env | tracing.ts:83-102,144-151; env.ts:240; docs | OBS-002, OBS-016 | mocked-otel unit + boot test | Flag-gated | None | vitest |
| 7 | Runs metadata via gate: add runsGate.getMetaByIds port; consume in attachRunMeta | cost-ledger.ts:226; runs-gate.ts (additive port) | OBS-013 | gate contract test | Additive (runs gate port) | None | check-gates + vitest |
| 8 | Metrics auth parity: apply adminPreHandler when WORKSPACE_ADMIN_TOKEN set | routes/metrics.ts:12-27 | OBS-012 | route test | Behavior change (guarded deployments only) | None | vitest routes |
| 9 | Port surface decision: keep + document withSpanSync/getSpanById/getPerRunRollup or drop; fix Feature doc getSpanById claim | observability-gate.ts:12-21; docs | OBS-017, OBS-019 | contract test flat exports | Additive/drop decision | None | vitest + docs |
| 10 | Docs sync (AGENTS.md 6) in same task as each change; record ledger IDs in Alignment notes | re-docs Observability.md + Feature doc + _flow-index | all | manual | None | None | n/a |

## Compatibility and risk notes

- Steps 1-2 are internal correctness; no wire change. Step 3 fixes semantics only (same response shape). Step 4 changes getAllTraces ordering to match route docs. Step 7 is the only cross-domain additive port. Step 8 is opt-in via env.
- Rollback: every step code-only, no data migrations; revert the commit.
- AGENTS.md: main only; no branch; checks -> user review -> commit only on explicit yes; docs updated in the SAME task.

## Definition of Done (per step)

1. Failing test first, then fix; suite green; no new gate violations. 2. Docs updated in the same task when contract/behavior changes. 3. tsc exit 0. 4. User live review before commit.

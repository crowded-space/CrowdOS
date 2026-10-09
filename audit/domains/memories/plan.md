# Memories Domain — Ordered Fix Plan (proposal only; no implementation this turn)

## Rewrite decision

INCREMENTAL REFACTOR (preferred). The domain's seams are sound: thin gate, result-union contract, SQL-bounded retrieval window, single-write-funnel CRUD, degraded mirror. The high-severity findings (MEM-001/002/003) are localization fixes in existing paths, not architectural dead ends. A rewrite would risk the tool/runtime contract (open_memory/remember/discard + middleware) and the 28 pinned tests for no structural gain.

## Architecture assessment

- A. Facade: thin, re-export-only, compliant; but assembled by accretion (28 ports + instances + helpers + aliases) — MEM-004/011/018.
- B. Domain split: store/lifecycle/retrieval/embeddings/throttle/discards/local/env is a clean 8-module decomposition; embeddings is the outlier (second gate-shaped export, non-threaded handle) — MEM-011, G2.
- C. Persistence: PG-first with JSONL mirror is coherent; tenant threading is complete for CRUD/retrieval/lifecycle but not for audit (MEM-001) and not for note-level embeddings (documented gap).
- D. Isolation: tool-level identity wins over caller-supplied ids (verified); residual risks are degraded-mode scope (MEM-003) and audit DB (MEM-001).
- E. Operations: sweep is idempotent and ported to bullmq; telemetry is console-only on failure paths (MEM-014, ERR-2).

## Ordered steps

| # | Step | Files / symbols | IDs | Tests | Compat | Migration / rollback | Verify | DoD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Tenant-correct audit: thread db handle (or opts) into logMemoryUpdate; pass the same handle used for the note write | memory-lifecycle.ts:77-94; agent-memory-store.ts:374-380,596-603,649-656,704-711; memories-gate.ts (type only) | MEM-001 | Two-DB harness test | Internal only (optional param, default ambient) | None | npx vitest run src/memories | Audit row in same store as note |
| 2 | Degraded suppression parity: filter isSuppressionActive in retrieveLocalCandidates; align listLocal semantics | memory-retrieval.ts:163-179; agent-memory-store.ts:461-471 | MEM-002 | Local-mode suppression test | Behavior fix (degraded only) | None | npx vitest run src/memories | Future-suppressUntil note absent in degraded retrieval |
| 3 | Scoped local reads: pass workspaceId into readLocalMemoryNotes from patchLocalNote/readLocal/listLocal/retrieveLocal; keep merge only for explicit unscoped admin path | memory-local-store.ts:137-150; agent-memory-store.ts:405,421,462; memory-retrieval.ts:164 | MEM-003 | Two-scope isolation test | Internal only | None | npx vitest run src/memories | No cross-workspace rows in scoped reads |
| 4 | Retry correctness: retry only on id-collision (unique violation); rethrow others immediately; remove/repair dead UPDATE_FAILED return | agent-memory-store.ts:392-400 | MEM-012 | Deterministic-error attempt-count test | Internal only | None | npx vitest run src/memories | 1 attempt on deterministic error; 3 on collision |
| 5 | Facade consolidation: add logMemoryUpdate to memoriesGate OR document exclusion; retire/absorb embeddingsGate; document instance ports | memories-gate.ts:31-111; embeddings.ts:362-371 | MEM-004, MEM-011, MEM-018 | Contract test (flat ⊆ gate ∪ exempt) | Additive | None | node scripts/check-gates.mjs + vitest | One public contract |
| 6 | Input bounds: clamp listMemoryPreviews limit (MAX_PREVIEW_LIMIT=200 convention); consider bounded resolveAgentId query | agent-memory-store.ts:506; :236-243 | MEM-010, MEM-009 | Clamp test; perf/bound test | Additive clamp (callers ≤50 unaffected) | None | npx vitest run src/memories | limit 10k → 200 |
| 7 | Contract typing: reason optional (or runtime-required); generateNoteId arity fix; importanceScore validation (0..1) at domain boundary | agent-memory-store.ts:88-89,282-284,356 | MEM-005, MEM-006; OVF-1 | Type-level + unit tests | Widening types is additive; dropping arity is breaking only for callers passing args (none found) | None | npx tsc --noEmit + vitest | Types match runtime |
| 8 | Telemetry on swallow paths: metric for semantic-lane failure, mirror failure, audit failure | memory-retrieval.ts:128-155; agent-memory-store.ts:387-389,605,658,713; memory-lifecycle.ts:90-92 | MEM-007, MEM-014, ERR-2 | Failure-injection metric spies | None | None | npx vitest run src/memories | Metric emitted per failure path |
| 9 | Embedding coherence: deterministic profile pick; score-semantics parity between SQL and JS branches; metric on fallback | embeddings.ts:59-85,312-360 | MEM-015, MEM-008 | Parity + determinism tests | Internal only (no production caller) | None | npx vitest run src/memories | Deterministic, comparable scores |
| 10 | Sweep efficiency: DISTINCT agent_id query for enforceCapsAllAgents; consider cross-process sweep lock (Low) | memory-lifecycle.ts:196-214,224-250 | MEM-013, MEM-017 | Query-count test | Internal only | None | npx vitest run src/memories | Bounded sweep queries |
| 11 | Docs sync (AGENTS.md §6): update Domain Spec Memories.md Ports/Relations + Feature and Flow Spec docs + _flow-index for any contract change; record ledger IDs in Alignment notes | re-docs/Backend Docs/... | all fixed IDs | Manual review | None | None | n/a | Docs equal gate surface |
| 12 | Test-only boundary: route context-integrity.test.ts memory imports via memories-gate | runtime/kernel/context-integrity.test.ts:76-412 | BYPASS-1 | check-gates clean for memories | None | None | node scripts/check-gates.mjs | 0 memories TEST-ONLY findings |

## Compatibility and risk notes

- Steps 1-4 are correctness/isolation fixes; all internal signatures (optional params) — no wire/client change. No migrations required by any step (all DB structures already exist).
- Step 6 clamp could break a hypothetical caller passing >200; grep found no such caller (limit ≤50 everywhere).
- Step 5 is the only public-surface change; additive preferred.
- Rollback: every step is code-only; revert the commit. No data migrations introduced.
- AGENTS.md: main only; no branch; checks → user review → commit only on explicit yes. Docs updated in the SAME task as each behavior change.

## Definition of Done (per step)

1. Focused tests added and passing (`npx vitest run src/memories`). 2. `npx tsc -p tsconfig.json --noEmit` green. 3. `node scripts/check-gates.mjs` 0 violations. 4. Docs synced in the same task. 5. Ledger row Status=Fixed + evidence. 6. User review before commit.

# routes — audit plan (dom-routes)

## Phase status
- Phase 1 Inventory: DONE (inventory.md).
- Phase 2 Contracts: DONE (contracts.md, one row per route module/op-group).
- Phase 3 Ledger: DONE (bug-ledger.csv; carried + new findings with file:line evidence).
- Phase 4 Test baseline: DONE — tsc exit 0; vitest src/routes 3 files/14 tests pass;
  check-gates FAIL at baseline with 4 violations in threads/thread-service.ts (outside routes scope;
  pre-existing in working tree, recorded in RISKS_OR_GAPS, not touched per scope rule).

## Approved small fixes (implement only after user review)
Candidates ranked by blast radius (route-only, no gate/contract change):
1. RTE-002/RTE-003 (safety.ts tenant binding) — route-only guard mirroring artifacts.ts ART-4 fix.
2. RTE-005 (threads POST messages zod schema) — route-only; THR-022.
3. RTE-013 (search.ts filter-before-limit) — route-only SQL predicate.
4. RTE-006 (metrics admin gate parity) — route-only; OBS-012.
5. RTE-017 (filesystem unsafe-path → 400) — route-only mapping; FS-007.

NOT in scope this task: RTE-010/011 (cross-domain gate ports), RTE-015/016 (scheduler/worker),
RTE-018 (channels service signature), RTE-009 (transactional coupling).

## Docs sync (AGENTS.md §6) — REQUIRED when fixes land
- Route behavior change → re-docs/Backend Docs/Feature and Flow Spec doc for that flow
  (e.g. Threads and sub-conversations.md for RTE-005; Channels and archive.md for RTE-018 later).
- Gate shape unchanged by all candidate fixes → Domain Spec Ports rows unchanged.
- re-docs/Backend Docs/_index.md "Routes | — | uncovered" row may be updated to point at
  audit/domains/routes/ once the facade decision (no gate) is confirmed by the user.

## Next action
User review of ledger; then implement approved fixes + same-task doc updates + scoped vitest/tsc/check-gates.

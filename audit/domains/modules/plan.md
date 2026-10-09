# Modules Domain — Rewrite Decision + Fix Plan (Phase 4)

## Architecture verdict (A-E)
- A. Boundary/facade: PASS. Single gate, thin, all 11 external importers route through it (only allowlisted TEST-ONLY bypasses).
- B. Tier correctness: PASS with caveats. Local/PG parity is deliberate and mostly symmetric; listAll pagination parity verified by tests.
- C. Guard correctness: PARTIAL. Route+service double guard is sound for single-workspace; under-counts >200 blockers and excludes archived agents (M-05); FK cascade now exists making the guard safety-critical (M-02).
- D. Cache coherence: PARTIAL. listAll pre-write invalidation acceptable; runtime cache whole-clear is coarse (documented gap); shared-object cache returns (M-13).
- E. Test coverage: WEAK. All tests are local-tier; zero route tests, zero connection-test tests, no PG-tier tests.

## Rewrite decision: INCREMENTAL (preferred)
No rewrite. The domain is cohesive (815-LOC service, 264-LOC store, thin gate) and its contract is stable. Recommended: incremental hardening in the order below. A rewrite would risk the dual-tier parity and the carefully-commented cycle-avoidance (dynamic imports) that tests do not fully cover.

## Ordered fix plan
1. (S2, docs+code) M-02: correct the FK/cascade comment; decide guard-in-transaction. Docs sync in same task (AGENTS.md §6).
2. (S2, code) M-05: parameterize blocker scan limit / include archived handling decision; add T-3 integration test.
3. (S2, code) M-01: implement explicit custom-provider verdict + T-4 test.
4. (S2, code) M-03/M-04: thread workspaceId into cost-ledger and librarian unscoped gets.
5. (S2, tests) M-07 + T-1/T-2: fix misleading test name; add route + connection-test suites.
6. (S3, code) M-06: replace ciphertext probe fallback with explicit error; M-13 copy-on-read.
7. (S3, cleanup) M-10 narrow VITEST exemption; M-09 alias collapse deferred to a gate-major pass.
8. (S3, docs) M-08 working-tree commit decision (user); M-11 verify-or-delete INVALID_WORKSPACE branch; M-12 correct sync claim in docs.

## Constraints honored
- Read-only: no production edits made. Only audit/domains/modules/ files written (plus removal of one stray vitest log I created in packages/server/).
- No branch created (main only); no commits. Working tree unchanged except audit/ additions.
- Docs (re-docs Domain Spec/Modules.md, Feature and Flow Spec) noted, NOT updated — docs sync deliberately deferred to the fix tasks per §6 (drift recorded here and in ledger).

## Baseline (exact commands + results)
- npx tsc -p tsconfig.json --noEmit (cwd packages/server) -> EXIT 2. Only error: src/memories/memory-retrieval.ts(168,41) TS2559 (outside domain). Zero modules errors.
- npx vitest run src/modules/module-local-mode.test.ts (cwd packages/server) -> EXIT 0. 1 file, 10/10 passed (12.13s), vitest v4.1.7. Log: _vitest-run.log.
- node scripts/check-gates.mjs (cwd packages/server) -> EXIT 0. 1 modules finding (TEST-ONLY allowlist): module-local-mode.test.ts -> ../agents/agent-local-store.js. NOTE: the user-provided command path scripts/check-gates.mjs does not exist at repo root; actual path is packages/server/scripts/check-gates.mjs.

## Unknowns (Low confidence, time-boxed)
- M-11 reachability of INVALID_WORKSPACE (not re-verified against workspace-registry).
- PG-tier integration behavior (T-3) untested in this audit; no DB run.
- Whether runtimePatchable is enforced anywhere (doc's own open gap; not traced to completion).
- Stored custom-provider endpoint semantics (override vs fallback) beyond pass-through.

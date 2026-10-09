# Approvals Domain — Phase 4 Test Gaps (gaps only; no new tests written)

Baseline (exact): `cd packages/server && npx vitest run src/approvals` → **2 files skipped, 10 tests skipped, 0 executed** (no `DATABASE_URL`; both integration files probe-and-skip). `npx tsc -p tsconfig.json --noEmit` → clean. `node scripts/check-gates.mjs` → 0 violations, 46 test-only findings (12 approvals), 2 approvals allowlist entries. No unit-test file exists for this domain — everything is DB-gated integration.

| # | Gap | Related ledger ID | Why it matters | Suggested coverage |
| - | --- | ----------------- | -------------- | ------------------ |
| TG-01 | No always-running unit tests: all 10 tests skip without DB | all | CI without DATABASE_URL exercises zero approval logic; regressions land green | Pure unit tests for types.ts (mapRisk matrix, scope hash, preview truncation) with no DB |
| TG-02 | No test for global-fallback grant reuse across different requestedBy as a FAILURE case (current test asserts not-null and accepts both outcomes) | AP-002 | Permissions widening untested as contract | Assert strict per-requester miss (or document fallback as intended) |
| TG-03 | No test for `scope:'reusable'` sentinel semantics (assignment skip + expiry extension) | AP-001/AP-005 | UI's grant-for-session path unverified | Unit/integration: decide with sentinel on null-scope row; then findReusableGrant miss |
| TG-04 | No test for sweepOnce fan-out in single-DB mode (no workspace DB records) | AP-003 | Sweeper may be a no-op in default deployment | Integration: registry without databaseUrl → sweepOnce still expires global-DB rows |
| TG-05 | No test for POST /api/approvals/sweep run-resume | AP-004 | Route documented as not resuming; stuck-run risk unverified | Route test: waiting run + expired row → run resumed + emit |
| TG-06 | No socket tests for approval:decide tenant scoping | AP-009 | Split-DB decide silently fails | Socket test with two workspace DBs |
| TG-07 | No concurrency test: two sweepOnce concurrently | AP-016 | Duplicate emits / double resume assumptions | Two concurrent sweeps → one expiry, one resume per row |
| TG-08 | No test for null expiresAt pending row never swept | AP-008 | Un-expirable row behavior unverified | Unit: create expiresAt:null → sweep count 0, row pending |
| TG-09 | No test for emitDecided when broker.emit throws | INV-8 | Silent swallow undocumented at runtime | Unit: throwing broker → no propagation, no log (or assert warn) |
| TG-10 | No client-side test for ApprovalCard 'Grant for session' wire format | AP-001 | UI contract vs server sentinel | Component test asserting body sent; contract test server-side |
| TG-11 | No test for approve→executor fast-path broker event id parsing (envelope payload.approvalId) | INV-8 | Historically broken (comment tool-executor.ts:123-127); no regression guard | Unit: handler with envelope shape resolves correct id; mismatched id ignored |
| TG-12 | No test for routes/safety.ts grants endpoints (dead but would bypass gate if registered) | AP-015 | Latent bypass surface | If kept: gate routing + auth tests; else deletion test (import graph) |
| TG-13 | check-events not run in this audit (time-box) — approval.requested/decided classification untested here | — | Event-surface guard unverified for approvals (Low confidence) | Run `node scripts/check-events.mjs`; add to CI matrix |
| TG-14 | No test that expiry sets decidedBy (Target says system value, never null) | AP-007 | Doc-vs-code contract | Unit: expired row decidedBy value |

Note: gaps are recorded, not implemented (read-only audit; per instructions Phase 4 = run tests, record failures, gaps only).

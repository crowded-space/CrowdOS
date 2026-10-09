# Artifacts Domain — Test Gaps (Phase 4)
> No new tests written (audit-only). Baseline recorded below.

## Baseline (executed 2026-10-06)
- npx vitest run src/artifacts/artifacts-gate.test.ts (cwd packages/server): exit 0 — 1 file skipped, 4 tests skipped (no DATABASE_URL in env; probeDb skips). Output: "Test Files 1 skipped (1) / Tests 4 skipped (4)".
- npx tsc -p tsconfig.json --noEmit (cwd packages/server): exit 0, no output.
- node scripts/check-gates.mjs (cwd packages/server): exit 0 — 361 files, 23 domains, 0 violations; 46 test-only findings incl. artifacts-gate.test.ts -> runs-repository.js, coding-runtime.js, provider-registry.js (non-fatal).
- Git: working tree was already dirty before audit (pre-existing modifications across packages); audit adds only audit/ files; no branch created; no commits.

## Gaps (no coverage found)
| ID | Gap | Related ledger |
| -- | --- | -------------- |
| TG-1 | No unit test for listByRun/listByWorkspace clamps and 500-char truncation semantics | ART-1, I5 |
| TG-2 | No test that client apply uses a full body (regression guard for ART-1) | ART-1 |
| TG-3 | No test that retention sweep is wired to the queue handler | ART-3 |
| TG-4 | No test for writeArtifactFile failure fallback (path semantics) | ART-8 |
| TG-5 | No test for runId path traversal rejection | ART-7 |
| TG-6 | No test for emit payload shape (or that casts match BrokerEventMap) | ART-13 |
| TG-7 | No test for purge batching/idempotency | ART-5, ART-6 |
| TG-8 | No route test for workspaceId binding | ART-4 |
| TG-9 | No tenant-routing test for socket-run artifact creation | ART-2 |
| TG-10 | Integration tests all skip in CI without DATABASE_URL | ART-14 |

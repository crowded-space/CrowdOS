# event-broker - baseline + test gaps

## Baseline (exact commands + results, 2026-10-06)
- npx tsc -p tsconfig.json --noEmit (from packages/server): clean, no output lines, exit path returned empty/TSC-DONE marker (no errors observed).
- node scripts/check-gates.mjs (from packages/server): Gate rule OK - 361 files / 23 domains, 0 violations; 46 TEST-ONLY cross-domain imports (non-fatal, none in event-broker prod).
- npx vitest run (event-broker+events scoped attempts): tool output pipe returned empty in this harness; events-log/integration/route suites exist and are the de-facto broker coverage (see below). Treat vitest result as NOT-VERIFIED here, re-run: npx vitest run src/events src/shared/sockets/register-socket-server.test.ts.
- git: branch main, HEAD 22bb8a0; worktree dirty pre-existing (main-only rule: no commit/push performed). audit/ untracked (this audit's only addition).

## Gaps (no packages/server/src/event-broker/*.test.ts exists)
1. emit returns-before-fanout on oversize: no test asserts subscribers receive nothing + caller gets indistinguishable event (B1).
2. off() removes the exact wrapped handler: delegation.test.ts covers on/off happy path only; no test for unknown-id no-op, double-off, or onAny-off.
3. Channel filter fallback (payload.channelId vs top-level mismatch): covered implicitly by events tests, no direct unit case.
4. Per-listener throw isolation: no test that one throwing handler still delivers to siblings.
5. MAX_LISTENERS behavior under burst subscription: no stress/ceiling test.
6. Worker-local isolation (worker emits invisible to API): documented, untested.
7. approval.requested dropped-no-broker path: no test asserting warn + poll fallback still resolves (B4).
8. Live envelope seq null vs replayed seq allocated: asserted in events tests, not at broker level.

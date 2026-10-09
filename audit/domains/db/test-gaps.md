# dom-db — PHASE 4 TEST BASELINE + GAPS

## Baseline (2026-10-07, this checkout)
- npx vitest run src/db (packages/server): 1 file skipped, 2 tests skipped, exit 0. Reason: no DATABASE_URL (no packages/server/.env; root .env defines none).
- npx tsc -p tsconfig.json --noEmit (packages/server): exit 0 (clean).
- node scripts/check-gates.mjs (packages/server): EXIT 1 — 4 pre-existing violations, all in threads/thread-service.ts importing channels/channel-local-store + messages/message-local-store. Not db-scoped; recorded, not touched.
- No e2e coverage of db scripts. audit/domains/db did not exist before this task.

## Gaps
1. DB-010: no executing tests for db scripts locally; concurrency test gated on real DB.
2. No tests at all for: seed idempotency, bootstrap legacy path, check.ts roundtrip, backfill-encrypt-secrets (incl. no-key path), create-workspace-crowdos exit behavior.
3. No fresh-DB migrate smoke in local scripts (CI has it; desktop fork depends on it).
4. No schema/migration consistency check (journal vs files vs snapshots — DB-005).


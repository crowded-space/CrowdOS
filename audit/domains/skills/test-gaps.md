# Skills Domain — Test Gaps (Phase 4: gaps only; no new tests written)

Baseline: `npx vitest run src/skills/markdown-skills.test.ts src/skills/skill-service.test.ts` → 2 files, 37 tests, all pass. `npx tsc -p tsconfig.json --noEmit` → exit 0. `node scripts/check-gates.mjs` → 0 violations (46 test-only warnings repo-wide, none in skills).

Gaps (untested behavior):
1. routes/skills.ts has no tests — no coverage of 400/404/500 mapping, FK 23503→404 attach/detach, 201/204 statuses, or workspace:sync emission.
2. routes/studio.ts manifest skill path untested — including the SK-001 partial-failure (delete committed, insert fails) and cache invalidation skip.
3. No real-Postgres integration tests for the DB half — skill-service.test.ts is a scripted in-memory fake; migration 0022 columns, cascades, FK behavior, and jsonb defaults are never exercised against PG.
4. No ALS/dbScopeKey cross-scope cache tests for skills — database.test.ts covers scope keys for agents only; SK-003 staleness path unverified.
5. No split-DB/tenant test for tool authorization — SK-002 (executor ambient read) has no fixture.
6. No gate contract test — nothing pins skillsGate export surface to the Domain Spec Ports list (docs require equality).
7. No middleware test for triggerless Markdown skills (SK-006 docblock behavior) — discovery-context.test.ts covers triggered deferral/expansion; the no-trigger branch is unpinned. (Low confidence: only first 80 lines of that test read.)
8. No tests for SK-009 (concurrent update), SK-010 (limit NaN), SK-011 (compose total cap), SK-012 (enabled token).
9. No route test for local-mode guard interplay (/api/skills 501 vs 200-empty) at the skills level.
10. No test that studio/agent/module invalidators keep the two caches consistent for the same agent across scopes.


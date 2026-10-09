# Modules Domain — Test Gaps (Phase 4)

Existing suite: module-local-mode.test.ts (10 tests, all local-tier). Cross-domain tests touching modules: swarm.e2e.test.ts (gate mock), context-model-routing.test.ts (local-store fixtures).

## Gaps

| # | Gap | Risk | Suggested test |
|---|---|---|---|
| T-1 | No route-level tests for routes/modules.ts (404/409/redaction/workspace:sync/304). | Medium | Fastify inject suite: scoped delete 409 names blocker; read redacts apiKey; mutation emits workspace:sync; list pagination passthrough. |
| T-2 | testConnectionHelper has zero direct tests (offline/timeout/unknown/HTTP-error/no-key branches). | Medium | Unit tests with mocked fetch: AbortError -> offline:true; ENOTFOUND -> offline:true; unknown provider -> no fetch call; 401 -> success:false with message. |
| T-3 | PG-tier service branches (assertNoPgBlockers unscoped plural, cache key, FK behavior) untested. | High | Integration test with test DB: two workspaces, agent in B references A's module -> A delete blocked; >200 agents case (M-05). |
| T-4 | M-01 (custom provider can never pass a test) has no test locking current or desired behavior. | Medium | Assert desired verdict for custom; then implement. |
| T-5 | validateReferences local path: empty-string FK hole (M-9) untested; null/undefined matrix partially covered by agent tests only. | Low | Table test: "" / null / undefined / valid id for each of the five FKs, both tiers. |
| T-6 | listAllModules TTL cache: 10s expiry, 200-key bound, clear-on-mutation (pre-write) not directly asserted. | Medium | Fake-timer test: cache hit within TTL; mutation clears; workspace key separation. |
| T-7 | ensureDefaults idempotency (second call no-op) and seeded row shape (label/base/runtimePatchable) untested; only unscoped no-op is. | Low | Scoped local-tier test calling twice, asserting single row. |
| T-8 | Model update/delete runtime cache invalidation (dynamic runtime-gate import) untested at the seam. | Low | Spy on runtimeGate.invalidateModelModuleCache via module mock; assert called on update/delete, not on instruction ops. |
| T-9 | Local store: deleteFromFile unscoped branch (line 135-141) partially covered; corrupt-file guard for delete covered; non-array JSON (object) case not covered (only garbage string). | Low | Write "{}" and assert MODULE_STORE_CORRUPT on upsert/delete. |
| T-10 | serializeRow/revive round-trip across all five kinds (Date<->ISO) untested beyond model. | Low | Parametrized round-trip per kind. |
| T-11 | testModelModule decrypt-failure fallback (M-06) untested. | Low | Seed plaintext apiKey in local file; assert no throw + warning path. |
| T-12 | 304/maybeSend304 behavior on module reads untested. | Low | Inject with If-None-Match after first read. |

## Confidence notes
- Time-boxed: T-3..T-6 risks assessed by code trace only; no PG integration run performed (no DATABASE_URL assumed available).
- All 10 existing tests pass on the dirty working tree (see inventory baseline).

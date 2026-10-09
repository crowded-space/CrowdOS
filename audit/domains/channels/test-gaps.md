# Channels Domain — Phase 4 Baseline + Test Gaps (2026-10-06)

## Baseline (commands + exact results)

| Command (cwd packages/server) | Result |
| --- | --- |
| `npx vitest run src/channels/channel-local-mode.test.ts src/channels/channel-settings.test.ts` | 2 files passed, 13 tests passed, exit 0 |
| `npx vitest run src/channel-mounts/channel-mount-gate.test.ts src/routes/index.test.ts src/shared/core/workspace-sync.test.ts` | 3 files passed, 61 tests passed, exit 0 |
| `npx vitest run src/runtime/local-chat-e2e.test.ts src/events/events-integration.test.ts` | 2 FAILED / 1 passed — both failures are the pre-existing unrelated runtime issue ("Agent default-assistant has no model module"); they consume channelGate.create but the failure is in runtime model-module resolution |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `node scripts/check-gates.mjs` | exit 0; 0 violations; 46 test-only cross-gate findings; 3 allowlisted (one = routes/workspace.ts -> channels/channel-local-store.js) |

No new tests written (per instructions). No production edits. Git unchanged except this audit folder.

## Gaps (no test exists today)

1. **PG tier**: every in-domain test runs with DATABASE_URL unset. No test covers the `db`-override paths (dup guards, settings pinning, tenant scoping) that production routes use when a tenant DB is attached.
2. **Rename duplicate guard** (CHN-001): no test asserts a rename collision is rejected — because it is not.
3. **Case-variant duplicates** (CHN-002): only the local lowercase scan is exercised; the PG eq(name, lower(name)) asymmetry is untested.
4. **Archived-then-recreate** (CHN-003/CHN-033): no test pins the intended behavior or the PG phantom-insert.
5. **Route error mapping** (CHN-004/005/006b): no test asserts distinct 400 bodies for duplicate_name vs category vs missing workspace; no route-level test file for /api/channels or /api/categories at all.
6. **Cross-workspace parent category** (CHN-007): local-mode tests cover ws-scoped lists and dup guards but never a category of ws B used from ws A.
7. **Settings outage behavior** (CHN-008/009/032): no failure-injection test asserting outbox/absence of divergence for settings.
8. **Settings scope fallback** (CHN-010/011/012): the "ch-orphan -> default" behavior is pinned, but no test covers a lookup failure or unknown-channel 404 expectation.
9. **Merged pagination >200/tier** (CHN-014): no cursor-walk test in merged mode.
10. **Nested archived channels** (CHN-015): no parity test between /api/categories nested lists and /api/channels.
11. **Update/delete tenant scope** (CHN-016): no cross-workspace update/delete tests.
12. **fsMounts validator coherence** (CHN-017): no per-level mode tests (channel/category reject mode:"default" only via mount service).
13. **#general rename-then-delete** (CHN-028): only the direct-delete conflict is tested.
14. **Concurrency**: no test for concurrent category/channel creates (local TOCTOU CHN-006, DB constraint CHN-025).
15. **Local cascade completeness** (CHN-019/CHN-031): cascade test asserts channels gone but not settings/logs cleanup.
16. **Sockets settings scoping** (CHN-024): no test asserts getSettings is called with the channel's workspace scope.

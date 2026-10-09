# Threads Domain — Phase 4 Test Baseline + Gaps (read-only audit, 2026-10-06)

## Baseline runs (exact commands + results)

| Command | Result | Notes |
| --- | --- | --- |
| `npx tsc -p packages/server/tsconfig.json --noEmit` | exit 0, no output | Server typecheck clean (unused imports NOT flagged: no `noUnusedLocals`). |
| `npm run lint:gates --workspace @crowdspace/server` | exit 0 | Gate rule OK (361 files, 0 violations); Redaction OK; check-events OK. Threads domain has no gate violations. |
| `npx vitest run packages/server/src/routes/index.test.ts` | 1 file passed, 1 test passed (5.74s) | Route-registration guard exists but pins ChannelMounts only — threads not covered (that is exactly how THR-001 slipped through). |
| `npx vitest run packages/server/src/messages/message-pagination.test.ts packages/server/src/auth-gate-mount.test.ts packages/server/src/routes/index.test.ts` | 2 files passed, 1 skipped; 10 passed, 5 skipped (7.91s) | Nearest-neighbor suites (messages pagination + auth mount) all green. |
| `npx vitest run --config audit/domains/threads/probe/vitest.probe.config.ts` | 1 file passed, 2 tests passed (7.65s) | AUDIT-ONLY probe (not production): registerRoutes mounts 0/8 thread endpoints; threadRoutes mounts 8/8. Confirms THR-001. |
| Repo-wide grep over 129 test/spec files for `threadGate|thread-gate|thread-service|threadRoutes` | 0 matches | **Zero** automated coverage of this domain. |

There are no failing tests today — because there are no thread tests at all. Nothing in CI would catch THR-001..THR-031.

## Coverage gaps (ordered by risk)

### 1. Route registration / contract tests (blocks everything)
- Pin all 8 endpoints on the REAL `registerRoutes` entrypoint (same pattern as the ChannelMounts guard in routes/index.test.ts:7-36). Required for: THR-001.
- HTTP contract tests per endpoint: status codes (201/200/400/404/409), response shapes ({threads}/{messages}/{archived}), and the create `created:false` path (THR-031).

### 2. Service unit tests (characterization first)
- `createThread`: channel missing; parent missing; parent in another channel; parent already anchored (sequential dedupe); ttlHours=0/negative; isEphemeral=false; TTL boundary (expiresAt null vs set). (THR-028, I5, I7)
- `updateThread`: title-only; status-only; illegal transitions; archivedAt stamping rules; notFound. (THR-006, THR-014)
- `deleteThread`: notFound; cascade of thread_sequences; documented behavior with replies. (THR-005)
- `listThreads`: status filter; limit clamps (0, 1, 200, 201); keyset cursor roundtrip; malformed cursor; legacy numeric cursor; tie-break stability on equal lastActivityAt. (THR-012, THR-013, THR-030)
- `getThreadMessages`: empty thread; single page; multi-page roundtrip; malformed `before`; nextCursor exactness; ordering under equal timestamps. (THR-011, I16-I17)
- `archiveExpiredThreads`: only expired actives flip; idempotent second run; threads with null expiresAt untouched. (I4, I23)
- `incrementThreadMessageCount`: active increments; archived/expired no-op; missing id no-op. (I14)

### 3. Invariant / property tests
- I2/I3: after ANY update transition, (status in {archived,expired} => archivedAt != null) and no silent resurrection with stale expiresAt. (THR-006, THR-014)
- I7: two concurrent creates on one parent => exactly one thread row (needs PG integration or mock-level serialization test). (THR-004)
- I14: messageCount equals count(messages where thread_id) after N appends incl. failure injection between append and increment. (THR-010, THR-017)
- I12/I13: thread seq and channel seq never collide in the unique index; assert the chosen fix keeps both rows. (THR-002)

### 4. Adapter / persistence tests
- Migration tests for THR-002 (thread-aware unique index) and THR-004 (partial unique on parent_message_id), including upgrade of existing data (any duplicate parent_message_id rows must be handled before index creation).
- messages.thread_id FK rule test (cascade/set-null/restrict) once THR-005 is decided.
- EXPLAIN/perf assertion for the list query index (THR-020).

### 5. Auth / tenancy / isolation tests
- Two-workspace isolation: same-shaped ids, assert no cross-read via threadGate with explicit workspace context (THR-025).
- Sweep authorization: without token => 401/403; with token => 200 (THR-008).
- Author forgery: forged authorId rejected or explicitly documented as trusted (THR-023).

### 6. Failure injection / concurrency
- Kill/fail between append and incrementCount; assert counter repair path (THR-010).
- Concurrent PATCH vs DELETE on the same thread (THR-009).
- Sweep concurrency: two sweeps in parallel => same final state, no double-stamp (I23).

### 7. Regression tests for each confirmed bug
- THR-001 registration; THR-002 replica collision; THR-005 delete orphans; THR-006 illegal transitions; THR-007 expiry job flips; THR-009 update-undefined; THR-011/012 malformed cursors; THR-022 non-string content -> 400.

### 8. Contract tests (wire compatibility)
- Cursor codec roundtrip tests for both formats + a pinned test that the legacy numeric list cursor is still accepted (compat promise).
- Route response snapshot test so a future refactor cannot silently change {threads}/{messages}/{archived} shapes (AGENTS §10).

## Characterization needs before ANY refactor

1. Freeze current service return shapes (incl. the create `created:false` flag and `{ thread: undefined }` edge) with characterization tests BEFORE touching logic.
2. Freeze cursor parsing behaviors (lenient) so behavior changes are deliberate and documented.
3. Freeze the 404/409/400 route mapping (requires mounting routes first — THR-001).

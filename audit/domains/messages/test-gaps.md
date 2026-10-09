# Messages Domain - Phase 4 Test Baseline and Gaps (read-only audit, 2026-10-06)

## Baseline (exact commands and results)

All commands run from packages/server unless noted. No code was modified to make tests pass.

| Command | Result | Notes |
| --- | --- | --- |
| npx tsc -p tsconfig.json --noEmit (typecheck) | PASS (exit 0) | 28s |
| npx vitest run src/messages/message-pagination.test.ts | 1 file SKIPPED, 5 tests SKIPPED, exit 0 | describe.skipIf(!DATABASE_URL); packages/server/.env missing and process DATABASE_URL unset, so the whole file self-skips. This is the ONLY in-domain test file. |
| npx vitest run src/channels/channel-local-mode.test.ts | 1 file PASSED, 6 tests passed | Exercises messageGate.append + getChannelMessagesPage on the local tier (this is the de-facto local-tier test for messages). |
| npx vitest run src/runtime/tool-call-round-trip.test.ts src/shared/core/workspace-sync.test.ts | PASSED (2 files; 16+ tests) | tool-call-round-trip pins the structured/legacy card merge via the fake DB. |
| npx vitest run src/runtime/runtimes/monologue-e2e.test.ts | 1 file PASSED, 1 test | |
| npx vitest run src/runtime/local-chat-e2e.test.ts | 1 file FAILED (1 test) | Failure is NOT in the messages domain: the runtime returns status failed because Agent default-assistant has no model module (log: trace.assemble error). Messages append/history assertions were not reached. |
| npx vitest run src/events/events-integration.test.ts | 1 file FAILED (1 test) | Same root cause (expected completed, got failed). The message:new counter listener also logged a DATABASE_URL error under the fake-broker path (register-socket-server.ts:464-471) - expected without PG, caught and logged. |
| node scripts/check-gates.mjs (lint:gates) | PASS, 0 violations | 46 non-fatal test-only cross-domain findings; none in messages. Note: shared/core imports messages/message-local-store directly but Shared is exempt (MSG-026). |
| node scripts/check-redaction.mjs / check-events.mjs | PASS | 0 redaction violations; events whitelist OK. |
| npx vitest run stores/messagePagination.test.ts (packages/client) | 1 file PASSED, 8 tests | Pins the newest-first envelope + cursor shape contract that the server read path must keep. |

Conclusion: the domain has NO passing in-domain test in the current environment; all real coverage of the domain comes from cross-domain suites (channel-local-mode, tool-call-round-trip) and one currently-failing runtime e2e whose failure is unrelated to messages.

## Gaps (report only - no new tests added this turn)

### 1. Characterization needs
- Merge engine: page-boundary pairing (MSG-004), duplicate monologue overwrite (MSG-027), unmatched legacy calls (MSG-028), multiple structured calls per row (MSG-016), lowercase/object tool errors (MSG-008).
- appendMessage happy path per tier (local only; dual with fake PG; tx/db override).
- Cursor lifecycle: first page, middle page, last page, exhausted, empty channel, malformed cursor (partially covered in the PG-only file).

### 2. Contract tests
- Returned row shape equals a re-read row for every field (MSG-003 authorLevel drift).
- message:new payload matches the declared event type (event-types.ts ChannelMessage vs actual DB row).
- Exactly one message:new per append, including the threads route path (MSG-009).
- Envelope shape stays messages newest-first + cursor (client test already pins consumer side; server side needs a pin).

### 3. Invariant tests
- INV-2/INV-8: no seq reissue within a tier; channel vs thread seq spaces never collide in the shared unique index (MSG-001).
- INV-5: caller-supplied id idempotency end-to-end (local + PG) (MSG-005).
- INV-16/INV-20: replica counter >= max after append and after outbox replay (MSG-020).
- INV-21: every page item conforms to the declared page-item type (MSG-017).

### 4. Auth / isolation tests
- REST read with x-workspace-id A against a channel owned by B -> 403/404 (MSG-007); both tiers.
- Local-tier scoping: two workspaces with same channel id do not leak (setLocalStoreDirForTests supports this today).
- Socket room cross-workspace join denial is already tested elsewhere; add a message-domain regression that append stamps the channel workspace.

### 5. Adapter tests
- Local store: append + page + cursor parity with the PG path (shape normalization: authorLevel string, timestamp ISO).
- Torn-tail: messages JSONL appends do NOT use repairTornTail (local-file.ts:461-467 vs events at :483-489) - a crash mid-append leaves a glued line that drops BOTH records; add a torn-tail test and decide whether messages should repair like events (MSG-031 candidate).
- Outbox replay: message entry replay repairs the counter (currently it does not - MSG-020).

### 6. Failure injection
- Replica failure -> outbox queued, event still emitted (documented contract), drain replays, counter repaired (MSG-018/020).
- Replica failure with a poison row -> drain drops it and logs (workspace-sync.ts:503-507); assert no infinite retry and no silent loss.

### 7. Concurrency / idempotency
- Parallel appends to one channel (local): distinct gap-free seqs under the file mutex.
- Same-id scheduler retry: one local row (MSG-005).
- Two-DB floor test (MSG-002/MSG-010).

### 8. Regression tests for confirmed bugs (from the ledger)
- MSG-001 thread+channel seq collision.
- MSG-002/MSG-010 workspace-handle floor/read.
- MSG-005 retry duplicate.
- MSG-006 listRecent ordering tiebreak.
- MSG-007 cross-workspace REST read.
- MSG-012 missing content.
- MSG-014 NaN limit.
- MSG-016 duplicate tool-card ids.
- MSG-020 outbox counter repair.

### 9. Harness limitations to fix while adding tests
- test-setup.ts fake DB ignores where() for messages.findMany (no keyset support) - either extend the fake or keep real-PG tests opt-in.
- message-pagination.test.ts is PG-only; the local-first default has no in-domain coverage.
- The domain has no factory/DI seam; appendMessage imports getDb/dynamic workspace-gate directly, so unit tests must use the global vi.mock pattern (see test-setup.ts) or the real local tier.
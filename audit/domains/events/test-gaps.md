# Events Domain — Test Gaps (Phase 4; gaps only, no new tests written)

Baseline (2026-10-06, cwd packages/server):
- `npx vitest run src/events` -> Test Files 1 failed | 2 passed (3); Tests 1 failed | 19 passed (20); Duration 70.98s. Failing: events-integration.test.ts:130 (EVT-09).
- `npx tsc -p tsconfig.json --noEmit` -> exit 0 (no output).
- `node scripts/check-gates.mjs` -> exit 0; 46 test-only cross-domain findings (3 in events-integration.test.ts = EVT-11).

## What is well covered today
- Append one line per event; seq 1..n; field shape (events-log.test.ts).
- Exclusive afterSeq, lastSeq=head when caught up, monotonic lastSeq.
- limit honored + clamped (store) and 201 -> 400 (route).
- Honest empty for absent log (store + route).
- Torn tail skipped; append survives after torn line; newline repaired on next append (e2e raw file check).
- §30 workspace isolation across two workspaces; independent seq spaces; per-workspace files.
- Hostile channel id path traversal blocked.
- Ephemeral message:stream never logged (store + route hook test); channel-less events skipped; payload-only channelId counted.
- Failed append does not throw (ENOTDIR blocker); stats.failed increments.
- Route: 401 non-loopback; 400 missing channelId; response key set pinned; wired-broker hook test.

## Gaps (ordered by risk)

G-01 (EVT-02, High) — No test that a conflicting payload.workspaceId cannot route a line into a foreign workspace. Missing case: channel row belongs to ws-A, payload says ws-B; assert the write scope (and read scope) stay ws-A (or an explicit rejection).
G-02 (EVT-03, Medium) — No test that GET /api/events/recent refuses a channel belonging to another workspace when x-workspace-id is set (today it cannot refuse — gap is behavioral, test would fail by design).
G-03 (EVT-06, High) — No test for counter-file reset mid-process (floor memo). Missing: record 3 events, overwrite event-sequences.json to {"ch":0}, record again; assert no duplicate seq.
G-04 (EVT-15, Medium) — No test for colliding sanitized channel ids ("a/b" vs "a?b"): assert no cross-row bleed and no duplicate seqs in the shared file.
G-05 (EVT-05, Medium) — No perf/regression test bounding read cost (full-file read + sort). Missing: large-log read asserting bounded bytes/time or a benchmark.
G-06 (EVT-10, Medium) — No test for recovery after a transient append failure (retry/outbox absent; the swallow is tested, the recovery is not).
G-07 (EVT-12, Low) — No duplicate-eventId test documenting the accepted duplicate-append behavior.
G-08 (EVT-16, Low) — No test for unknown/untyped event.type at the append boundary.
G-09 (EVT-04, Low) — No test for memo invalidation when a channel's owning workspace changes between calls.
G-10 (EVT-08, Low) — No metrics-surface test (eventLogStats not exported to /api/metrics).
G-11 (EVT-01, Low) — No gate-shape test (exact export list) to keep the facade minimal.
G-12 (EVT-09, High) — The failing e2e wiring test itself is the gap: it must go green (bind model module / fix seeding) so the "hook is actually wired" proof is enforced.
G-13 (EVT-11, Low) — events-integration.test.ts cross-domain test imports (3 findings) should be routed through gates when touched.
G-14 (Low) — No test pinning that worker.ts never registers an events hook (single-writer constraint guard).

## Coverage notes
- In-domain tests may import internals (events-log.test.ts imports event-classification.ts directly — allowed by AGENTS.md §2; cross-domain tests must use gates).
- No tests were added in this audit (READ-ONLY); all gap entries are for a follow-up implementation task.

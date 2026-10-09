# Events Domain — Inventory (READ-ONLY audit, Phases 1–4)

- Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd
- Domain: packages/server/src/events
- Facade: packages/server/src/events/events-gate.ts
- Commit: 22bb8a0 (branch: main). Working tree was ALREADY dirty before this audit (many M entries incl. packages/server/src/routes/index.ts, db/schema.ts); this audit added only untracked audit/ (git status: `?? audit/`). No production edits, no branch created, no commit.
- Date: 2026-10-06. All commands run from packages/server unless stated.

## 1. File inventory

| File | Purpose | Key exports |
|---|---|---|
| events-gate.ts | Domain facade. Imports services/stores/classification and re-exports. eventsGate object = {record, recordDetached, listRecent, headSeq, isEphemeral, stats} (events-gate.ts:47-54) | 16 value exports + 3 type exports (see contracts.md) |
| event-log-service.ts | The ONE append hook (recordBrokerEvent / recordBrokerEventDetached), listRecentEvents, eventLogStats, workspace memo | recordBrokerEvent:74, recordBrokerEventDetached:118, listRecentEvents:130, eventLogStats:34, resetEventLogStatsForTests:41 |
| event-local-store.ts | File truth: seq allocation, append, tail read, head | EVENT_SEQUENCES_FILE:42, DEFAULT_EVENT_PAGE_LIMIT:45, MAX_EVENT_PAGE_LIMIT:48, readEventRows:59, eventHeadSeq:68, allocateEventSeq:96, resetEventSeqFloorForTests:118, appendEventRecord:129, appendNextEvent:146, listEventTail:166, listEventRowsNewestFirst:193 |
| event-classification.ts | Pure classification: ephemeral set, channel/workspace/agentId resolvers, shouldLogEvent | EPHEMERAL_EVENT_TYPES:21, isEphemeralEventType:24, resolveEventChannelId:36, resolveEventWorkspaceId:45, resolveEventAgentId:51, shouldLogEvent:61 |
| event-log-types.ts | Record + options/result types (seq, eventId, type, payload, createdAt ISO, ts ms, channelId, workspaceId, agentId) | EventLogRecord, ListRecentEventsOptions, RecentEventsResult |
| events-log.test.ts | Store-level tests (real disk) | 9 tests (append/tail/limit/empty/torn/isolation/hostile id/ephemeral/failed-append) |
| events-route.test.ts | Route-level through buildServer (skipListen/skipTimers) | 9 tests incl. 401 non-loopback, 400 cap |
| events-integration.test.ts | E2E local turn through real broker; also broker-hook wiring | 2 tests; 1 FAILING at baseline (see below) |

Related (not owned, read for the audit):
- routes/events.ts:25 eventRoutes — GET /api/events/recent, zod schema (channelId min 1; afterSeq int >=0; limit int 1..200), calls eventsGate.listRecent (routes/events.ts:39).
- create-app.ts:365 — the single append hook: `eventBroker.onAny((event) => eventsGate.recordDetached(event))`; broker built + setSharedBroker just above.
- event-broker/event-broker.ts — transport; MAX_PAYLOAD_BYTES 256KB drop guard (event-broker.ts:24,51-53); dual emit type+"*" (60-61).
- shared/core/local-file.ts — gate-exempt shared IO: withStoreLock:270, safeChannelFileId:389, appendJsonlLine:402, terminateTornTail:420, readJsonlLines:438, appendEventJsonl:483, readEventJsonl:492.
- Client (HTTP only): packages/client/src/api/client.ts:403 getEventsRecent; stores/crowdOsStore.ts:894 fetchGapAndDigest, :876 persistSeq.
- Docs: re-docs/Backend Docs/Domain Spec/Events.md (present; cites create-app.ts:344 — drift, see EVT-13).

## 2. Dependency map (Caller -> Facade -> Service -> Port -> Adapter)

```
Caller                              Facade                Service                       Port/Store                     Adapter
create-app.ts:365 (broker.onAny) -> eventsGate.recordDetached -> recordBrokerEventDetached -> recordBrokerEvent -> appendNextEvent -> withStoreLock("eventlog:ws:ch")
                                                                                                       -> allocateEventSeq -> mutateJsonObject(event-sequences.json)
                                                                                                       -> appendEventRecord -> appendEventJsonl -> appendJsonlLine -> terminateTornTail -> node:fs
                                                                                                       -> workspaceOfChannel -> resolveWorkspaceIdForChannel / findWorkspaceIdForChannelLog (shared/local-file.ts, sync registry read + dir scan)
routes/events.ts:39 --------------> eventsGate.listRecent ------> listRecentEvents ------> workspaceOfChannel -> (same as above)
                                                                                    \-> listEventTail -> readEventRows -> readEventJsonl -> readJsonlLines -> node:fs
tests ----------------------------> eventsGate.* / reset*ForTests (in-domain), event-classification internals (in-domain test only)
```
- Gate-to-gate: events-gate imports ONLY types from event-broker-gate.ts (`BrokerEvent`, `BrokerEventType`). No cycles detected. No hidden globals except process-lifetime module state (see below).
- Process-lifetime module state (hidden globals, by design, tests reset them):
  - channelWorkspaceMemo (event-log-service.ts:49, cleared >5000 entries at :60)
  - flooredChannels (event-local-store.ts:84, reset via resetEventSeqFloorForTests:118)
  - eventLogStats counters (event-log-service.ts:34)
  - shared file locks chains (shared/core/local-file.ts:262) and folderCache TtlCache (local-file.ts:98)

## 3. Entry points
1. Boot append hook (only writer): create-app.ts:365. No producer call site appends directly (verified by grep: only importers are create-app.ts:32, routes/events.ts:3, in-domain tests).
2. HTTP read: GET /api/events/recent (routes/events.ts:27-53) behind the globally mounted auth gate (create-app.ts authGate.requireAuthMounted) — loopback trusted keylessly; non-loopback without key = 401 (route test asserts).
3. Tests import the gate and reset helpers.

## 4. Bypasses / boundary checks
- `node scripts/check-gates.mjs` -> exit 0: scanned 361 files / 23 domains, 0 violations; 46 TEST-ONLY cross-domain findings (3 belong to events-integration.test.ts, see EVT-11); 3 pre-existing allowlisted violations elsewhere (approvals/workspace) — none in Events.
- No file outside events/ imports past events-gate.ts (grep: create-app.ts:32, routes/events.ts:3 only).
- Gate bloat: the gate module re-exports 16 values but only 6 are needed by outside callers (eventsGate.*) + reset helpers for tests; allocateEventSeq / appendEventRecord / listEventRowsNewestFirst / headSeq / isEphemeral etc. are surplus public surface (EVT-01).

## 5. Persistence / infra
- Files (no DB, no migrations, no queues, no caches owned, no sockets owned):
  - <workspaceFolder>/vfs/.crowdos/events/<sanitizedChannelId>.jsonl (append-only, torn-tail tolerant)
  - <workspaceFolder>/vfs/.crowdos/event-sequences.json ({ "<channelId>": n })
- Tables/migrations: none. db/schema.ts untouched by this domain.
- Config/env read by this domain: none directly; shared/local-file.ts reads CROWDOS_LOCALSTORE_DIR / CROWDOS_WORKSPACE_REGISTRY_FILE / CROWDOS_DATA_DIR / WORKSPACE_DIR.
- Auth: no in-route auth; inherits mounted global gate + loopback trust. Tenant scope resolved by channel->workspace scan; x-workspace-id header is NOT consulted by the events route.
- Transactions: none; in-process promise-chain mutexes only (withStoreLock; per-file jsonl lock jsonl:<ws>:events:<id>; json lock json:<ws>:event-sequences.json).

## 6. Test inventory + baseline (Phase 4)
- Command: `npx vitest run src/events` (cwd packages/server)
- Result (2026-10-06): Test Files 1 failed | 2 passed (3); Tests 1 failed | 19 passed (20); Duration 70.98s.
  - FAIL events-integration.test.ts:130 — expected 'failed' to be 'completed' (root cause in log: "Agent default-assistant has no model module…"; the test registers a provider adapter but the default agent has no model module bound; also stderr "Failed to increment channel message count: DATABASE_URL is not set" is an expected local-mode degradation, not the assertion failure).
  - events-log.test.ts (9) and events-route.test.ts (9) passed.
- Command: `npx tsc -p tsconfig.json --noEmit` -> exit 0, no diagnostics (baseline-tsc.log empty).
- Command: `node scripts/check-gates.mjs` -> exit 0 (0 violations; 46 test-only findings; 3 allowlisted elsewhere).
- Raw logs: audit/domains/events/baseline-vitest.log, baseline-tsc.log.

## 7. Known gaps (detail in bug-ledger.csv / test-gaps.md)
- Payload workspaceId decides the write scope (EVT-02); read scope is channel-derived; no route-level tenant check (EVT-03); no negative memo (EVT-04); O(n) full-file reads, unbounded log (EVT-05); duplicate-seq window if counter reset mid-process (EVT-06); sanitized-id collisions share one file and the tail does not filter rows by channelId (EVT-15); no dedupe (EVT-12); append failures drop events with no outbox (EVT-10); stats not in /api/metrics (EVT-08); doc line-ref drift (EVT-13); integration test red (EVT-09); test-only gate violations (EVT-11).

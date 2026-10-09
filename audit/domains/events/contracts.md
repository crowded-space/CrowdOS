# Events Domain — Contracts (facade + per-operation matrix)

Facade file: packages/server/src/events/events-gate.ts. Contract = the module's export surface exactly as compiled (verified by reading the file; tsc --noEmit exit 0).

## 1. Exact export surface (events-gate.ts)

Value exports (re-exported from internals):

| Export | Source | Line |
|---|---|---|
| listRecentEvents | event-log-service.ts:130 | gate:3 |
| recordBrokerEvent | event-log-service.ts:74 | gate:4 |
| recordBrokerEventDetached | event-log-service.ts:118 | gate:5 |
| eventLogStats | event-log-service.ts:34 | gate:6 |
| resetEventLogStatsForTests | event-log-service.ts:41 | gate:7 |
| EPHEMERAL_EVENT_TYPES | event-classification.ts:21 | gate:11 |
| isEphemeralEventType | event-classification.ts:24 | gate:12 |
| resolveEventChannelId | event-classification.ts:36 | gate:13 |
| shouldLogEvent | event-classification.ts:61 | gate:14 |
| DEFAULT_EVENT_PAGE_LIMIT | event-local-store.ts:45 | gate:17 |
| MAX_EVENT_PAGE_LIMIT | event-local-store.ts:48 | gate:18 |
| allocateEventSeq | event-local-store.ts:96 | gate:19 |
| appendEventRecord | event-local-store.ts:129 | gate:20 |
| eventHeadSeq | event-local-store.ts:68 | gate:21 |
| listEventRowsNewestFirst | event-local-store.ts:193 | gate:22 |
| resetEventSeqFloorForTests | event-local-store.ts:118 | gate:23 |

Type exports: EventLogRecord, ListRecentEventsOptions, RecentEventsResult (gate:26).
Facade object: `eventsGate = { record, recordDetached, listRecent, headSeq, isEphemeral, stats }` (gate:47-54).

## 2. Per-operation contract matrix (one row per public method)

| Op | Signature | Preconditions | Validation | Result | Errors | Auth/tenant | Idempotency | Txn/consistency | Side effects / order | Events | Retry | Observability | Perf | Compat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recordBrokerEvent | (Pick<BrokerEvent,'eventId'|'type'|'channelId'|'payload'|'timestamp'>) => Promise<EventLogRecord|null> | none (hot path) | shouldLogEvent: not ephemeral AND channelId resolvable | record on success; null when skipped | never throws (catch -> stats.failed++, console.warn, null) | none; tenant = payload.workspaceId ?? channel lookup | NOT idempotent: same eventId twice = two lines, new seq (EVT-12) | allocate+append serialized per channel by withStoreLock("eventlog:<ws>:<ch>") — file order = seq order | write events/*.jsonl + event-sequences.json; console.warn on failure | none | none | stats.appended/skipped/failed + warn | 1 read (head) only on first seq for a channel+process (floor), then 2 file ops | payload stored verbatim; broker caps 256KB pre-fanout | record shape stable |
| recordBrokerEventDetached | same => void | broker onAny context | same | void; promise detached (void) | none (inner never rejects) | same | same | same | same | none | none | same counters | same | same |
| listRecentEvents | (channelId, {afterSeq?,limit?}={}, workspaceId?) => Promise<RecentEventsResult> | channelId non-empty | afterSeq: finite number else ignored; limit clamped 1..200 floor (clampLimit:51-54) | {events asc, lastSeq, headSeq} | throws only if file read fails non-ENOENT (readText rethrows) | tenant = explicit workspaceId ?? channel-derived; route passes NO explicit ws | read-only | rows sorted by seq defensively | none | none | none | O(file lines) read+scan+sort per call (EVT-05) | empty log = {[],0,0}; lastSeq=head when tail empty | stable |
| eventHeadSeq | (channelId, workspaceId?) => Promise<number> | — | skips non-finite seq | max seq or 0 | read errors propagate | same | read-only | — | none | none | — | O(n) | — | stable |
| allocateEventSeq | (channelId, workspaceId?) => Promise<number> | — | — | next seq (bump-first) | write errors propagate | — | NOT idempotent (each call bumps) | flooredChannels memo floors counter to file head once per process | mutate event-sequences.json | none | — | none | 1 head read (first time) + 1 RMW | — | stable |
| appendEventRecord | (record, workspaceId?) => Promise<EventLogRecord> | caller owns seq | — | same record | write errors propagate | scope = arg ?? record.workspaceId ?? null | not deduped | caller's responsibility | append line + torn-tail repair | none | — | none | append O(1) + repair read of last byte | — | stable |
| listEventRowsNewestFirst | (channelId, ws?) => Promise<EventLogRecord[]> | — | — | newest-first rows | read errors propagate | — | read-only | — | none | none | — | O(n log n) | unused by runtime (diagnostic) | stable |
| isEphemeralEventType | (string) => boolean | — | — | message:stream => true | — | — | pure | — | — | — | — | — | — | — |
| shouldLogEvent | ({type,channelId?,payload?}) => boolean | — | ephemeral first, then channelId top or payload | boolean | — | — | pure | — | — | — | — | — | — | — |
| resolveEventChannelId / resolveEventWorkspaceId / resolveEventAgentId | (event|payload) => string|null | — | string + trim check | trimmed id or null | — | — | pure | — | — | — | — | — | — | — |
| resetEventLogStatsForTests / resetEventSeqFloorForTests | () => void | test-only | — | zeroes counters / clears memo | — | — | — | — | — | — | — | — | — | — |
| eventsGate.* aliases | see object above | — | — | — | — | — | — | — | — | — | — | — | — | — |

## 3. Route contract (routes/events.ts)

- GET /api/events/recent?channelId=..&afterSeq=..&limit=..
- zod: channelId string min 1 (required, else 400); afterSeq coerce int >=0 optional; limit coerce int positive max 200 optional (201 -> 400).
- Response 200: { channelId, events: [{seq,eventId,type,agentId?,payload,createdAt}], lastSeq }. headSeq and workspaceId are NOT exposed by the route (store-only).
- Auth: mounted gate; non-loopback keyless = 401. Loopback = trusted. No tenant assertion in the route (EVT-03).

## 4. Boundary/consumer contracts

- BrokerEvent (type-only import from event-broker-gate.ts): record accepts Pick of {eventId,type,channelId,payload,timestamp}.
- Client consumer: client.ts:403 getEventsRecent(channelId, afterSeq, limit=100); crowdOsStore.ts:894 fetchGapAndDigest consumes {events[].seq,...} and persists per-channel high-water mark via persistSeq:876 (never lowers).
- No socket emit, no outbox, no DB — replay is pull-based HTTP by design.

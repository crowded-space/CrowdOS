# Events

## Purpose
Owns the §29 local event log: an append-only, per-channel, workspace-scoped JSONL history of non-ephemeral broker events, plus the `GET /api/events/recent` replay cursor that lets a reconnecting client recover what it missed. It is the durability half of the §28 `event → reducer → state` model, deliberately minus Postgres: the log is a local file, one line per event, and the broker remains the transport that feeds it.

## Feature Scope
In-scope:
 - Append-only event log at `<workspaceFolder>/vfs/.crowdos/events/<channelId>.jsonl` (one JSON record per line; canon 2026-09-22: inside the owning workspace folder).
- Per-channel monotonic `seq` allocation with its own counter file (`event-sequences.json`).
- Ephemeral-vs-durable classification of broker events.
- The single append hook: one `broker.onAny` subscriber registered at boot.
- Exclusive-`afterSeq` tail reads behind `GET /api/events/recent`.
- Torn-tail tolerance (a partially written line is skipped, never fatal).
Non-goals (other domains):
- Transport, fan-out, rooms, socket delivery → Sockets (`register-socket-server.ts`).
- The event contract itself (`BrokerEventMap`, `EventBroker.emit/on/onAny`) → EventBroker.
- Message history truth and message `sequenceNumber` allocation → Messages (`messageGate.append`, `messages/<channelId>.jsonl`).
- Run lifecycle and checkpoints → Runs; approvals → Approvals.
- Retention policy → not implemented anywhere; explicitly a non-goal of this change (see Decisions + Gaps).
 - Workspace registry / workspace-folder resolution → Workspace (`workspace-paths.ts`, `workspace-registry.ts`) + `shared/core/local-file.ts`.

## Expect
- [Observed] One line per logged event, in `events/<channelId>.jsonl`, appended under a per-file mutex (`shared/core/local-file.ts:appendEventJsonl`).
- [Observed] `seq` is monotonic per channel and allocated bump-first: the counter advances before the line lands, so a crash leaves a gap, never a duplicate (`event-local-store.ts:allocateEventSeq`).
- [Observed] `afterSeq` is exclusive: `seq > afterSeq` only (`event-local-store.ts:listEventTail`).
- [Observed] `lastSeq` is the highest seq *returned*; when the tail is empty it is the current head, so a caught-up client sees `events: []` + the head instead of re-polling forever (`event-local-store.ts:listEventTail`, `routes/events.ts`).
- [Observed] An absent or empty log answers `{ events: [], lastSeq: 0 }` — no fabricated event, no echoed cursor masquerading as history (`routes/events.ts`).
- [Observed] A torn trailing line is skipped by the reader and the next append repairs the missing newline first, so the torn fragment cannot swallow the record after it (`local-file.ts:terminateTornTail`).
- [Observed] `message:stream` is never written (`event-classification.ts:EPHEMERAL_EVENT_TYPES`), matching the retired `durable_events` classification verbatim.
- [Observed] Events with no channel id anywhere (global `runtime:snapshot`, workspace-scoped `workspace:sync`) are not logged (`event-classification.ts:shouldLogEvent`).
- [Observed] Appends are best-effort: a failing log warns and increments a counter, never throws into the emit path (`event-log-service.ts:recordBrokerEvent`).
- [Observed] `limit` clamps to 1..200 in the store and is capped at 200 by the route's zod schema — one number, two enforcement points that agree (`event-local-store.ts:MAX_EVENT_PAGE_LIMIT`).

## Flow
1. Boot: `buildServer` constructs the broker, registers it via `setSharedBroker`, and attaches ONE `onAny` subscriber — `eventBroker.onAny((event) => eventsGate.recordDetached(event))` (`create-app.ts:344`). This is the only append site in the process; no producer call site writes the log.
2. Emit: any producer calls `broker.emit(type, payload, { channelId })`. The broker envelopes and fans out (`event-broker.ts`).
3. Classify: the subscriber asks `shouldLogEvent` — ephemeral keys are rejected, then a channel id is resolved from the top-level `channelId` or the payload's `channelId` (`event-classification.ts`). No channel id ⇒ skipped, counted, done.
4. Append: `appendNextEvent` holds the per-channel `eventlog:<channelId>` lock across allocate + append, so file order matches seq order (`event-local-store.ts`). The record carries `seq`, `eventId`, `type`, `payload`, `createdAt` (ISO), `ts` (epoch ms), `channelId`, `workspaceId`, `agentId`.
5. Read: `GET /api/events/recent?channelId&afterSeq&limit` validates query shape, reads the tail, and maps each record to the client contract `{ seq, eventId, type, agentId?, payload, createdAt }` plus `{ channelId, lastSeq }` (`routes/events.ts`).
6. Client catch-up (UX-5): on reconnect the store reads its per-channel seq cursor and calls `fetchGapAndDigest(channelId, afterSeq)`; it persists each returned seq, dedupes `message:new` payloads into `messages` by id, and composes the "While you were away" digest from `run.status_changed` + `message:new` (`crowdOsStore.ts:589-648`).
7. Channel switch also gap-fetches on entry when a cursor exists (`crowdOsStore.ts:2483-2488`).

## Current Implementation
- `events/event-log-types.ts` → `EventLogRecord` (one JSONL line), `ListRecentEventsOptions`, `RecentEventsResult` (`{ events, lastSeq, headSeq }`).
- `events/event-local-store.ts` → file truth. `EVENT_SEQUENCES_FILE` (`event-sequences.json`), `DEFAULT_EVENT_PAGE_LIMIT` (100), `MAX_EVENT_PAGE_LIMIT` (200), `readEventRows`, `eventHeadSeq`, `allocateEventSeq` (+ per-process floor memo, `resetEventSeqFloorForTests`), `appendEventRecord`, `appendNextEvent` (locked allocate+append), `listEventTail`, `listEventRowsNewestFirst`.
- `events/event-classification.ts` → `EPHEMERAL_EVENT_TYPES` (`message:stream`), `isEphemeralEventType`, `resolveEventChannelId`, `resolveEventWorkspaceId`, `resolveEventAgentId`, `shouldLogEvent`.
- `events/event-log-service.ts` → `recordBrokerEvent` (best-effort append, returns the record or null), `recordBrokerEventDetached`, `listRecentEvents`, `eventLogStats` (`appended`/`skipped`/`failed`) + `resetEventLogStatsForTests`.
- `events/events-gate.ts` → re-export + `eventsGate` (`record`, `recordDetached`, `listRecent`, `headSeq`, `isEphemeral`, `stats`).
- `shared/core/local-file.ts` → `appendEventJsonl` / `readEventJsonl` + the shared `appendJsonlLine` / `readJsonlLines` / `terminateTornTail` / `safeChannelFileId` helpers the message log now also rides on.
- `routes/events.ts` → the replay route (was a documented no-op returning `{ events: [], lastSeq: afterSeq ?? 0, deprecated: true }` before this change).

### Log layout
```
<workspaceFolder>/vfs/.crowdos/
  events/<channelId>.jsonl        # one JSON record per line, append-only
  event-sequences.json            # { "<channelId>": <lastSeq> }
  messages/<channelId>.jsonl      # message history (Messages owns this)
  sequences.json                  # { "ch:<id>": n, "thread:<id>": n } (Messages)
```
Canon 2026-09-22: the log lives inside the OWNING workspace's folder, so two workspaces never share a log file — the folder boundary IS the tenant boundary. `<workspaceFolder>` = the registry `rootPath`, else `<sandboxBase>/<folderName>`. `CROWDOS_LOCALSTORE_DIR` still overrides the whole store outright (dev/CI escape hatch). Channel ids are sanitized to `[A-Za-z0-9_-]` for the file name, so a hostile id cannot escape `events/`.

### Record shape
```json
{"seq":1,"eventId":"<uuid>","type":"message:new","payload":{...},"createdAt":"2026-09-21T02:31:00.000Z","ts":1758421860000,"channelId":"ch-1","workspaceId":"ws-1","agentId":"agent-1"}
```
`workspaceId`/`agentId` are null when the payload does not carry them.

### Seq semantics (read before using `afterSeq`)
- The event `seq` is its **own** per-channel monotonic space. It is deliberately NOT the message `sequenceNumber` space: messages already own `sequences.json` keys `ch:<id>`/`thread:<id>`, and a second writer on that counter would make message seqs sparse. The event log uses `event-sequences.json` keyed by channel id.
- Because a channel emits several events per message, the event space advances at least as fast as the message space. The client keeps ONE `channelSeq` high-water mark per channel across both spaces, so a message-derived cursor always trails the event head and replay errs toward re-delivery (deduped client-side by message id) rather than skipping unseen messages.
- The converse is the real limit: an event-derived cursor can be ahead of the message space, and the shared cursor never moves backwards (`persistSeq` only raises). See Gaps.

## Ports
- `recordBrokerEvent` — append one broker event to its channel log; returns the record or `null` when classified as not-logged; never throws.
- `recordBrokerEventDetached` — fire-and-forget wrapper for the broker `onAny` hook.
- `listRecentEvents` — `(channelId, { afterSeq?, limit? })` → `{ events, lastSeq, headSeq }` ascending by seq.
- `eventLogStats` — process-lifetime `{ appended, skipped, failed }` counters (drop observability).
- `resetEventLogStatsForTests` — zeroes the counters (tests only).
- `EPHEMERAL_EVENT_TYPES` — the never-persisted key set (`message:stream`).
- `isEphemeralEventType` — predicate over that set.
- `resolveEventChannelId` — top-level `channelId` else payload `channelId`, else `null`.
- `shouldLogEvent` — the whole classification decision, pure.
- `DEFAULT_EVENT_PAGE_LIMIT` / `MAX_EVENT_PAGE_LIMIT` — 100 / 200.
- `allocateEventSeq` — reserve the next per-channel seq (bump-first).
- `appendEventRecord` — append a caller-built record.
- `eventHeadSeq` — highest seq in the log (0 when absent).
- `listEventRowsNewestFirst` — raw newest-first rows for diagnostics.
- `resetEventSeqFloorForTests` — clears the per-process seq floor memo (tests only).
- `EventLogRecord` — one JSONL line type.
- `ListRecentEventsOptions` — `{ afterSeq?, limit? }`.
- `RecentEventsResult` — `{ events, lastSeq, headSeq }`.
- `eventsGate.record` — port alias of `recordBrokerEvent`.
- `eventsGate.recordDetached` — port alias of `recordBrokerEventDetached`.
- `eventsGate.listRecent` — port alias of `listRecentEvents`.
- `eventsGate.headSeq` — port alias of `eventHeadSeq`.
- `eventsGate.isEphemeral` — port alias of `isEphemeralEventType`.
- `eventsGate.stats` — port alias of `eventLogStats`.

## Relations
Gates this domain calls:
- None. Shared-only: `shared/core/local-file.ts` (`appendEventJsonl`, `readEventJsonl`, `mutateJsonObject`, `withStoreLock`).
- Type-only (no runtime dependency): `BrokerEvent`/`BrokerEventType` (`event-broker-gate.ts`).
Known outside callers of gate functions:
- Boot: `create-app.ts` registers the single `onAny` hook.
- Routes: `routes/events.ts` (the only reader of `listRecent`).
- Tests: `events/events-log.test.ts` (store-level), `events/events-route.test.ts` (route-level through `buildServer`).
Files this domain owns outright:
 - `events/<channelId>.jsonl` (per channel, inside the owning workspace's `vfs/.crowdos/`).
- `event-sequences.json` (per-channel counters).
Files it reads but does not own: none — it never touches the message log or `sequences.json`.

## Emits-Listens
- Listens: `*` — one `onAny` subscriber, registered once at boot (`create-app.ts`). This domain is the log's only writer.
- Emits: nothing. The log is a sink; it never re-emits or replays onto the live bus (replay is pull-based over HTTP, by design — a replayed event must not look like a live one).

## Owns
- `events/<channelId>.jsonl` — sole writer (append only; no update, no delete, no compaction).
- `event-sequences.json` — sole writer (per-channel seq counters).

## Flags
- None. This domain reads no environment variables. The retired `DURABLE_EVENTS` flag is gone from the path entirely: local logging is unconditional, because it is a file append rather than a network write. `CROWDOS_LOCALSTORE_DIR` affects where the log lives but is read by `local-file.ts`, not here.

## Decisions
- [Observed] ONE append hook (`broker.onAny` at boot) instead of appends sprinkled at call sites — why: the retired `durable_events` design was a single `onAny` fan-out that classified and persisted, and that shape is what makes "which events are durable" a reviewable one-line rule rather than a property of 35 call sites (`create-app.ts:344`).
- [Observed] Ephemeral classification preserved verbatim from the retired PG path — why: `message:stream` is one event per token chunk; persisting it would flood the log with data the final `message:new` already carries. Keeping the exact same set means replay semantics did not silently change with the storage move (`event-classification.ts`, pre-D6 `register-socket-server.ts` `EPHEMERAL_EVENTS`).
- [Observed] Own seq space (`event-sequences.json`), not the message `sequenceNumber` — why: the message counter is Messages-owned and already consumed by `messageGate.append`; sharing it would make message seqs sparse and couple two domains' write paths for no benefit.
- [Observed] Bump-first allocation — why: matches the message store. A crash between reserve and append leaves a gap (`seq` jumps), which is harmless because `afterSeq` is an exclusive cursor and clients never assume contiguity; a duplicate would be actively harmful.
- [Observed] `lastSeq` = head when the tail is empty — why: a caught-up client must be able to distinguish "nothing new" from "the log is broken"; echoing the request cursor would hide the difference and could pin a client at a stale cursor forever.
- [Observed] `deprecated: true` and the no-op comment block removed — why: the endpoint was a documented lie (always empty). It now serves real history or honestly answers empty, and the response shape is exactly the client contract in `client.ts`.
- [Observed] Torn-tail repair on append (`terminateTornTail`) — why: without a separator the next record would be glued onto the crash fragment and BOTH would be unreadable; the repair keeps one line per record so only the torn line is lost.
- [Observed] Retention: NONE, deliberately — why: the message log is also never pruned, retention was a PG-era 24h timer tied to `durable_events`, and inventing a local pruning rule in this change would silently delete history the user never asked to lose. Declared here rather than half-implemented.
- [Observed] Replay is pull-based HTTP, not socket re-emit — why: a replayed event re-emitted on the live bus would be indistinguishable from a fresh one to every other subscriber (and would re-enter this domain's own `onAny` hook). The client asks for the tail with a cursor it owns.
- [Inferred] Append failures are counted rather than retried — why: the log is a local file write; a failure means a broken filesystem, and retrying into it would burn the emit path. The counter plus warning makes the loss visible.

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this; current code is a local single-process log, not a distributed one.
Event persistence has exactly ONE writer path: the boot-registered `broker.onAny` hook. Producers MUST NOT append to the event log directly.
The ephemeral set stays explicit and documented. Adding a key to it, or persisting a high-frequency stream, requires the classification table here to be updated in the same change.
`afterSeq` is exclusive and `lastSeq` MUST reflect the returned tail or the head — never a fabricated or echoed value. A silent empty response standing in for "unknown" is forbidden.
The event `seq` space MUST stay independent of the message `sequenceNumber` space until a single shared allocator is designed. Implicitly sharing a counter is forbidden.
Log records MUST stay one line per event, JSON, and torn-tail tolerant. Multi-line records or a format that cannot survive a partial write are forbidden.
Workspace isolation MUST be enforced by path AND recorded on the record. A log read that cannot name its owning workspace is incomplete.
Worker processes (bullmq mode) MUST NOT claim the log as durable cross-process history while the broker stays process-local; the single-process limitation is declared in EventBroker's standard and applies here unchanged.

## Failure + Resume
- Torn/partial trailing line: skipped by the reader; the next append writes the missing newline first so the following record survives (`local-file.ts:terminateTornTail`).
- Append failure (unwritable dir, disk error): counted in `eventLogStats.failed`, warned, and swallowed — live delivery and runs are unaffected (`event-log-service.ts`).
- Counter lost or reset independently of the log: `allocateEventSeq` floors the counter to the file head once per channel per process, so seqs cannot be reissued and `afterSeq` cannot silently start skipping (`event-local-store.ts`).
- No replay-after-restart of live sockets: nothing re-emits the log onto the bus. Recovery is the client's `afterSeq` pull plus the message refetch on channel switch.
- Crash between seq reserve and append: a gap in `seq`. Harmless by construction (exclusive cursor); it does mean `seq` is NOT a count of events.

## Gaps
- **Cursor space sharing, analysed.** The client keeps ONE `channelSeq` high-water mark per channel (`crowdOsStore.ts:571-579`) that is fed from two different server spaces: message `sequenceNumber` (from the channel-switch refetch, `crowdOsStore.ts:2476-2477`) and event `seq` (from each gap-fetch result, `crowdOsStore.ts:601`). Live socket envelopes carry `seq: null` (the broker never sets `event.seq`), so they never advance it. This is safe in the direction that matters — every message emits a logged `message:new`, so event seqs advance at least as fast as message seqs, which means a message-space cursor UNDER-selects the event log and the client re-applies events it already has (deduped by message id) rather than missing new ones. It is not safe in the other direction, and the honest limits are: (a) `persistSeq` never lowers a cursor, so once an event-space value is adopted a later, smaller message-space head cannot pull it back — recovery then depends on the refetch page rather than the cursor; (b) the event log is NOT a complete index of messages, because messages written without a broker (seed/backfill/PG-explicit paths, `message-service.ts` `opts.tx || opts.db`) emit nothing and therefore leave no event; (c) an append failure stalls the event space while messages keep advancing, so a reconnect WITHOUT a channel switch can miss that message (the channel-switch refetch would still recover it). A single shared per-channel ordering, or a per-space cursor pair in the client, is the fix; neither is possible server-side alone.
- **Replay recovers client gaps, not server state.** Nothing reduces the log back into messages, runs, or agent state. If the message log and the event log disagree (failed append, seed without broker), replay does not repair the disagreement — it reports what the event log holds.
- **No retention and no size bound.** The log grows for the lifetime of the localstore. Neither a byte cap nor a time window exists; a busy channel's log is unbounded. The retired PG path had a 24h sweeper — nothing replaced it.
- **No compaction and no snapshot.** A log can be read as a full history, but there is no snapshot/checkpoint pair, so "replay from scratch" cost grows linearly forever. §28's `reducer` step does not exist: nothing consumes the log to rebuild state, and no reducer is defined. Replay is currently a *transport* recovery (fill a client gap), not a *state* recovery.
- **Append ordering vs emit ordering is per-channel only.** `appendNextEvent` serializes per channel; two channels interleave freely, and a global order across channels does not exist (the retired `bigserial` gave one). Any cross-channel causality assumption is unsupported.
- **In-process only — and deliberately NOT wired in `worker.ts`.** The hook attaches to the process-local broker, so in bullmq mode the worker's broker is worker-local and worker-produced events never reach the log (the same limitation EventBroker's standard declares). Registering a second hook in the worker process was considered and rejected: the shared file mutex is an in-process promise chain (`local-file.ts` header), and the seq counter is a read-modify-write over `event-sequences.json`, so two processes appending to the same channel would race both the line order and the counter (duplicate seqs). A worker-side hook needs a cross-process lock or a real store first — adding it without one is a regression, not a fix.
- **`eventLogStats` is process-local and unexported to metrics.** Drops are visible in a counter object and a warning line, not in `/api/metrics`. Emit-drop observability is the EventBroker standard's open item too.
- **No dedupe on append.** Re-emitting the same `eventId` writes a second line with a new seq. The retired PG table had a unique `eventId`; the local log has none. Nothing re-emits today, so this is latent rather than active.
- **`workspaceId` is captured opportunistically.** It is read from the payload when a producer tags it, and `null` otherwise — it is an audit field, not an enforcement field. Isolation is enforced by the channel→workspace relation and the per-channel file, not by this column.
- **`workspaceId` is captured opportunistically.** It is read from the payload when a producer tags it, and `null` otherwise — it is an audit field, not an enforcement field. Isolation is enforced by the channel→workspace relation and the per-channel file, not by this column. Since XD-013 the write path resolves the channel row FIRST and only falls back to the payload; since XD-014 the recent-read route asserts caller-vs-channel workspace (403 on mismatch).
- **No consumer of the log other than the replay route.** `listEventRowsNewestFirst` and `eventHeadSeq` exist for diagnostics; nothing in the runtime reduces the log into state.
- **`message:new` payload size is unbounded in the log.** The broker drops payloads over 256KB before fan-out (so they never reach here), but a near-cap payload is written to disk verbatim, and the message log stores the same content again. Duplicate on-disk cost for message-bearing events is unmeasured.

# Messages

## Purpose
Sole owner of the `messages` table. Every channel-history write goes through `messageGate.append`; Local-first paths atomically deduplicate the row id, reserve its sequence, and append, then dual-tier paths replicate it before `message:new`. Reads use keyset-paginated history and merge internal-monologue rows into display cards (tool-execution cards, thought attachments, synthetic reasoning footers).

## Feature Scope
In-scope:
- Sole write path `appendMessage` over `messages` (channel or thread sequence, nullable `workspace_id`, id override for idempotent scheduler retries).
- Keyset page fetch over `(timestamp, sequenceNumber)` with `limit + 1` probe.
- Monologue merging: structured tool-call cards, legacy tool-result pairing, thought attachment, synthetic trailing-monologue rows.
- Before-cursor parsing with typed `MalformedCursorError`.
- Zod validators for the single read route.
Non-goals (other domains):
- Execution, presence, scheduling, thread counters → Runtime / Agents / Queue / Threads call `messageGate.append` and emit through it; they never write `messages` directly.
- Delivery, fan-out, replay → EventBroker contract + Sockets (`message:new`, `GET /api/events/recent`).
- Auth, rate limits, transport → Routes/Sockets (this domain only validates params/query shape).
- Thread pagination → Threads owns the cursor contract; the page query itself is this domain's `messageGate.getThreadPage` port (THR-015), which Threads calls with its tenant handle.
- Raw parent-message existence → `messageGate.existsInChannel` checks an exact message id within one channel and workspace; Threads can use it for parent validation without reading message storage directly.
- Thread reply detachment → `messageGate.detachThreadReplies` clears reply links under the Messages-owned Local JSONL lock or in the scoped database when Threads deletes a thread.

## Expect
- [Observed] `includeMonologue` was removed from the service, validator, and route — output merging has no monologue filter.
- [Observed] `getChannelMessages` was removed; paging goes through `getChannelMessagesPage` (`message-service.ts:287-322`).
- [Observed] Page limit clamps to 1–200, default 50 (`message-service.ts:139-140`, `message-service.ts:291`).
- [Observed] Cursor format is strictly `<ISO timestamp>;<sequenceNumber>`, split on the last `;` (`message-service.ts:149-159`).
- [Observed] Output order is newest-first even though pairing runs chronologically (`message-service.ts:335-349`).
- [Observed] A tool card counts as success unless its output starts with `"Error:"` (`message-service.ts:99`).
- [Observed] Empty pages return `{ messages: [], cursor: null }` (`message-service.ts:331-333`).
- [Observed] `messageGate.existsInChannel` checks raw message ids against the requested channel and workspace. It reads the workspace JSONL path first, then uses `dbForWorkspace` as a gap-fill in dual tier; the tenant database scope permits legacy null `workspace_id` rows while non-null workspace mismatches still fail. A `CROWDOS_LOCALSTORE_DIR` override shares one folder across workspace ids, so its legacy null rows match only the default scope; explicit workspace row ids still match their owner. Null and `"default"` share the default scope. An explicit `db` override stays pinned and requires an exact workspace predicate (with the default alias). Storage read failures propagate.
- [Observed] Local append checks for an existing `(workspace, channel, id)` while holding the JSONL file lock; only a missing ID reserves a sequence and appends. Retries return the persisted row and do not queue a replica/outbox write or emit another `message:new` (`message-service.ts`, `message-local-store.ts`, `local-file.ts`).
- [Inferred] Callers must treat `cursor: null` as end-of-history; any non-null cursor always points at a strictly older row (`message-service.ts:339-347`).

## Flow
1. Route: `GET /api/channels/:channelId/messages` validates params/query, parses `before`, and forwards `{ limit, before, db }` (`routes/messages.ts:16-44`); malformed cursors become HTTP 400 (`routes/messages.ts:33-42`).
2. Page: `getChannelMessagesPage` resolves `db` (override or ambient), clamps limit, and builds either a channel-only or `(timestamp, seq) < before` tuple filter (`message-service.ts:287-304`).
3. Fetch: rows load newest-first via `(timestamp DESC, sequenceNumber DESC)` with `limit + 1` to probe `hasMore`; the page is reversed to chronological for pairing, then the merged list is reversed back to newest-first for output. MSG-004 boundary context: the limit+1 probe row is passed in as the older context (one row immediately older than the page), and cursor pages fetch the single row immediately newer than the page head (message-service.ts:453/517); both are merge context only and are never emitted.
4. Structured cards: monologue rows with a `toolCalls` array emit one `tool_execution` card per entry (`id: tool-<msgId>`) with JSON-normalized input (`message-service.ts:171-182`, `message-service.ts:129-137`).
5. Legacy pairing: `🛠️ [Tool Result: <name>]` rows match the regex (`message-service.ts:161`), consume the oldest queued input for that author+tool, and emit a zero-duration card (`message-service.ts:183-198`).
6. Thoughts: other monologue rows contribute stripped thoughts to a per-author pending slot and queue parsed `tool(name, input)` calls for later result pairing (`message-service.ts:199-215`).
7. Normal rows: non-monologue messages attach any pending monologue as `metadata.monologue` (agents only) and clear the slot; an older-context monologue seeded before the loop attaches the same way (MSG-004), and a newer-context agent final consumes its author's pending monologue so the pair renders on the owning page.
8. Leftovers: unattached pending monologues become synthetic `monologue-<agentId>` rows with `*Reasoning completed*` content; MSG-004 boundary seeds (from the older-context row) are dropped instead of emitted, because their row lives on another page.
9. Cursor: when `hasMore`, the cursor encodes the oldest fetched row's `(timestamp, seq)`; otherwise `null` (`message-service.ts:339-347`).
10. Replica leg (2026-09-25 audit fix): the PG replica insert + counter repair run on the WORKSPACE-record database handle when the channel's workspace has one, falling back to the ambient handle only when no workspace handle resolves (`message-service.ts`, appendMessage). Previously the replica leg always used `withTransaction` over the ambient pool, so a workspace with its own record database had its replica rows written into the wrong database — and because that write SUCCEEDED, no outbox entry was queued and the row never reached the owning workspace DB except via a manual converge.

## Current Implementation
- `messages/message-service.ts` → read + merge + sole write owner. `DEFAULT_PAGE_LIMIT = 50`, `MAX_PAGE_LIMIT = 200` (`message-service.ts:139-140`); `MalformedCursorError` with code `PAGINATION_BAD_CURSOR` (`message-service.ts:142-147`); `parseBeforeCursor` (`message-service.ts:149-159`); `TOOL_RESULT_RE` legacy header matcher (`message-service.ts:161`); `mergeMessageRows` pairing engine (`message-service.ts:163-261`); ``getChannelMessagesPage` keyset fetch (`message-service.ts:287-322`); `appendMessage` sequence + insert + `message:new` (`message-service.ts:387-406`). The merged read shape preserves authorship: `mergeMessageRows` maps `authorType` 'system' to type 'system' ('user' → 'human', 'agent' → 'agent') — regression `message-system-author-type.test.ts` (SYSMSG-001).
- `messages/message-types.ts` → shapes. `MessageAuthorType` (`user|agent|system`), `ChannelMessage` (incl. `isInternalMonologue`, `sequenceNumber`), `StructuredToolCall` (`name/args/result/truncated/durationMs/callId`), `MessagePageCursor`, `ChannelMessagesPage` with `messages: any[]` (`message-types.ts:1-39`).
- `messageExistsInChannel` → exact raw id lookup across the requested channel and workspace; Local JSONL path is checked first, with a scoped DB gap-fill when the workspace tier is dual.
- `messages/message-validators.ts` → route schemas. `channelId` min 1; ``limit` coerced int 1–200; `before` opaque string parsed downstream (`message-validators.ts:1-13`).
- `messages/message-gate.ts` → re-export + `messageGate` with history reads, `existsInChannel`, cursor parsing, and `append`.
- `messages/message-gate.ts` → re-export + `messageGate` with `getChannelMessagesPage`/`listRecent`/`parseBeforeCursor`/`append` (plus `MAX_PAGE_LIMIT`; the legacy `getChannelMessages` entry below is doc drift). Fixed this task: `listRecent` PG order carries the `sequenceNumber` tiebreak (MSG-006); `localAppendMessage` dedupes by id (MSG-005).
- `messages/message-gate.ts` → re-export + `messageGate` with `getChannelMessagesPage`/`listRecent`/`parseBeforeCursor`/`append` (plus `MAX_PAGE_LIMIT`; the legacy `getChannelMessages` entry below is doc drift). Fixed: `listRecent` PG order carries the `sequenceNumber` tiebreak (MSG-006); `localAppendMessage` dedupes by id (MSG-005); replica floor reads the workspace DB handle (MSG-002); REST read asserts caller-vs-channel workspace (MSG-007).
- `messages/message-gate.ts` → re-export + `messageGate` with `getChannelMessagesPage`/`listRecent`/`parseBeforeCursor`/`append` (plus `MAX_PAGE_LIMIT`; the legacy `getChannelMessages` entry below is doc drift). Fixed: `listRecent` PG order carries the `sequenceNumber` tiebreak (MSG-006); `localAppendMessage` dedupes by id (MSG-005); replica floor reads the workspace DB handle (MSG-002); REST read asserts caller-vs-channel workspace (MSG-007). Uniqueness is thread-aware via migration 0025 `(channel_id, COALESCE(thread_id,''), sequence_number)` (MSG-001/THR-002/XD-007 fixed).
  2026-10-07 db-audit note: migration 0025 was missing from `meta/_journal.json`, so drizzle never applied it (drizzle reads ONLY journal-listed tags) and this uniqueness existed solely in `schema.ts`. Journal entry added; 0025 now runs on migrate.
 - `messages/message-local-store.ts` → file truth (`<workspaceFolder>/vfs/.crowdos/messages/<channelId>.jsonl` + `sequences.json` bump-first counters) when no `DATABASE_URL`; same keyset/newest-first shapes as the DB path. Canon 2026-09-22: the log and its counter live inside the owning workspace's folder.

## Ports
- `ChannelMessage` — channel message record type (incl. internal-monologue flag and sequence number).
- `StructuredToolCall` — structured tool-call payload type.
- `ChannelMessagesPage` — `{ messages: any[], cursor: MessagePageCursor | null }` page type.
- `MessagePageCursor` — `{ before: { timestamp: string, seq: number } }` cursor type.
- `getMessagesParamsSchema` — zod validator for `{ channelId }` params.
- `getMessagesQuerySchema` — zod validator for `{ limit, before }` query.
- `GetMessagesParams` — validated params type.
- `GetMessagesQuery` — validated query type.
- `getChannelMessagesPage` — keyset-paginated getter with `{ limit, before, db }` opts.
- `getThreadMessagesPage` / `messageGate.getThreadPage` — THR-015 thread-scoped RAW page port (`{ channelId, workspaceId?, limit?, before?, db? }` → `{ messages, nextCursor }`): rows keep `threadId` (the merged channel-page shape drops it); PG branch honors an explicit `db` handle, local branch filters the owning channel log by thread before applying the page limit and probe. Consumed by Threads (`thread-service.ts:252`).
- `messageGate.existsInChannel(messageId, { channelId, workspaceId?, db? })` — exact raw-message existence check scoped to channel and workspace; an explicit `db` handle pins DB mode, otherwise it checks the workspace's raw JSONL log first and resolves a workspace DB gap-fill when configured. Workspace resolution proves tenant scope for legacy null-workspace rows; null and `"default"` are equivalent for default-scope rows.
- `messageGate.detachThreadReplies(threadId, { channelId, workspaceId?, db? })` — clears `threadId` only for messages in the supplied channel and workspace; a Local rewrite is serialized with message appends, while `db` pins the exact database handle. Returns the number of detached rows.
- `appendMessage` — sole `messages` write: `{ channelId, authorId, authorName, authorLevel, authorType, content, mentions?, metadata?, toolCalls?, isInternalMonologue?, threadId?, workspaceId?, id? }` with `{ broker?, db?, tx? }` opts; reserves the channel (or thread) sequence and inserts atomically, then emits `message:new`.
- `AppendMessageInput` — append input type.
- `AppendMessageOpts` — `{ broker, db, tx }` opts type.
- `parseBeforeCursor` — parses `<ISO>;<seq>` into `{ timestamp, seq }`, throws on malformed.
- `MalformedCursorError` — cursor error type with code `PAGINATION_BAD_CURSOR`.
- `DEFAULT_PAGE_LIMIT` — default page size constant (50).
- `listRecentMessages` — raw newest-first rows for context middlewares (DB or file); an implicit PG gap-fill resolves the owning workspace handle first and uses the ambient DB only when no workspace handle resolves. An explicit DB override remains pinned.
- `messageGate.getChannelMessages` — legacy message list getter.
- `messageGate.getChannelMessagesPage` — keyset-paginated message getter.
- `messageGate.getThreadPage` — thread-scoped raw page getter (THR-015; the Threads domain's message-read path, raw rows incl. `threadId`).
- `messageGate.listRecent` — alias of `listRecentMessages`.
- `messageGate.append` — sole message write path (dual-write: same seq on both tiers; outage degrades to local + outbox).
- `messageGate.parseBeforeCursor` — parses a before cursor string.

## Relations
Gates this domain calls:
- `threadGate` (Threads) — `threadGate.allocateSequence(input.threadId, 1, tx)` on the thread append branch (THR-016; `message-service.ts:665`). Gate-to-gate both ways: Threads reads thread pages via `messageGate.getThreadPage` (THR-015).
- Shared-only: ambient `getDb` (+ optional `db` override), `stripToolCalls`/`parseToolCalls` from `@community-agent/shared` (`message-service.ts:1-5`).
- Type-only (no runtime dependency): `AuthorityLevel` (`agent-gate.ts`), `MentionMetadata` (`types/mention.types.ts`) (`message-types.ts:1-2`).
Consumer ports:
- `messageGate.existsInChannel` is available for exact parent-message validation; the Threads consumer integration is handled in its own domain phase.
- `messageGate.detachThreadReplies` is consumed by Threads deletion so messages stay owned by this domain and replies are preserved as channel messages.
Known outside callers of gate functions:
- Readers: `routes/messages.ts` (sole production reader path).
- Readers (thread page): Threads via `threadGate.getMessages` → `messageGate.getThreadPage` (`thread-service.ts:252`), THR-015 fixed.
- Writers (all via `messageGate.append`, never direct): Runtime kernel (`runtime-kernel.ts:154-197` persist path), Sockets user + system warnings (`register-socket-server.ts:141-166`), Agents errors (`agent-errors.ts`), Tools scheduler emit (`tool-registry.ts`), Queue scheduler worker (`scheduler-worker.ts:43-71`), Threads route (`routes/threads.ts:87-123`), Librarian (`librarian-runtime.ts`), TokenTracker (`token-tracker.ts`).
- Tests: `runtime/tool-call-round-trip.test.ts`, `runtimes/monologue-e2-e.test.ts`, `messages/message-pagination.test.ts` (setup rows only).
- Type-only importers: `event-broker/event-types.ts` (`message:new` payload), `db/schema.ts` (`tool_calls` column type), `shared/core/token-tracker.ts`, `shared/core/librarian-runtime.ts`, `shared/sockets/register-socket-server.ts`.
Tables owned outright (sole writer is `appendMessage`):
- `messages` — channel + thread rows (sequence reserved per channel via `channel_sequences`, per thread via `thread_sequences`).
- `messages` readers: `shared/core/index-builder.ts`, visibility/channel-awareness middlewares, `routes/search.ts`, `threads/thread-service.ts`. (`core/memory-builder.ts` deleted 2026-10-07 — dead legacy surface, zero importers; superseded by the Runtime context pipeline.)

## Emits-Listens
- `message:new` (emits, on every `append` with a broker).

## Owns
- `messages` — sole owner; every insert goes through `messageGate.append` (bootstrap seed in `workspace-database.ts` and `db/check.ts` health-check excepted).

## Flags
- None — this domain reads no environment variables.

## Decisions
- [Observed] Single writer by construction: every runtime insert goes through `appendMessage` (sequence + insert in one transaction, then `message:new`) — why: history had 10 concurrent direct writers with divergent emit/sequencing; one funnel keeps ordering gap-free and every row emitted exactly once (`message-service.ts:387-406`).
- [Observed] Keyset over `(timestamp, sequenceNumber)` instead of offset — why: concurrent inserts during scroll must not duplicate or skip rows; the tuple is backed by `messages_channel_ts_seq_idx` (`message-service.ts:293-299`, `db/schema.ts:292-296`).
- [Observed] `limit + 1` probe with cursor derived from the oldest fetched row — why: `hasMore` and the next cursor come from one query, no count needed (`message-service.ts:324-349`).
- [Observed] Pairing runs chronologically while the page fetches newest-first — why: monologue→response and tool-call→result pairing only resolve forward in time (`message-service.ts:335-349`).
- [Observed] Legacy `🛠️ [Tool Result:]` header parsing retained alongside structured `toolCalls` — why: old rows predate structured storage and must still render as cards (`message-service.ts:161-198`).
- [Observed] Unattached trailing monologues become synthetic `*Reasoning completed*` rows — why: in-flight reasoning with no final response yet must still be visible (`message-service.ts:243-258`).
- [Observed] MSG-004: pairing context crosses page edges via one adjacent row per side — why: a monologue/final pair split at a boundary must not surface as a misplaced synthetic card (older page) plus a bare final (newer page); the one-row overlap keeps the probe free and the gap bounded.
- [Observed] `listRecentMessages` uses the owning workspace-record DB handle for its PG gap-fill and falls back to the ambient handle only when no workspace handle resolves, matching `getChannelMessagesPage`.
- [Inferred] `includeMonologue` was removed entirely — why: no validator/route/service references remain.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Single-writer plus keyset pagination stay; merge typing, cursor scope, and workspace drift are the gaps.
Every runtime insert goes through appendMessage sequence plus insert in one transaction then message:new. Direct messages writes outside appendMessage are forbidden except labeled bootstrap and health-check seeds.
History reads use keyset over timestamp plus sequenceNumber with limit plus 1 probe. Offset pagination for channel history is forbidden.
Malformed before cursors throw MalformedCursorError mapped to HTTP 400 with expected format. Silent head-read fallback is forbidden here.
Monologue merge MUST use a discriminated message type, not any[]. Merged cards, thought attachments, and synthetic rows share one explicit union.
Structured tool cards MUST have unique IDs per call (include call index or callId). Duplicate id tool-sameMsgId in one page is forbidden.
includeMonologue MUST be implemented or removed. Accepted-but-ignored filter flags are forbidden.
Legacy tool-result header parsing stays for old rows alongside structured toolCalls.
Synthetic leftover rows MUST match ChannelMessage shape (Date timestamp, real authorship) or be a labeled synthetic type. Shape drift is forbidden.
messages.workspace_id plus channels.workspace_id drift MUST resolve to one rule: NOT NULL enforced or nullable by contract, with all deployed DBs migrated. Superseded-migration split-brain is forbidden.
Migrator journal entries MUST use when newer than any deployed max. Older-when entries silently skipped MUST be a documented release rule.
## Failure + Resume
- Malformed `before` (missing `;`, non-numeric seq, bad date, empty side) throws `MalformedCursorError`, mapped to HTTP 400 with the expected-format message (`message-service.ts:149-159`, `routes/messages.ts:33-42`).
- Out-of-range `limit` is clamped, never rejected (`message-service.ts:291`); unknown channel returns an empty page, never 404 (`message-service.ts:331-333`).
- No retry or resume logic in-domain; clients resume by following `cursor.before` until `cursor` is `null`.

## Gaps
- `messages.workspace_id` is nullable in schema with a `0016` migration normalizing drifted DBs (a superseded workspace-scoping migration had left some DBs with `NOT NULL`, which runtime writers never set); `channels.workspace_id` has the same drift (nullable in schema, `NOT NULL` on old DBs — `db/check.ts` works around it). Whether workspace scoping should be enforced `NOT NULL` is undecided.
- Migrator applies journal entries by `when` timestamp vs the DB's last migration (`pg-core/dialect.js`), so a new entry with an older `when` is silently skipped — future migrations must use a `when` newer than any deployed DB's max.
- `includeMonologue` was removed from gate, validator, route, and merge — there is no monologue filter to exclude with.
- Multiple structured tool calls on one row all emit `id: tool-<sameMsgId>` — duplicate card ids in one page; client keying impact unverified (`message-service.ts:99-117`).
- Legacy-matched cards hardcode `durationMs: 0` — indistinguishable from genuinely instant calls (`message-service.ts:197`).
- Synthetic leftover rows use a string ISO timestamp (vs `Date` on real rows), generic `Agent Swarm`/`3` authorship, and the request's `channelId` — shape drift vs `ChannelMessage` unverified downstream (`message-service.ts:243-258`).
- `ChannelMessagesPage.messages` is `any[]` — merged cards, thought-attached messages, and synthetic rows share no discriminated type (`message-types.ts:36-39`).
- `MAX_PAGE_LIMIT` (200) is exported only inside the service module, not via the gate — route-level `limit` max happens to match but is enforced solely here (`message-service.ts:139-140`).
- `MAX_PAGE_LIMIT` (200) is now re-exported through the gate (MSG-013 fixed); route-level `limit` max matches and is enforced in the service (`message-service.ts:139-140`).
- getChannelMessages` was removed (only `getChannelMessagesPage` remains); no shim callers can exist.

- MSG-004 boundary pairing resolves single-row adjacency only: each page fetches ONE context row per side (a newer probe for cursor pages + the limit+1 older probe). When tool rows or extra monologue iterations separate a monologue from its final across a page edge, the older page still shows the synthetic *Reasoning completed* row and the final renders bare — multi-row continuity needs cursor-carried pairing state (follow-up if observed).
- MSG-001 depends on migration 0025 (`messages_channel_thread_sequence_idx`) being applied before replica writes; until then PG still holds the old channel-scoped index and a legit channel/thread seq overlap surfaces as a replica-leg failure routed to outbox replay instead of a silent drop.
- `buildReplicaInsert` (message-service.ts:566) is exported solely for the in-domain regression test — an internal seam, not a gate port.
- MSG-008 fixed: structured tool-call results resolve status from explicit `result.ok`/`result.error` (structuredResultStatus, message-service.ts:175) before the legacy prefix fallback; non-string results JSON-stringify, never `String()` (message-service.ts:290-295). Regression: `message-pagination.test.ts:383`.
- MSG-009 fixed: thread replies pass the broker INTO `messageGate.append` (routes/threads.ts:110-131) and the route no longer emits `message:new` itself - single emit from the domain (message-service.ts:652/684/736). Regression: `message-pagination.test.ts:418`.
- MSG-010 fixed: the read gap-fill resolves the workspace-record DB handle (`resolveWorkspaceHandle(workspaceId) ?? getDb()`, `message-service.ts:487`) — the same handle the write replica leg uses; ambient pool stays the single-DB fallback. Regression: `message-pagination.test.ts:527`.
- MSG-011 fixed: `workspaceOfChannel` caches positive hits only and falls back to the channel log file (`findWorkspaceIdForChannelLog`) before giving up (`message-service.ts:36-55`); a first-lookup miss no longer pins a channel to the default scope. Regression: `message-pagination.test.ts:607`.
- MSG-012 fixed: appendMessage validates AppendMessageInput via appendMessageInputSchema before any write and throws InvalidMessageInputError (MESSAGE_INVALID_INPUT); local rows can no longer be written with undefined content (message-validators.ts:30, message-service.ts:215/613-618). Regression: message-pagination.test.ts:846.
- MSG-018 fixed: message:new is documented and tested as a LOCAL-COMMIT event (message-service.ts:588-592); replica failure still emits exactly once and queues the row to the outbox (message-service.ts:759). Regression: message-pagination.test.ts:896.

- MSG-020 fixed: outbox replay for entity "message" now repairs the PG counter as part of the entry replay via the same GREATEST upsert as repairPgCounter/the append replica leg (workspace-sync.ts:510-520); a later PG-side allocateSequence can no longer reissue a seq the replay already landed. Regression: message-pagination.test.ts:765 (red before wiring: 1 insert call vs 2).
- MSG-030 fixed (documented, not enforced): the trust boundary is the TRANSPORT, not the domain - appendMessage persists caller-supplied authorId/authorName/authorType verbatim as an internal API (message-service.ts:598-605); the socket path derives authorId from the verified identity (SEC-2). An optional in-domain actor check (system rows gated behind an actor option) is deferred; if added it must deliberately flip message-pagination.test.ts:537.

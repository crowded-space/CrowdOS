# Messages Domain - Invariant Catalog (read-only audit, 2026-10-06)

Legend: Holds = verified in code path; Broken = violated by a confirmed defect; Conditional = holds only under stated conditions.

## Write path invariants

| ID | Invariant | Status | Evidence | Notes / violations |
| --- | --- | --- | --- | --- |
| INV-1 | Every message insert flows through appendMessage except labeled bootstrap/health seeds | Holds | Only direct writes: db/check.ts:78,122; workspace-database.ts:564; workspace-sync.ts:253,258,448 (pull/push/outbox replay, documented) | gate checker (lint:gates) reports 0 violations |
| INV-2 | Sequence numbers are never reissued within a tier | Conditional | Local bump-first (:463, message-local-store.ts:42-63); PG GREATEST repair (:498-504); floor bridge (:54-70) | Broken across tiers when the floor reads the wrong DB (MSG-010); PG-only collision with thread seq space (MSG-002) |
| INV-3 | A committed local row implies the caller received a row | Holds | local append before any PG work (:464); local throw propagates before PG (:449-452 comment) | Crash between seq reserve and append leaves a gap only (documented) |
| INV-4 | The returned row is byte-identical to the emitted message:new payload | Holds | same object (:468, :473, :525) | authorLevel may be number while stored as string (MSG-003) |
| INV-5 | A caller-supplied id makes the append idempotent end-to-end | Broken | Scheduler passes id (queue/scheduler-worker.ts:27,40); replica insert-ignore (:497); local append has no id dedupe (message-local-store.ts:88-94) | Retry after a local success duplicates the local JSONL row; PG stays 1 (MSG-005) |
| INV-6 | message:new is emitted at most once per append | Holds in-domain | append emits once (:473/:525) | Thread route emits a second time after calling append WITHOUT broker (routes/threads.ts:98-114) - double emit in practice (MSG-009) |
| INV-7 | message:new implies the row is visible in the PG replica | Broken | Emit happens after the replica catch block (:512-525) | Consumers (IndexBuilder counter, sockets) can observe events for rows PG does not hold yet (MSG-018) |
| INV-8 | Every write allocates exactly one sequence from exactly one counter | Holds | threadId ? thread:<id> : ch:<channelId> (:453); single localAllocateSequence call (:463); tx path single allocator (:433-435) | Two counter namespaces collide in one PG unique index (MSG-002) |
| INV-9 | sequenceNumber increases monotonically per (channel|thread) in read order | Conditional | PG orders (timestamp DESC, seq DESC); local sorts same tuple (message-local-store.ts:104-107) | Timestamps are caller-clock; a late-arriving message with an older timestamp reads older despite a higher seq (documented keyset tradeoff). Thread rows share the channel unique index. |
| INV-10 | Unknown channel produces an empty page, never an error/404 | Holds | :331-333; route returns 200 | Docs contract; no channel existence check on read path |
| INV-11 | Malformed cursor always fails loudly (400) | Holds on REST read | :149-159; routes/messages.ts:33-39 | Thread read path tolerantly swallows malformed cursors (thread-service.ts:138-145) - different contract on the sibling path |
| INV-12 | Cursor always points strictly older than the last page | Holds | Keyset filter (:294-299); cursor from oldest page row (:339-347) | Synthetic rows in the merge have no seq; cursor unaffected |
| INV-13 | Read path never mutates rows | Holds | No insert/update/delete in read fns | mergeMessageRows builds new objects only |
| INV-14 | message content is non-null text | Conditional | DB NOT NULL; route threads validates trim (routes/threads.ts:92-93) | Socket user:message does not validate; undefined content writes undefined locally (JSON key dropped) and would violate PG NOT NULL (MSG-012) |
| INV-15 | mentions is always an array | Holds | :399 `?? []`; local revive `?? []` (message-local-store.ts:33); DB default [] | Arbitrary JSON accepted; no MentionMetadata validation |
| INV-16 | The PG replica counter is >= max sequence in PG after append | Holds when replica leg succeeds | GREATEST upsert (:498-504) | If replica leg fails, counter repair is deferred to outbox replay (workspace-sync repairPgCounter only runs in push, NOT in outbox replay - replayEntry message case does NOT repair the counter; drift possible) (MSG-020) |
| INV-17 | Local sequences.json counter is >= any seq in the local JSONL | Conditional | Bump-first; pull repairs (workspace-sync.ts:371-378); floor bridge | A crash after bump leaves counter ahead (gap) - allowed; a pull-import into a non-empty store is guarded by force; direct file edits are out of scope |
| INV-18 | message:new payload matches ChannelMessage type imported by event-broker | Broken (drift) | event-types.ts:1 imports ChannelMessage; emitted payload is DB row incl. threadId/workspaceId; authorLevel number possible | Declared type narrower than actual payload (MSG-003) |

## Read/merge invariants (display layer)

| ID | Invariant | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| INV-19 | Output is newest-first | Holds | assemblePage reverses back (:349) | Client reverses again to chronological (messagePagination.ts:21-28) |
| INV-20 | Tool-card ids are unique within a page | Broken | `id: tool-${msg.id}` (:101) emitted once per structured call (:171-182) | Multiple structured calls on one row => duplicate ids (MSG-016) |
| INV-21 | Synthetic monologue rows match ChannelMessage shape | Broken | :243-258: string ISO timestamp, authorLevel "3" string, no sequenceNumber, no mentions | Documented gap; downstream relies on defensive mapping (MSG-017) |
| INV-22 | A monologue is attached to at most one final message | Conditional | pendingMonologues per author (:199-224) | Pairing resets per page: a monologue whose final message is on the NEXT page becomes a synthetic row (MSG-004) |
| INV-23 | Legacy tool-result cards pair with the oldest queued input | Holds | queue.shift() (:191-195) | Pairing also page-scoped |
| INV-24 | Merge never drops rows silently | Conditional | All non-monologue rows pass through | Monologue rows WITHOUT toolCalls and without tool-result header only contribute thoughts; if a later final message is absent they surface as synthetic rows - not dropped |

## Security / tenant invariants

| ID | Invariant | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| INV-25 | A caller can only read channels of its own workspace | Broken on REST | routes/messages.ts never compares request.workspaceId to the channel workspace; only the socket path enforces (register-socket-server.ts:551-568) | Cross-workspace read by channel-id knowledge (MSG-007). Local mode single-user; multi-workspace REST callers affected |
| INV-26 | Local files are scoped by owning workspace | Holds | workspaceOfChannel → localStoreDirs; DEFAULT scope fallback | Stale null cache can mis-scope (MSG-011) |
| INV-27 | Socket delivery only to the channel workspace rooms | Holds | payload workspaceId drives rooms (:437-444); join checks (§30) | Depends on append stamping workspaceId correctly (MSG-011) |

## Operational invariants

| ID | Invariant | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| INV-28 | Outbox replay is idempotent by id | Holds | workspace-sync.ts:445-450 insert-ignore by id | Poison entries dropped with log (:503-507); counter repair not included (MSG-020) |
| INV-29 | Outbox drain runs only where a DB is reachable | Holds | drainOutbox checks tier=dual (:471-475); conflict quarantine (:478-484) | API-only timer; worker mode suppressed (create-app.ts:391-396) |
| INV-30 | Local tier is safe for concurrent writes within one process | Holds | per-file promise-chain mutex (local-file.ts:260-267) | Multi-process writers race (documented ceiling) |
| INV-31 | A local append never blocks on PG | Holds | PG leg after local commit; catch swallows | Error surfaced only via console.warn |
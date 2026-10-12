# Threads and sub-conversations
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
A channel sometimes needs a side conversation anchored to one message without forking the channel, so threads provide ephemeral, TTL-bound sub-conversations with their own sequencing and counters. This doc covers system design only — message authoring, broadcast, and any temporal timeline behavior belong to later flow docs.

## Architectural decision
Threads default to ephemeral with a 24h TTL, and only ephemeral threads with `ttlHours > 0` get an `expiresAt` — expiry is opt-out at creation and the sweep only ever sees rows that opted in [Observed]. Thread + sequence-counter rows are created in one transaction, so a crash can never leave a thread without its counter [Observed]. Expected domain outcomes use `{ error }` / `{ notFound }` unions; storage and traversal failures propagate to callers [Observed]. Reply insertion goes through `messageGate.append` (thread-sequence branch), keeping allocation, insert, and broadcast in one owned block [Observed].

## How it works
`create` always validates the channel and, when a parent is given, requires it to exist in the same channel (`{ error }` otherwise); it computes `expiresAt` from the TTL rules and inserts the `threads` row plus its `threadSequences` row (`lastSeq: 0`) in one transaction. `get` is a single lookup; `list` filters `active` by default (or all with `includeArchived`), paginating by `(lastActivityAt, id)` keyset with a numeric-offset fallback for legacy cursors, newest-first. `update` stamps `archivedAt` on `archived`; missing ids return `{ notFound }` on update/delete. Replies are posted by the route via `messageGate.append`: validate non-empty content, append the `messages` row with `threadId` (thread-sequence branch, emits `message:new`), then bump the counter. `getMessages` parses the `timestamp;seq` cursor tolerantly (garbage → head read), over-fetches by one newest-first to compute `hasMore`, then returns the page oldest-first with `nextCursor` only when more remain. `incrementCount` atomically bumps `messageCount` and refreshes activity after the append. The Local expiry sweep traverses every channel page and propagates channel or file-store failures instead of returning a partial count; DB mode bulk-updates stale actives to `expired` in one statement behind a rate-limited endpoint.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Threads.md> | Owns `threads`/`thread_sequences` rows, keyset listing, thread-scoped reads, count bump, TTL sweep |
| <../Domain Spec/Messages.md> | Sole owner of `messages` rows and channel-history merging; thread replies are `messages` rows with `threadId` set, written via `messageGate.append` |
| <../Domain Spec/Channels.md> | Owns `channels` rows, read here only for existence validation |

## Current state
Real: transactional thread + sequence bootstrap, ephemeral-by-default TTL, gate-owned reply append (`messageGate.append`), keyset thread listing, `{ error }`/`{ notFound }` unions, thread-scoped message reads, single-statement expiry sweep. Flag-gated: none. Stub: none. Legacy: numeric-offset cursor fallback only.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* rootMessageId is honored or removed. Voided existingThread fetch is forbidden.
* messages.threadId FK delete rule is explicit. Status machine is guarded with expiresAt bookkeeping.
* Thread lifecycle emits broker events for live clients. Cursor wire formats are explicit versioned contracts with tests. Authority: Threads standard.
## Open gaps
- `createThread` fetches `existingThread` for the parent but voids it — `rootMessageId` is always just `parentMessageId`, so reply-in-thread nesting beyond one level is unverified.
- `messages.threadId` FK behavior on thread delete (cascade vs set-null vs restrict) is unverified — whether `delete` orphans, cascades, or is blocked by replies is unknown.
- `update` accepts any status transition including direct `→ expired` with no `expiresAt` bookkeeping — sweep consistency for manually-expired rows unverified.
- No socket/broker events for thread create/update/archive — clients learn lifecycle only by polling; only message posts emit.
- No in-domain tests observed; the cursor wire formats (`ISO;id`, `timestamp;seq`) are implicit contracts shared with the route file.

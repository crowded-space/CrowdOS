# Message history
> Type: Feature · Status: aligned · Updated: 2026-10-07

## Intent
Clients need scrollable channel history where internal agent reasoning renders as readable cards, not raw monologue rows. This feature exists to serve one ordered page plus a cursor for the next-older page: a read-only keyset fetch over `messages`, merged so tool calls, tool results, thoughts, and in-flight reasoning appear as display cards and attachments in a single newest-first list.

## Architectural decision
The domain is read-only by construction — zero inserts/updates/deletes — because history has many concurrent writers but exactly one read path, keeping merge logic single-sourced [Observed]. Keyset over `(timestamp, sequenceNumber)` instead of offset, so concurrent inserts during scroll neither duplicate nor skip rows [Observed]. `limit + 1` probe with the cursor derived from the oldest fetched row, so `hasMore` and the next cursor come from one query with no count [Observed]. Pairing runs chronologically while the page fetches newest-first, because monologue→response and tool-call→result pairing only resolve forward in time [Observed]. Legacy `🛠️ [Tool Result:]` header parsing is retained alongside structured `toolCalls`, so rows predating structured storage still render as cards [Observed]. Unattached trailing monologues become synthetic `*Reasoning completed*` rows, so in-flight reasoning with no final response yet stays visible [Observed]. `includeMonologue` was removed from the validator/route/service surface; no monologue filter exists [Inferred].

## How it works
`GET /api/channels/:channelId/messages` validates params/query (`channelId` min 1, `limit` coerced 1–200, `before` opaque), parses `before` as `<ISO timestamp>;<sequenceNumber>` (split on last `;`; malformed → `MalformedCursorError` → HTTP 400), and forwards `{ limit, before, db }`. `getChannelMessagesPage` clamps limit (default 50, max 200), builds a channel-only or `(timestamp, seq) < before` tuple filter, fetches newest-first via `(timestamp DESC, sequenceNumber DESC)` with `limit + 1`, then reverses to chronological for pairing and reverses the merged list back to newest-first for output. Boundary context (MSG-004): cursor pages additionally fetch the ONE row immediately newer than the page head, and the limit+1 older probe row is passed in as older context, so a monologue/final pair split at a page edge pairs through the boundary instead of surfacing as a misplaced synthetic; boundary seeds are never emitted, and a newer-context agent final consumes its author's pending monologue. Merging: monologue rows with a `toolCalls` array emit one `tool_execution` card per entry (`id: tool-<msgId>`, success unless output starts with `"Error:"`); legacy `🛠️ [Tool Result: <name>]` rows consume the oldest queued input for that author+tool into zero-duration cards; other monologue rows feed per-author pending thoughts and queue parsed `tool(name, input)` calls; normal rows attach pending monologue as `metadata.monologue` (agents only) and clear the slot; leftover pending monologues become synthetic `monologue-<agentId>` rows. The cursor encodes the oldest fetched row's `(timestamp, seq)` when `hasMore`, else `null` (empty pages → `{ messages: [], cursor: null }`; unknown channel → empty page, never 404). `getChannelMessages` was removed; only `getChannelMessagesPage` remains.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Messages.md> | Owns the keyset page fetch, cursor parsing, and the monologue-merge engine; writes nothing |
| <../Domain Spec/Channels.md> | Owns `channels` rows; history is always scoped to one channel id |
| <../Domain Spec/EventBroker.md> | Owns live delivery (`message:new`) — this feature covers history reads only, not fan-out |
| <../Domain Spec/Events.md> | Owns the §29 event log and `GET /api/events/recent` — the event-first view of the same turns (catch-up), separate from this keyset history read |

## Current state
Real: keyset pagination over `(timestamp, sequenceNumber)`, `limit + 1` probe, typed `MalformedCursorError` → 400, structured tool cards, legacy tool-result pairing, thought attachment, synthetic trailing-monologue rows, newest-first output with strictly-older cursors. Legacy: none (`getChannelMessages` removed). Flag-gated: none. Stub: none.

## Alignment notes
- 2026-09-21 (§29 local event log): `GET /api/events/recent` is no longer a no-op and is owned by the new Events domain, not by this feature. Message history stays the authoritative read of `messages`; the event log is an independent, event-first record of the same activity. The two can disagree by design — a message written without a broker emits no event (see Events → Gaps), so a client must treat history as truth for content and the event log as a catch-up signal.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Single-writer appendMessage with sequence plus insert in one transaction then message:new stays. Direct writes outside it are forbidden except labeled seeds.
* Keyset over timestamp plus sequenceNumber with limit-plus-1 probe stays. Offset pagination is forbidden.
* Malformed cursors throw MalformedCursorError to HTTP 400. Silent head-read fallback is forbidden.
* Merge uses a discriminated message type, never any[]. Tool cards have unique IDs per call. Removed: `includeMonologue` no longer exists in the validator/route/service surface.
* Authority: Messages standard.
## Open gaps
- `includeMonologue` was removed from gate, validator, route, and merge — there is no monologue filter to exclude with.
- Multiple structured tool calls on one row all emit `id: tool-<sameMsgId>` — duplicate card ids per page; client keying impact unverified.
- Legacy-matched cards hardcode `durationMs: 0` — indistinguishable from genuinely instant calls.
- Synthetic leftover rows use string ISO timestamps (vs `Date`), generic `Agent Swarm`/`3` authorship, and the request's `channelId` — shape drift vs `ChannelMessage` unverified downstream.
- `ChannelMessagesPage.messages` is `any[]` — merged cards, thought-attached messages, and synthetic rows share no discriminated type.
- `MAX_PAGE_LIMIT` (200) is enforced in the service but not exported via the gate.
- MSG-004 boundary pairing is single-row per side: pairs separated by tool rows or multiple monologue iterations across a page edge can still surface a synthetic or a bare final (multi-row continuity needs cursor-carried pairing state).
- MSG-001 replica uniqueness depends on migration 0025 (`messages_channel_thread_sequence_idx`) being applied; before that, channel/thread seq overlaps surface as replica-leg failures routed to outbox replay instead of silent drops.
- getChannelMessages` was removed; no shim callers can exist.
- Unprovisioned tenant schema (stale BYODB, 42P01/42703) serves the message page from the local tier instead of 500 via `isSchemaMismatchError` fallback on the explicit-handle path (2026-10-08); PG gap-fill degrades the same way through `withStoreFallback`.

# Reconnect digest flow
> Type: Flow · Status: aligned · Updated: 2026-10-04
## Intent
Survive a dropped socket without losing history: show offline state, replay the missed gap on reconnect, summarize it, then resume live render.
## Architectural decision
- [Observed] Gap replay is REST-based (`/api/events/recent?afterSeq`), not socket backlog — reconnect fetches what the seq cursor missed (`crowdOsStore.ts:589-595`). The endpoint serves the server's §29 local event log (append-only, per channel) and is no longer a no-op: as of 2026-09-21 it returns real events ordered ascending by `seq`, with `afterSeq` exclusive.
- [Observed] The digest banner is summary-only; missed `message:new` payloads are merged into state separately, so the banner can auto-clear without losing data (`crowdOsStore.ts:623-645`).
- [Observed] A module-level `wasDisconnected` flag gates gap-fetch so a first connect only rejoins, while a post-drop connect replays (`crowdOsStore.ts:569,656-663`).
- [Observed] The persistent degraded-state strip carries one recovery action: socket/browser loss retries `socket.connect()`; database-degraded local mode opens the workspace settings overview.
## How it works
1. Disconnect: socket `disconnect` sets `wasDisconnected = true` and shows an "Offline — reconnecting…" banner (`crowdOsStore.ts:667-671`); `connect_error` shows a retrying banner (`crowdOsStore.ts:672-674`).
2. Reconnect: socket auto-reconnects same-origin with 1 s → 5 s backoff and rejoins the persisted channel on every `connect` (`src/config/socket.ts:16-28,98-105`).
3. Replay gap: on `connect` after a disconnect, the store reads the per-channel seq cursor and calls `fetchGapAndDigest(activeCh, afterSeq)` before rejoining (`crowdOsStore.ts:656-659`).
4. Merge: gap events persist seq per event, dedupe `message:new` payloads by id into `messages`, and cap/persist the mirror (`crowdOsStore.ts:600-633`).
5. Digest: run completions/failures and new-message counts compose a "While you were away: …" banner that auto-clears after ~9 s (`crowdOsStore.ts:634-646`).
6. Resume render: `MainChatArea` toasts the digest on visibility and renders the inline banner until cleared (`MainChatArea.tsx:54,149-151,778-788`); channel switches also gap-fetch on entry when a cursor exists (`crowdOsStore.ts:2483-2488`).
6. Resume render: `MainChatArea` fires a `Connection update` toast carrying the digest message and renders the inline banner with a named `Dismiss connection notice` control until cleared (`MainChatArea.tsx:149-152,789-799`); channel switches also gap-fetch on entry when a cursor exists (`crowdOsStore.ts:2483-2488`).
7. Manual recovery: `OfflineBanner.tsx` uses connectivity state to show either Retry connection (calls `socket.connect()` while disconnected) or Database settings (opens settings overview via `App.tsx`); Retry and Dismiss are distinct — Retry re-handshakes, Dismiss only clears the viewed notice.

## What the server guarantees on replay
- `afterSeq` is exclusive and the returned events are ascending by `seq`.
- `lastSeq` is the highest seq returned, or the channel's current head when nothing is after `afterSeq` — so a caught-up client sees `events: []` plus a head and can distinguish "nothing missed" from "no log".
- An absent log answers `events: []` with `lastSeq: 0`; the server never fabricates an event.
- Streaming chunks (`message:stream`) are never in the log (they are ephemeral), so replay only ever contains durable state transitions — a missed stream is recovered from the final `message:new`, not from the gap.
- The event `seq` space is independent of the message `sequenceNumber` space. The store's single per-channel cursor is advanced by both, which is safe in the direction that matters (a message-derived cursor under-selects and replay re-delivers, deduped by message id) but is the flow's known weak point — see Open gaps.
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Stores.md> | Owns seq cursors, `fetchGapAndDigest`, digest banner state, and message merge |
| <../Domain Spec/Client Infra.md> | Owns socket singleton, reconnect backoff, and debounced `channel:join` rejoin |
## Current state
Disconnect/degraded strip with recovery action → backoff or manual reconnect → seq-based gap fetch → deduped merge → timed digest → resume render matches the area docs.
## Alignment notes
- 2026-10-04 Phase E: `flushOutbox` runs after gap replay on reconnect (replayed history lands first; fresh connects flush too so restart-queued rows never wait a full disconnect cycle) (`crowdOsStore.ts:964-970`); outbox rows emit via the existing `user:message` transport in `queuedAt` order, idempotent by entry id, emit failure marks the row `failed` (never silent loss). Composer keeps its text (will-send copy). Honest pending marker: no unread divider is rendered on reconnect (store keeps no last-read anchor — see Message rendering). Offline `queueSend` entry point lives in `MainChatArea.tsx:562-576`.
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Gap replay stays REST-based via /api/events/recent?afterSeq, never socket backlog. wasDisconnected gates gap-fetch: first connect only rejoins, post-drop replays.
* Digest banner stays summary-only with message:new merged separately. Banner auto-clear never loses data.
* Digest covers run status plus message:new; presence, approvals, artifacts have an explicit replay-or-live contract. Silent gap loss is forbidden.
* reconnectDigest persists across reload or is explicitly in-memory-only with a documented loss window.
* Empty-gap reconnect has an explicit silent-resume contract. Channel-switch gap-fetch stays. Authority: Stores, Client Infra area docs.
* The persistent degraded-state strip always exposes one context-appropriate recovery action: retry for connectivity loss, settings for database-degraded local mode. Actionless persistent warnings are forbidden. Authority: Workspace Shell area doc.
## Open gaps
- Digest covers only run status + `message:new`; other gap event types (presence, approvals, artifacts) replay through live handlers or not at all — unverified which survive a gap.
- `reconnectDigest` is in-memory only; a reload during an outage loses the banner despite the storage taxonomy reserving it.
- Empty-gap reconnects (no missed events) show no confirmation — silent resume is by design but unverified as intent.
- **Single cursor across two seq spaces (server-side limitation).** The store keeps one `channelSeq` per channel (`crowdOsStore.ts:571-579`) fed by both the message `sequenceNumber` (channel-switch refetch, `crowdOsStore.ts:2476-2477`) and the event `seq` (gap results, `crowdOsStore.ts:601`). Because every message emits a logged `message:new`, the event space advances at least as fast as the message space, so a message-derived cursor under-selects and replay over-delivers (deduped by id). It is not symmetric: `persistSeq` never lowers a cursor, so an event-derived value cannot be pulled back by a later message-space head. Fixing this needs a per-space cursor pair in the store (client) or one shared ordering (server) — not a backend-only change.
- A message persisted without a broker (seed, backfill, or the explicit `db`/`tx` append path) emits no event and therefore leaves no entry in the log; the reconnect gap cannot see it. The channel-switch message refetch is what recovers those rows.
- The log has no retention, so a very long disconnect replays an unbounded tail; the store's `limit=100` per call bounds a single response but the flow has no loop that pages through a longer gap.

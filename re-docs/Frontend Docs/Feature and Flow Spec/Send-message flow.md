# Send-message flow
> Type: Flow · Status: aligned · Updated: 2026-10-04
## Intent
Take composer input to a persisted, streamed agent response with minimal latency and no lost history.
## Architectural decision
- [Observed] Send reads mode from the store at send-time to avoid stale closures after mode switches.
- [Observed] Streaming chunks coalesce to ≤32 ms cadence into virtual `stream-<agentId>` messages, replaced by the final `message:new` (`crowdOsStore.ts:698-784,793-873`).
- [Observed] Message mirror capped at 200 per channel; seq cursors persist debounced (~500 ms) (`messagePagination.ts:15`, `crowdOsStore.ts:99-116,225-246`).
## How it works
1. Compose: `MainChatArea.tsx:438-459` builds content + mentions + attachments, capping text at 4000 chars and attachments at 5 MB / 10 per message; Enter sends and Shift+Enter inserts a newline. 2026-10-04 Phase E: per-channel draft restore on channel switch + 500 ms debounced `setDraft` persist (text + mentionIds + runtime + display-only mount snapshot; attachments stay local) (`MainChatArea.tsx:239-271`, store `crowdos_drafts` mirror `crowdOsStore.ts:249-300,3934-3963`).
2. Offline queue: when `navigator.onLine === false`, `handleSend` calls `queueSend` (synchronous `crowdos_outbox` write-through, will-send copy kept in the composer) instead of emitting (`MainChatArea.tsx:562-576`, `crowdOsStore.ts:3965-3989`); `flushOutbox` runs after gap replay on reconnect in `queuedAt` order via the existing `user:message` transport (`crowdOsStore.ts:964-970,3990-4015`).
3. Follow-up scope: while a run is active the composer shows an Applies-to toggle (`appliesTo` current/next, default next) choosing whether the next send targets the in-flight run or the next turn (`MainChatArea.tsx:1540-1558`, store `crowdOsStore.ts:4027-4033`).
4. Store action: `addMessage` records the user message (`user-01` / `Juan Hamzah`), clears the composer, refocuses (`MainChatArea.tsx:466-486`).
5. Emit: store sends `user:message` over the shared socket (`stores/crowdOsStore.ts:2532`).
6. Stream render: `message:stream` chunks update the virtual message; streaming pins instantly while completed messages smooth-scroll (`MainChatArea.tsx:342-369`).
7. Persist: final `message:new` replaces the virtual message; mirror and seq cursors persist per channel (`crowdOsStore.ts:793-873,99-116,225-246`).
8. Reconnect safety: `connect` after disconnect triggers gap-fetch plus a digest banner, then `flushOutbox`; socket rejoins the persisted channel on every connect (`src/config/socket.ts:98-105`).
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Chat Area.md> | Owns composer, stream rendering, and scroll/paging UX |
| <../Domain Spec/Stores.md> | Owns `addMessage`, socket ingestion, mirror caps, and gap-fetch |
| <../Domain Spec/Client Infra.md> | Owns socket singleton, PIN header injection, and reconnect backoff |
## Current state
Composer → store action → socket emit → stream render → persist matches all three area docs. PIN rides the global fetch patch; socket auto-connects same-origin with 1 s → 5 s backoff.
## Alignment notes
- 2026-10-04 Phase E composer slice: per-channel drafts (`crowdos_drafts`), offline outbox (`crowdos_outbox` + `flushOutbox` after gap replay), and the Applies-to follow-up toggle landed; area-doc authority stays in Chat Area (composer) + Stores (slices/mirrors).
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Send reads mode at send-time to avoid stale closures. Streaming coalesces to 32ms cadence into virtual stream-agentId replaced by final message:new.
* Message mirror stays capped at 200 per channel with seq cursors persisted debounced. Socket rejoins persisted channel on every connect with gap-fetch plus digest.
* Sender identity is server-resolved. Hardcoded user-01 and Juan Hamzah identity is forbidden in production paths.
* Attachments are bounded with upload progress plus server persistence. Unbounded in-memory data-URL growth is forbidden.
* Edit-resend plus regenerate share the emit with traced contracts. PIN rides the canonical path; socket auto-connects same-origin with backoff. Authority: Chat Area, Stores, Client Infra area docs; Messages, Runtime standards.
## Open gaps
- Sender identity hardcoded (`user-01` / `Juan Hamzah`); no real auth attribution.
- Attachment data URLs live in memory; no upload progress or server persistence observed.
- Edit-resend and regenerate paths (`crowdOsStore.ts:3437,3462`) share the emit but are not traced here.

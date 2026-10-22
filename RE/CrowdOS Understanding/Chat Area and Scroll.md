# Chat Area and Scroll

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding of the channel message stream and its scroll system. Canonical CrowdOS documentation remains `re-docs/Frontend Docs/` (Domain Spec `Chat Area.md`, Feature and Flow Spec `Message rendering.md`); this file records what the code does today, for side-by-side comparison with the RE corpus.

## Purpose

Describe how the center chat column renders a channel's transcript and how it behaves under streaming, scrolling and history paging: the channel header's owned actions, the scroll container's contract, the follow/pin decision, the pagination cursor, the streaming coalescer, the message router and its per-type renderers, and what the surface deliberately does not do.

## How it works

`MainChatArea.tsx` is a single component that owns the header, the scroll container, the run/checkpoint/diff injections, the composer and the sandbox panel chrome. It reads the whole store through one `useCrowdOSStore()` call with no selector (`MainChatArea.tsx:92-123`), and every store change re-evaluates that subscription.

The stream container is the single scroll box of the column (`MainChatArea.tsx:1043-1052`): `overflow-y-auto`, `paddingBottom: 96` so the last line clears the composer, `overscroll-contain` so the wheel does not chain to the page, `contain-paint` so the stream's repaints stay inside it, and `style={{ overflowAnchor: 'auto' }}` so the browser's native anchoring is left ON (Discord disables it — see Comparison hooks).

Follow mode is a three-state contract owned by `use-stick-to-bottom.ts`:

| State | Meaning | Owner |
|---|---|---|
| following | new rows and tokens pin the container to the bottom | `followStream()` (`use-stick-to-bottom.ts:30-32`) |
| user-scrolled-up | incoming rows never move the viewport; a missed counter accrues | `onUserScrollIntent()` (`use-stick-to-bottom.ts:35-41`) |
| resumed | an explicit user jump re-pins with a smooth scroll | `resume()` (`use-stick-to-bottom.ts:45-49`) |

User intent is read from **wheel and touch only** (`use-stick-to-bottom.ts:56-59`). The `scroll` event also fires for the app's own programmatic pins, so treating it as intent would cancel follow mode on every token flush. The `scroll` listener is therefore used only to drive upward paging, rAF-throttled (`MainChatArea.tsx:452-459`).

"Near bottom" is a plain geometry comparison — `scrollHeight - scrollTop - clientHeight < 80` (`use-stick-to-bottom.ts:9-11`, `STREAM_NEAR_BOTTOM_PX = 80`). There is no `IntersectionObserver` and no sentinel element.

History paging is keyset-based and upward-only: the store holds one `PageCursor` per channel in `channelCursors` (`crowdOsStore.ts:613`), the initial page is fetched by `setActiveChannel` (`crowdOsStore.ts:2906-2918`), and `loadOlderMessages` requests `GET /api/channels/:id/messages?before=<timestamp>;<seq>` (`crowdOsStore.ts:2940-2967`, `messagePagination.ts:17-19`).

Streaming arrives on the socket as `message:stream` chunks (`crowdOsStore.ts:1194-1239`). Chunks are appended to a per-agent buffer, and the visible row is updated by a coalescer that fires at most every 32 ms and performs exactly one Zustand write per flush (`crowdOsStore.ts:1017-1103`).

Message rendering is a single router keyed on `message.type` with six types (`MessageRouter.tsx:17-233`), wrapped in `React.memo` so unrelated store writes do not re-render history (`MessageRouter.tsx:235-237`).

## Structural inventory

| Component | File:line | Role | Key state |
|---|---|---|---|
| Channel header | `MainChatArea.tsx:860-1005` | Channel identity + owned actions | `rightPanelView`, `notificationBadge`, `isSwarmActive`, `confirmClearOpen` |
| Workspace-menu trigger | `MainChatArea.tsx:879-887` | Opens the off-canvas nav below `xl` | `onOpenSidebar` prop |
| Search trigger | `MainChatArea.tsx:890-898` | Opens the omni-search modal | `onOpenSearch` prop |
| Clear-logs trigger | `MainChatArea.tsx:901-910` | Arms the clear-history confirm | `currentMessages.length > 0` |
| Run Stop (header) | `MainChatArea.tsx:912-923` | Cancels the active run | `cancellingByAgent` |
| Notification trigger | `MainChatArea.tsx:926-938` | Opens the notification centre | `useNotificationCenterBadge()` |
| Right-panel tab strip | `MainChatArea.tsx:942-1003` | 5 tabs bound to the `rightPanelView` enum | `roster\|repo\|jobs\|telemetry\|browser` |
| Stream container | `MainChatArea.tsx:1043-1052` | The only scroll box in the column | `scrollContainerRef`, `overflowAnchor:'auto'`, `paddingBottom:96` |
| Sticky run header | `MainChatArea.tsx:1053-1057` | Active-run header, survives scroll | `activeRunId` |
| Reconnect digest | `MainChatArea.tsx:1058-1068` | Offline/reconnect notice with dismiss | `reconnectDigest` |
| Older-page loader line | `MainChatArea.tsx:1069-1073` | Honest loading state for upward paging | `isLoadingOlder` |
| Pending approval cards | `MainChatArea.tsx:1074-1076` | Approvals render above the transcript | `approvalRequests` (pending) |
| Checkpoint + diff injection | `MainChatArea.tsx:1077-1108` | Latest run's diff, gated to Coding/Swarm | `runRuntimeByRun`, `artifactsByRun` |
| Run cards | `MainChatArea.tsx:1109-1127` | One compact index card per run | `metadata.runId` scan |
| `renderedMessages` | `MainChatArea.tsx:701-847` | Folds tools, groups bursts, inserts dividers | `currentMessages`, `agents` |
| Date divider | `MainChatArea.tsx:55-66` | `role="separator"` on honest day change | `dayKeyForTimestamp` (`:35-43`) |
| Unread divider | `MainChatArea.tsx:73-84` | **Defined but never rendered** | no last-read anchor exists |
| Jump-to-present pill | `MainChatArea.tsx:1232-1248` | Carries the missed count, resumes follow | `isUserScrolledUp`, `missedCount` |
| `useStickToBottom` | `messages/use-stick-to-bottom.ts:18-61` | Follow/pin decision + scroll container ref | `userScrolledAwayRef`, `isAtBottom` |
| `maybeLoadOlder` | `MainChatArea.tsx:435-447` | Upward paging + manual re-anchor | `loadingOlderRef`, `hasOlder` |
| Follow effect | `MainChatArea.tsx:464-480` | Pins on growth, accrues missed count | `lastMessageCountRef`, `firstMsgIdRef` |
| `MessageRouter` | `messages/MessageRouter.tsx:17-237` | Fans out to six message renderers | `message.type`, `message.metadata.subtype` |
| `HumanMessage` | `messages/HumanMessage.tsx:21-121` | Operator bubble: edit+resend, provenance link | `editing`, `editedFrom`, `originalMessageId` |
| `AgentMessage` | `messages/AgentMessage.tsx:28-362` | Agent bubble: level, runtime, monologue, tools | `turnStatus`, `toolExecutions`, `turnSteps` |
| `MentionParser` / `StreamingMention` | `messages/MentionParser.tsx:242-268` | Markdown-lite renderer; memoized stream blocks | `splitStreamBlocks`, `mentionRegex` |
| `AttachmentsView` | `messages/AttachmentsView.tsx:36-151` | Attachment grid + lightbox | `lightboxImage` |
| `splitStreamBlocks` | `messages/streaming-blocks.ts:39-57` | Fence-aware splitter for streaming markdown | `completed[]`, `pending`, `pendingIsCode` |
| `loadOlderMessages` | `crowdOsStore.ts:2940-2967` | Keyset page fetch + prepend | `channelCursors[channelId]` |
| `parseMessagesEnvelope` | `messagePagination.ts:21-28` | Reverses newest-first to chronological | `cursor` |
| `capMessagesMirror` | `messagePagination.ts:36-56` | 200-message-per-channel local mirror cap | `MESSAGE_MIRROR_CAP_PER_CHANNEL` |

## Implementation details

**The follow/pin split.** `followStream()` calls `scrollToBottom('instant')` only while `userScrolledAwayRef` is false (`use-stick-to-bottom.ts:30-32`). `instant` is used for every automatic pin because `smooth` animations would stack at token rate; `smooth` is reserved for `resume()`, which is always user-triggered (new assistant message, send, channel switch, "Jump to present") (`use-stick-to-bottom.ts:43-49`).

**Missed count.** When the user is scrolled up and the row count grows, the counter increments and is clamped at 99 (`MainChatArea.tsx:477-479`). The "Jump to present" pill is rendered only while `isUserScrolledUp` is true and shows the count in place of its icon when the count is non-zero (`MainChatArea.tsx:1232-1248`).

**Prepend detection.** The follow effect compares the first message id before and after the change. A changed first id with a grown count means a history page was prepended; the effect returns early so prepending never triggers jump-to-bottom and never increments the missed count (`MainChatArea.tsx:464-480`). Viewport stability is handled separately: `maybeLoadOlder` records `scrollHeight` before the fetch and afterwards applies `scrollTop += el.scrollHeight - prevHeight` (`MainChatArea.tsx:440-443`).

**Upward paging trigger.** `maybeLoadOlder` runs when `scrollTop <= 160` and a cursor exists, guarded by a local `loadingOlderRef` and the store's `isLoadingOlder` flag so two loads cannot overlap (`MainChatArea.tsx:435-447`, `crowdOsStore.ts:2942-2946`).

**Pagination shape.** The server returns a newest-first array plus a cursor; `parseMessagesEnvelope` reverses it to chronological (`messagePagination.ts:21-28`). `prependOlderMessages` filters by existing ids, so a re-fetched page cannot duplicate rows (`messagePagination.ts:30-34`). The local mirror is capped at 200 messages per channel, keeping the newest 200 by timestamp (`messagePagination.ts:15`, `:36-56`).

**Streaming coalescing.** `scheduleStreamFlush` records the agent in a dirty set and schedules one `setTimeout(32ms)` that then queues a `requestAnimationFrame` (`crowdOsStore.ts:1092-1103`). `flushStreamCoalesced` performs one `set()` for all dirty agents; inside it, an existing `stream-${agentId}` row is **mutated in place** (new content + monologue) rather than replaced, so React sees a stable row identity (`crowdOsStore.ts:1029-1090`, `:1039-1048`). A pending tool call is coalesced into a parallel `stream-tool-${agentId}` row (`crowdOsStore.ts:1064-1086`).

**Late-chunk guard.** When the final message arrives, `message:new` deletes the agent's parser, removes it from the dirty set and stamps `lastTurnFinishedAt` (`crowdOsStore.ts:1120-1128`). A `message:stream` chunk arriving within 2 s of that stamp, with no live parser, is dropped (`crowdOsStore.ts:1203-1207`).

**Final replacement.** `message:new` removes both `stream-${authorId}` and `stream-tool-${authorId}` rows and appends the final message (`crowdOsStore.ts:1156-1163`).

**Memoized stream blocks.** `splitStreamBlocks` splits markdown into completed blocks plus one pending tail; splitting respects code fences, so blank lines inside a closed fence do not split a block, and an unclosed fence stays inside the pending block (`streaming-blocks.ts:13-57`). `StreamingMention` renders each completed block through a `memo`-wrapped `CompletedStreamBlock` keyed by `index-length`, so only the pending tail re-renders per flush (`MentionParser.tsx:233-268`).

**Tool-call folding.** `renderedMessages` folds a `tool_execution` message into the last agent bubble by the same author (forward case), or queues it for the next agent bubble by that author (backward case) (`MainChatArea.tsx:706-729`). A pending queue that is interrupted by a non-agent, non-tool row is flushed as standalone rows (`MainChatArea.tsx:731-754`). The orphan rows carry a generated id of the shape `orphan-tool-<authorId>-<Date.now()>-<random>` and, when flushed at the end of the list, a **fabricated** `new Date().toISOString()` timestamp (`MainChatArea.tsx:759-774`).

**Burst grouping.** Two consecutive rows group when the author matches, the day does not change, the gap is under 300 s, and neither row is a stream row, a monologue row, a tool row, a system/delegation/governance row, an attachment row, or a row carrying folded tools (`MainChatArea.tsx:799-817`). Grouped rows render inline through `MentionParser` with a reduced row shell (`MainChatArea.tsx:821-834`).

**Dividers.** `DateDivider` renders on an honest day change derived from the real `message.timestamp` (`MainChatArea.tsx:35-53`, `:787-795`). Orphan tool rows never open a divider because their timestamp is fabricated (`MainChatArea.tsx:787`). `UnreadDivider` is defined with a comment but **never rendered**: `setActiveChannel` zeroes `unreadCount` without recording a last-read message id, and `unreadCount` is a count with no position, so drawing a marker would fabricate one (`MainChatArea.tsx:68-84`).

**Per-type rendering.** `HumanMessage` exposes an inline edit textarea with Save & Resend calling `editResend(id, draft)`, an "edited from earlier message" link that is rendered only when a real source id exists, and a hover/focus toolbar carrying the edit action (`HumanMessage.tsx:27-31`, `:36-49`, `:107-118`). `AgentMessage` derives a level badge from `level` (L0–L3), a runtime badge from `metadata.runtimeType|metadata.runtime`, a "Working" pulse while streaming, "Cancelled" and "Turn failed" badges, a per-message Stop that calls `cancelRun(channelId, authorId)`, a collapsible monologue, and a collapsible tool container that aggregates `turnSteps` tool calls plus folded tool executions (`AgentMessage.tsx:43-52`, `:85-90`, `:175-204`, `:209-229`, `:257-316`). "Regenerate — same context" and "Retry — fresh run" are separate labelled actions (`AgentMessage.tsx:318-359`).

**Markdown rendering.** `MentionParser` handles fenced code blocks with a 20-line collapse and copy, inline code, bold/italic/strike, tables and lists (`MentionParser.tsx:14-17`, `:48-160`, `:270-304`). Secret-pattern spans render through `RedactedText` instead of highlighted HTML, so raw secret values never enter `dangerouslySetInnerHTML` (`MentionParser.tsx:59-64`, `:119-128`). Highlighted code comes from `highlight.js` via `workspace/code-highlight.ts` (`MentionParser.tsx:5`, `:58`).

**Channel switch.** The effect on `activeChannelId` clears the open run-thread drawer, zeroes the missed count and calls `resume()` (`MainChatArea.tsx:849-854`). No per-channel scroll offset is stored anywhere: the new channel always opens pinned to the latest message, and the previous channel's viewport position is not restored on return.

## Interaction model

| Trigger | Effect | Source |
|---|---|---|
| New row while following | instant container pin to the bottom | `MainChatArea.tsx:475-476` |
| New row while scrolled up | missed count +1 (cap 99); viewport unmoved | `MainChatArea.tsx:477-479` |
| Wheel / touch move | re-evaluates near-bottom and updates follow state | `use-stick-to-bottom.ts:35-41` |
| Click "Jump to present" | zeroes the missed count and resumes with a smooth scroll | `MainChatArea.tsx:1235` |
| Scroll to `scrollTop <= 160` | fetches the previous page and re-anchors the viewport | `MainChatArea.tsx:435-447` |
| Prepend detected (first id changed) | no pin, no missed count | `MainChatArea.tsx:471-473` |
| Channel switch | closes the run thread, resets the counter, pins to latest | `MainChatArea.tsx:849-854` |
| Send | `resume()` re-pins so the operator's own message is visible | `MainChatArea.tsx:623-624` |
| Hover / focus a bubble | reveals the per-row action toolbar | `HumanMessage.tsx:108`, `AgentMessage.tsx:334` |
| Click "edited from" link | scrolls the original row into view | `HumanMessage.tsx:39-49` |
| Click a per-message Stop | cancels that agent's turn | `AgentMessage.tsx:193-204` |

## Performance notes

- **No virtualization.** `packages/client/package.json` declares no windowing dependency (`react-window`, `react-virtuoso`, `virtua` are all absent), and `renderedMessages` materialises every row of the active channel (`MainChatArea.tsx:701-847`). This violates the locked budget at `UX_GUIDELINE.md:167` — "virtualize past 500 channels / 2,000 messages". The Discord corpus reached the same verdict for its own chat list, so the gap is shared, not Discord-specific.
- **Whole-store subscription.** `useCrowdOSStore()` is called without a selector (`MainChatArea.tsx:92-123`), so any store slice change re-runs the component body. Two narrower subscriptions exist alongside it — `hasOlder` (`MainChatArea.tsx:404`) and `isLoadingOlder` (`MainChatArea.tsx:427`).
- **`renderedMessages` re-memoises on every flush.** Its dependency array is `[currentMessages, agents]` (`MainChatArea.tsx:847`), and `currentMessages` is a new array on every store write, so each 32 ms streaming flush re-runs the folding + grouping pass over the whole channel. The per-row cost is mitigated by `React.memo(MessageRouter)` (`MessageRouter.tsx:237`), but the fold/group pass itself is O(n) per flush.
- **Local mirror cap.** The store keeps at most 200 messages per channel in the local mirror (`messagePagination.ts:15`); older rows are evicted by timestamp, so the rendered list is bounded by what the mirror retains plus the live rows.
- **Streaming cost is bounded by coalescing.** One Zustand write per 32 ms window per flush (`crowdOsStore.ts:1092-1103`) rather than one per token.

## Evidence

| Claim | Pointer |
|---|---|
| Follow threshold 80px, wheel/touch-only intent, instant vs smooth | `packages/client/components/workspace/messages/use-stick-to-bottom.ts:5`, `:9-11`, `:23-49`, `:56-59` |
| Stream container CSS and `overflowAnchor` | `packages/client/components/workspace/MainChatArea.tsx:1043-1052` |
| Prepend detection, missed-count cap, jump-to-present | `MainChatArea.tsx:464-480`, `:1232-1248` |
| Manual re-anchor and paging trigger | `MainChatArea.tsx:435-459` |
| Channel-switch reset | `MainChatArea.tsx:849-854` |
| Tool folding and orphan rows | `MainChatArea.tsx:706-774` |
| Grouping rule and exclusions | `MainChatArea.tsx:799-817` |
| Unread divider deliberately unrendered | `MainChatArea.tsx:68-84` |
| Router's six types and governance subtypes | `packages/client/components/workspace/messages/MessageRouter.tsx:17-233` |
| Streaming coalescer, in-place row mutation, late-chunk guard | `packages/client/stores/crowdOsStore.ts:1017-1103`, `:1039-1048`, `:1203-1207` |
| `message:new` removes the virtual rows | `crowdOsStore.ts:1156-1163` |
| Fence-aware stream splitter | `packages/client/components/workspace/messages/streaming-blocks.ts:13-57` |
| Keyset paging, cursor map, mirror cap | `crowdOsStore.ts:2906-2918`, `:2940-2967`, `packages/client/stores/messagePagination.ts:15-56` |
| Memoized completed blocks | `packages/client/components/workspace/messages/MentionParser.tsx:233-268` |
| No windowing dependency | `packages/client/package.json:15-26` |
| Locked list budget | `UX_GUIDELINE.md:167` |
| Canonical CrowdOS docs | `re-docs/Frontend Docs/Domain Spec/Chat Area.md`; `re-docs/Frontend Docs/Feature and Flow Spec/Message rendering.md` |

## Gaps

- **No virtualization**, against the locked `UX_GUIDELINE.md:167` budget (`packages/client/package.json:15-26`, `MainChatArea.tsx:701-847`).
- **No per-channel scroll position.** A channel switch always pins to the latest message; returning to a channel loses the reading position (`MainChatArea.tsx:849-854`, no persisted offset anywhere in `use-stick-to-bottom.ts`).
- **Orphan tool rows fabricate a timestamp and a random id**, which is why they can never open a date divider and why their identity is unstable across re-renders (`MainChatArea.tsx:741-748`, `:763-770`; `re-docs/Frontend Docs/Domain Spec/Chat Area.md:128`).
- **No honest unread anchor.** `UnreadDivider` is dead code pending a real last-read message id (`MainChatArea.tsx:68-84`; `crowdOsStore.ts:2860-2879`).
- **No list semantics on the stream.** Rows are not `role="listitem"` and the column is not a list, so a screen reader has no structural navigation over the transcript (`MessageRouter.tsx` has no list wrapper).
- **The whole-store subscription** defeats the row-level memoisation on every unrelated store write (`MainChatArea.tsx:92-123`).
- **`renderedMessages` re-runs on every streaming flush** because `currentMessages` changes identity each time (`MainChatArea.tsx:847`).
- **No per-row timestamps on hover.** Timestamps are always rendered in the bubble header (`HumanMessage.tsx:65-67`, `AgentMessage.tsx:152-154`); there is no hover-reveal timestamp variant.
- **No typing indicator.** Nothing in the client emits or renders a typing state (`crowdOsStore.ts` socket handlers; `MessageRouter.tsx` has no typing row type).
- **No reaction affordance.** `MessageType` has no reaction concept (`packages/client/types/crowdOs.ts:27`).

## User Decision:

## Target Contract

> Status: Target. CrowdOS's chat liveness scroll contract is a locked strength (`UX_GUIDELINE.md:177`). Any change to the stream or its scroll system must preserve the invariants below; the Discord corpus is a comparison, not a replacement.

* **Follow mode is decided by wheel/touch intent, never by the `scroll` event.** The `scroll` event also fires for the app's own programmatic pins (`use-stick-to-bottom.ts:13-17`).
* **While the user is scrolled up, incoming messages never move the viewport.** They accrue a missed count and an explicit "Jump to present" affordance carries that count (`MainChatArea.tsx:477-479`, `:1232-1248`).
* **Automatic pins are instant; only an explicit user jump scrolls smoothly** (`use-stick-to-bottom.ts:23-27`, `:45-49`).
* **Prepending older history must not move the visible content**, must not trigger a jump-to-bottom, and must not increment the missed count (`MainChatArea.tsx:464-480`).
* **Upward paging is proximity-triggered and re-entrancy guarded** (`scrollTop <= 160`, `loadingOlderRef` + `isLoadingOlder`) (`MainChatArea.tsx:435-447`).
* **A date divider may only be drawn from a real message timestamp.** Fabricated timestamps never open a divider (`MainChatArea.tsx:787-795`).
* **An unread marker may only be drawn from a real last-read anchor.** Until one exists, the unread divider stays unrendered (`MainChatArea.tsx:68-84`).
* **Tool executions fold into the parent agent bubble.** Interleaved tool rows are forbidden (`MainChatArea.tsx:706-729`; `UX_GUIDELINE.md:76`).
* **Streaming must stay at one store write per flush**, with completed blocks memoized and only the pending tail re-rendering (`crowdOsStore.ts:1022-1103`, `MentionParser.tsx:233-268`).
* **The transcript must reach the locked list budget** — virtualize past 500 channels / 2,000 messages (`UX_GUIDELINE.md:167`).

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| Stream scroll container | Scroll host + content column with `overflow-anchor:none` | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS leaves native anchoring ON (`overflowAnchor:'auto'`, `MainChatArea.tsx:1048`) and corrects with a raw height delta; Discord disables native anchoring on both host and column and computes an explicit anchor row. |
| Stick-to-bottom model | `pinned` flag + `isPinned()` / `isScrolledToBottom()` | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS uses one wheel/touch intent flag with an 80 px threshold (`use-stick-to-bottom.ts:9-11`); Discord persists a per-channel `pinned` boolean and uses a 2 px tolerance plus a `hasMoreAfter` term. |
| Jump to present | `jumpToPresentBar` floating bar | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS renders a pill only while scrolled up, carrying a missed count capped at 99 (`MainChatArea.tsx:1232-1248`); Discord's bar has text variants and can rewrite the store window when no present position is cached. |
| Unread divider | `role=separator aria-label="new"` + ack endpoint | [Message List](../Discord%20Findings/Message%20List.md) | Discord has a real last-read anchor and a `POST …/ack`; CrowdOS deliberately renders no unread marker because it keeps no anchor (`MainChatArea.tsx:68-84`). |
| Older-page pagination | `before/after/around` window + `_before`/`_after` boundary caches | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS uses a `ts;seq` keyset cursor in `channelCursors` with a 200-message local mirror cap (`crowdOsStore.ts:2940-2967`, `messagePagination.ts:15`); Discord truncates the store into boundary caches. |
| Prepend anchoring | `getAnchorData` / `findAnchor` / `fixAnchorScrollPosition` | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS corrects with `scrollTop += scrollHeight - prevHeight` (`MainChatArea.tsx:443`); Discord measures an anchor row and adds the placeholder's own height to the correction. |
| Older-page load affordance | Skeleton placeholder block with estimated height + load-more list item | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS renders a single text line while paging (`MainChatArea.tsx:1069-1073`); Discord reserves a measured placeholder region so the scrollbar does not jump. |
| Message list virtualization | Verified NOT virtualized | [Message List](../Discord%20Findings/Message%20List.md) | Both are unvirtualized. CrowdOS additionally violates its own locked budget (`UX_GUIDELINE.md:167`) while Discord bounds memory in the store rather than the DOM. |
| Date separator | `role=separator` with a localized date label | [Message List](../Discord%20Findings/Message%20List.md) | Same mechanism; CrowdOS derives the day key from the real timestamp and refuses to open a divider on a fabricated orphan-tool timestamp (`MainChatArea.tsx:787`). |
| Burst grouping | Store-computed `groupId` + `groupStart` class | [Message List](../Discord%20Findings/Message%20List.md) | CrowdOS groups by same author within 300 s with a fixed exclusion list (`MainChatArea.tsx:799-817`); Discord re-keys a group to the first message and always breaks a group on replies. |
| Tool call placement | Message accessories rendered inline | [Message List](../Discord%20Findings/Message%20List.md) | CrowdOS folds tool executions into the parent agent bubble, forward and backward (`MainChatArea.tsx:706-729`); Discord keeps tools as per-message accessories. |
| Hover action toolbar | Always-mounted `role="group" aria-label="Message Actions"` | [Interaction Vocabulary](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS mounts the toolbar hidden and reveals it on hover/focus, offering regenerate + retry only (`HumanMessage.tsx:108`, `AgentMessage.tsx:334`). |
| Row accessibility semantics | `role=listitem`, `aria-setsize`, navigator `role=list` | [Message List](../Discord%20Findings/Message%20List.md) | CrowdOS renders plain rows with no list structure and no keyboard message navigation (`MessageRouter.tsx` has no list wrapper). |
| Per-channel scroll position | Persisted `getChannelDimensions(channelId).scrollTop` | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS stores no scroll offset: a channel switch always resumes to the latest message (`MainChatArea.tsx:849-854`). |
| Keyboard scrolling | Arrow/Page/Home/End navigator + `SCROLLTO_PRESENT` | [Keyboard and Accessibility](../Discord%20Findings/Keyboard%20and%20Accessibility.md) | CrowdOS has no keyboard navigation over the transcript; only the composer and palette are keyboard-complete (`UX_GUIDELINE.md:150`). |

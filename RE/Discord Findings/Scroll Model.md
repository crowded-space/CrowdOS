# Scroll Model

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose

How Discord's channel view scrolls: which element is the scroll box, how "stuck to bottom" is decided, how newer messages behave when the user is scrolled up, how older history is paged in, and how the viewport is kept stable while older messages are prepended.

Scope: the channel chat scroll host, the message store's pagination contract, and the jump/unread affordances. The message list itself is documented in *Message List*.
## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] Discord does **not** rely on the browser's scroll anchoring, and does **not** virtualize. It implements a manual, JS-driven anchoring system over a fully materialized DOM:

- [Observed] The scroll host opts out of native anchoring with `overflow-anchor: none` (two places: the scroll host class `disableScrollAnchor_d125d2` and the content column `.scrollerContent__36d07`).
- [Observed] The scroll host keeps a `pinned` boolean plus three anchors: `focusAnchor`, `messageFetchAnchor`, `automaticAnchor`.
- [Observed] Every scroll event re-measures the DOM (`offsetTop` / `offsetHeight` / `offsetParent` walk) to find where the content should sit.

### The scroll box

| Layer | Class / attribute | CSS |
|---|---|---|
| Scroll host | `managedReactiveScroller_d125d2 scrollerBase_d125d2 disableScrollAnchor_d125d2 auto_d125d2` + `scroller__36d07` + `chat__f75fb0` | `overflow-x:hidden;overflow-y:scroll` (`.managedReactiveScroller_d125d2`), `box-sizing:border-box;flex:1 1 auto;min-height:0;position:relative` (`.scrollerBase_d125d2`), `overflow-anchor:none` (`.disableScrollAnchor_d125d2`), `position:absolute;top:0;bottom:0;inset-inline:0` (`.scroller__36d07`) |
| Content column | `scrollerContent__36d07` | `display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;overflow-anchor:none` |
| The list | `scrollerInner__36d07` (`<ol>`) | `min-height:0;overflow:clip` (never itself a scroll box) |
| Wrapper | `messagesWrapper__36d07` | `display:flex;flex:1 1 auto;min-height:0;min-width:0;position:relative;z-index:0` |
| Fade overlay | `pointerCover_d125d2` + `chatGradientBase__36d07` variants | `inset:0;position:absolute;z-index:9999` |

- [Observed] Evidence: `193433.6c7be9d5d6e8b51f.css` → `.managedReactiveScroller_d125d2{overflow-x:hidden;overflow-y:scroll}`, `.disableScrollAnchor_d125d2{overflow-anchor:none}`, `.scrollerBase_d125d2{…min-height:0;position:relative}`; `97585.c5d9b4ece02fa77e.css` → `.scroller__36d07{bottom:0;position:absolute;top:0;inset-inline:0}`, `.scrollerContent__36d07{…justify-content:flex-end;min-height:100%;overflow-anchor:none}`, `.scrollerInner__36d07{min-height:0;overflow:clip}`, `.messagesWrapper__36d07{…}`; class map `193433.213ada0bddfee7ee.js` → `"qZ":"auto_d125d2 scrollerBase_d125d2"`, `"Vl":"disableScrollAnchor_d125d2"`, `"fs":"managedReactiveScroller_d125d2"`.

- [Observed] The scrollbar is Discord-styled and auto-hiding: `.scroller__36d07:not(:hover)::-webkit-scrollbar-thumb{background:transparent}` and `.has-webkit-scrollbar .scroller__36d07:hover{will-change:scroll-position}`; `.auto_d125d2::-webkit-scrollbar{height:16px;width:16px}`.

### Stick-to-bottom model

- [Observed] The scroll manager is a class instance (`it` in the chat renderer) whose state is:

| Field | Meaning | Evidence |
|---|---|---|
| `pinned` | user was at the bottom when the view mounted; seeded from the persisted per-channel layout state | `const t=lK.A.isAtBottom(e.channel.id); this.pinned=t??!0` (`9a87b685b0e83591.js`) |
| `initialScrollTop` | saved scroll offset when the channel opened not-at-bottom, so the position can be restored | `this.initialScrollTop=t?null:lK.A.getChannelDimensions(e.channel.id)?.scrollTop??null` |
| `isAtBottom` | live flag mirrored from the layout store | `lK.A.isAtBottom(channelId)` |
| `hasMoreAfter` | there are messages newer than the loaded window | store flag `hasMoreAfter` |
| `scrollCounter` | rolling counter of scroll events | `isActivelyScrolling(){return this.scrollCounter>=5}` |
| `jumping` / `dragging` | a jump or a drag-scroll is in progress | `isJumping()`, `isDragging()` |

- [Observed] Two derived predicates:

- [Observed] `isPinned()` → `this.pinned && !this.props.messages.hasMoreAfter` — i.e. "we are at the bottom **and** we have not scrolled into a region that has newer messages behind us".
- [Observed] `isScrolledToBottom()` → `scrollTop >= scrollHeight - offsetHeight - 2 && !hasMoreAfter` (2px tolerance).

- [Observed] When a new message arrives while pinned, the manager pins to the bottom immediately:

- [Observed] `if(e.messages.jumpedToPresent && t.jumpSequenceId!==e.messages.jumpedToPresent.jumpSequenceId){ this.jumping=!0; this.scrollTo(0); this.setScrollToBottom(!0); return }`
- [Observed] `if(null!=a && a.state===SENDING && r?.id!==a.id && o?.doNotScroll!==!0) return void this.setScrollToBottom()` — a locally-sent message forces the bottom.
- [Observed] `if(null!=c && n!==c)` — a `focusId` (jump target) wins over pinning and is scrolled into view with `scrollIntoViewNode({node, padding: nH.mZ + additionalMessagePadding})` where `nH.mZ = 16`.

- [Observed] When the user is scrolled up, a new message does **not** move the viewport. Instead the unread machinery kicks in: the store's `receiveMessage(e, isAtBottom)` appends to `_after` when `hasMoreAfter` is set, and the unread bar is rendered from `getOldestUnreadTimestamp` / `ackMessageId`.

- [Observed] Live evidence of the pinned/unpinned split in the same channel: the live capture has both a `role=separator` labelled `October 21, 2026` (a date divider) **and** a `role=separator` labelled `new` (the unread line) — i.e. the view was scrolled up with unread content below.

### Jump to present

- [Observed] A floating bar, not a list item. Component `tL` (export `Ab` of module `44788`):

- [Observed] Wrapper: `DIV.jumpToPresentBar__36d07 bottomBar__36d07 barBase__36d07`, `onClick` → `stopPropagation()` then the action.
- [Observed] Label text is variant-driven: type `0` → `"You're Viewing Older Messages"` (`4EvBbw`), type `1` → `"You Are Viewing a Reply."` (`1J6Xq7`).
- [Observed] Button label: type `0` → `"Jump To Present"` (`gpoQsB`), type `1` → `"Jump To Original Message"` (`k3RM8z`).
- [Observed] While loading it shows a `PULSING_ELLIPSIS` spinner (`spinner__36d07` / `spinnerItem__36d07`) instead of the button.
- [Observed] There is a third variant (`default`) that renders a component rather than a string.

- [Observed] Two behaviours, chosen by whether a "present" position is cached in the store:

```
jumpToPresent(){ g.hasPresent() ? X.ref.current?.scrollToBottom({animate:!useReducedMotion})
                               : y.A.jumpToPresent(m.id, analyticsLocation) }
```

- [Observed] `hasPresent()` → smooth `scrollToBottom` (no network).
- [Observed] otherwise → `jumpToPresent(channelId)` on the message store, which **rewrites the loaded window**: it pulls the `_after` cache back in, clears the array, merges the newest `e` messages, sets `hasMoreBefore = _before.length>0`, and sets `jumpedToPresent = true` + `jumpSequenceId++` (`web.31d1cd3e6e440749.js` → `jumpToPresent(e){return this.mutate(t=>{let n=t._after.extractAll();t.hasMoreAfter=!1;…})}`).

- [Observed] The same bar is reused for a "jump to reply" variant (`r7.Ab` with `type: ks.REPLY`) when the store records a `jumpReturnTargetId`.

- [Observed] Related strings: `"Jump to Bottom"` (`O9337B`), `"Jump to last unread message"` (`z0Mkp3`), `"Jump To Message"` (`+TSRGD`), `"Jump To Reply"` (`dpjpOp`), `"Jump To Top"` (`nFP4oa`).

### The "new messages" line and unread bar

- [Observed] The unread line itself is a `role=separator` whose `aria-label` is `"new"` (`y2b7CA`) — observed live (`ev_ec275e…` accessibility node `7353`). Its DOM id is the constant `q4 = "---new-messages-bar"` (module `381941`).
- [Observed] The separator component prepends `"new, "` to the label when `isUnread` is set (`c859f3f5e6fac4b2.js` → `r = ${intl(y2b7CA)}, ${b}`).
- [Observed] A separate floating unread bar (`r7.GN` / `r7.OZ` / `r7.UK`) shows the count. Copy variants:
  - [Observed] `BctFH/` / `3wXb9P` → `"{count} new message(s)"`.
  - [Observed] `4H8ldG` → `"{count} new messages"`.
  - [Observed] `wvtbbG` / `tHqbtg` / `vaPWFe` → `"{count}+ new messages since {timestamp}"` (the "estimated" wording when the read anchor is approximate).
  - [Observed] `GkAbqY` → `"{count} New"`.
  - [Observed] `CBftDc` → `"{count} new summary/summaries"` (Summaries feature).
- [Observed] Clicking the bar jumps to the ack message and marks read: `ackMessageId(channelId)` → `jumpToMessage({channelId, messageId: ack, offset:1, context:"Mark As Read"})`, else `jumpToMessage({channelId, messageId: castChannelIdAsMessageId(channelId), offset:1, context:"Mark As Read"})`.
- [Observed] The bar is **feature-gated**: it only renders when the client flag set includes `NEW_MESSAGES` (or `SUMMARIES`), and the whole unread surface is suppressed in embedded activities / panels (`675171` module: `no_text_activity` maps to `[NEW_MESSAGES, OPT_IN_CHANNEL, SUMMARIES]`, panel mode to `[]`).
- [Observed] CSS: `newMessagesBar__0f481`, `newMessagesPill__0f481`, `newMessagesPillContainer__0f481`, `newMessagesClear__0f481`, `newMessagesClearIcon__0f481`, `markAsReadText__0f481` (`247917.6b7a396bebba0935.css`).

### Pagination

- [Observed] Endpoint and query shape (`web.31d1cd3e6e440749.js`):

| Call | Request |
|---|---|
| `GET /channels/{channelId}/messages` | `query:{before, after, limit, around, preload, feature}` |
| Single message | `GET /channels/{channelId}/messages` with `query:{limit:1, around:messageId}` |
| Ack | `POST /channels/{channelId}/messages/{messageId}/ack` (`MESSAGE_ACK`) |
| Jump target | `fetchMessages({channelId, limit, focus:{messageId}})` |

- [Observed] The manager holds `before`/`after` message ids and requests a window **around** them: `query:{before:n,after:i,limit:r,around:N,preload:d,feature:h}`.

- [Observed] Store-side pagination state: `_array` (loaded messages), `_before` / `_after` (boundary caches with a `wasAtEdge` flag), `hasMoreBefore`, `hasMoreAfter`. `loadFromCache` seeds from the cache; `truncateTop` / `truncateBottom` evict the ends into the caches and re-arm the `hasMore*` flags; `truncate(e,t)` is a no-op while `length <= E.UNo` (the in-memory cap).

- [Observed] Load-more affordances in the DOM:

- [Observed] A **load-more list item** rendered as a navigable `DIV[role=listitem][data-list-item-id][aria-label]` above the messages (`inspect-main.json` → `dom.nodes[4954]`), whose click calls `loadMore(false, {pauseUntilUserScroll:true, truncate:false})`.
- [Observed] A **skeleton block** of `aria-hidden` placeholder rows above it (`inspect-main.json` → `dom.nodes[4838]`, 26 children) — `lY` renders `n1.Ay` skeleton rows inside `DIV.wrapper_d852db` with `style={{height: totalHeight}}`, i.e. an *estimated-height* placeholder region, not real messages.
- [Observed] A **buffer spacer** `DIV[style]` (`inspect-main.json` → `dom.nodes[4953]`) = `style={{height:16, flex:"0 0 auto"}}`.
- [Observed] Loading is **scroll-speed gated**: `handleScrollSpeed(e)` returns early when `isJumping() || isDragging() || !canLoadMore`, and when `isPinned() || isScrolledToBottom(e)` — i.e. auto-load only triggers when the user is scrolling *up* and away from the bottom.
- [Observed] Trigger regions are computed, not hard-coded: `isInPlaceholderRegion()` returns `1` for the top placeholder, `2` for the bottom placeholder; `isInScrollTriggerLoadingRegion()` uses `getOffsetToTriggerLoading("top"|"bottom", state)`.
- [Observed] Auto-load is **paused until the user scrolls**: `loadMorePausedUntilUserScroll` is set when a load is initiated programmatically, and `handleUserScrollGesture()` clears it on the next real wheel/touch/key gesture.

- [Observed] Channel switch behaviour: the scroll host is re-created per channel; `initialScrollTop` restores the persisted scroll offset when the channel was not at the bottom, otherwise the view pins to the bottom. The per-channel scroll state lives in the layout store (`isAtBottom`, `getChannelDimensions`, `updateChannelDimensions`).

### Scroll anchoring when older messages are prepended

- [Observed] This is the part Discord gets right and most reimplementations get wrong.

- [Observed] `getAnchorData(id, scrollTop, clamp)`:
- [Observed] finds the message element by id (`getElementFromMessageId` → `document.getElementById("chat-messages-{channelId}-{messageId}")`),
- [Observed] measures `offsetHeight` and the absolute `offsetTop` via an `offsetParent` walk (`l5(node, scroller)`),
- [Observed] returns `{id, offsetFromTop, offsetTop, offsetHeight, clamped}`.

- [Observed] `getAnchorFixData()` picks the anchor to re-apply, in priority order: `focusAnchor` → `messageFetchAnchor` → `automaticAnchor`, and computes `{node, fixedScrollTop: node.offsetTop - (anchor.offsetFromTop + extra)}` where `extra` is `messageFetchAnchor.offsetHeight - node.offsetHeight` — i.e. the height of the *placeholder block that was replaced by real messages*, so the correction accounts for the placeholder's contribution.

- [Observed] `fixAnchorScrollPosition()` then:
- [Observed] if there is a `focusAnchor`: if `isPinned()` → `scrollTo(MAX_SAFE_INTEGER)` (jump to bottom), else `mergeTo(fixedScrollTop)`; and it calls `scrollIntoViewNode({node, padding: 16 + additionalMessagePadding})` so the focused message stays visible.
- [Observed] otherwise `mergeTo(fixedScrollTop)`.
- [Observed] and it re-establishes the automatic anchor: `isActivelyScrolling() ? setAutomaticAnchor(null) : setAutomaticAnchor(findAnchor())`.

- [Observed] `findAnchor()` walks the message array and picks the first message whose `offsetTop >= scrollTop + clientHeight` — the first row fully below the fold — so the anchor is a row that is guaranteed to still exist after the prepend. It also caches `_bottomAnchor` and applies a `newMessageBarBuffer()` tolerance (`32px`, or `64px` for forum posts) so the anchor is not chosen inside the unread bar region.

- [Observed] `updateAutomaticAnchor` / `updateFetchAnchor` re-measure the anchors on every scroll, keeping `offsetFromTop` stable across height changes. `updateVisibleMessagesDebounced = debounce(fn, 300)` — visible-message bookkeeping is throttled to 300 ms.

### Keyboard scrolling

- [Observed] The list is a **navigator**: the `<ol>` receives `role="list"`, `tabindex`, `aria-orientation` and `data-list-id` from the navigator context (module `837381` → `LT`/`hD`), and each row receives `role="listitem"`, `data-list-item-id`, `tabindex` (`837381` → `rm`).
- [Observed] The scroll host handles `onKeyDown`; the recognised keys are `ArrowUp`, `ArrowDown`, `PageUp`, `PageDown`, `Home`, `End` (`l6 = new Set(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"])`), and any of them calls `handleUserScrollGesture()` (clearing the load-more pause).
- [Observed] Page movement is delegated to the generic scroller: `scrollPageUp()` → `scrollTo({to: scrollPosition - 0.9*offsetSize})`, `scrollPageDown()` → `+0.9*offsetSize`.
- [Observed] Dedicated actions: `SCROLLTO_PRESENT` → `scrollToBottom()`; `SCROLL_PAGE_UP` → `handleUserScrollGesture()` + `scrollPageUp({animate})`; `SCROLL_PAGE_DOWN` → `handleUserScrollGesture()` + `scrollPageDown({animate})` (`9a87b685b0e83591.js` → `em.jej.SCROLLTO_PRESENT`, `em.jej.SCROLL_PAGE_UP`, `em.jej.SCROLL_PAGE_DOWN`).
- [Observed] A hidden description is provided for screen readers: `<span id="messagesNavigationDescription" aria-hidden="true">"Use the up and down arrow keys to navigate between messages quickly. New messages will be added to the bottom of the list as they come in."</span>` (`9a87b685b0e83591.js` → `"messagesNavigationDescription"`, `"Spb3s/"`; `inspect-main.json` → `dom.nodes[4836]`).

### Loading and error states

- [Observed] **Messages failed to load** → a bar `messagesErrorBar__36d07` with the text `"Messages Failed To Load"` and a `"Try Again"` button that re-fetches with `limit` and `truncate:true` (`9a87b685b0e83591.js` → `r7.Ez`, `1zUvlw`, `TdQXA8`).
- [Observed] **Top/bottom spinners** → `spinner__0f481` / `spinnerItem__0f481` (the `PULSING_ELLIPSIS` loader).
- [Observed] **Jump-to-present spinner** → `jumpToPresentSpinner__0f481` / `jumpToPresentSpinnerItem__0f481`.
## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Element | Marker | Evidence |
|---|---|---|
| Scroll host | `managedReactiveScroller_d125d2 … disableScrollAnchor_d125d2 … scroller__36d07` | `193433.6c7be9d5d6e8b51f.css`; `97585.c5d9b4ece02fa77e.css` |
| Content column | `scrollerContent__36d07` | `97585.c5d9b4ece02fa77e.css` |
| List | `OL.scrollerInner__36d07` | `inspect-main.json` → `dom.nodes[4835]` |
| Jump-to-present bar | `jumpToPresentBar__0f481 bottomBar__0f481 barBase__0f481` | `247917.6b7a396bebba0935.css`; `247917.34c1fc3d85eaa2cf.js` → `"Sg2":"jumpToPresentBar__0f481 bottomBar__0f481 barBase__0f481"` |
| Jump-to-present button | `barButtonMain__0f481 barButtonBase__0f481` | `247917.34c1fc3d85eaa2cf.js` → `"$IB":"barButtonMain__0f481 …"` |
| New-messages bar | `newMessagesBar__0f481 barBase__0f481` | `247917.34c1fc3d85eaa2cf.js` → `"ebV":"newMessagesBar__0f481 barBase__0f481"` |
| Mark-as-read text | `markAsReadText__0f481` | `247917.34c1fc3d85eaa2cf.js` → `"vE$":"markAsReadText__0f481"` |
| Load-more item | `DIV[role=listitem][data-list-item-id][aria-label]` | `inspect-main.json` → `dom.nodes[4954]` |
| Placeholder block | `DIV.wrapper_d852db` + 26 `aria-hidden` children | `inspect-main.json` → `dom.nodes[4838]` |
| Buffer spacer | `DIV[style]` | `inspect-main.json` → `dom.nodes[4953]` |
| Unread separator | `role=separator aria-label="new"` | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → a11y `7353` |
| Date separator | `role=separator aria-label="October 21, 2026"` | `inspect-main.json` → `accessibility.nodes[5192]` |

## Implementation details

- [Observed] **Scroll state is persisted per channel** in the layout store: `isAtBottom(channelId)`, `getChannelDimensions(channelId).scrollTop`, `updateChannelDimensions({channelId, scrollTop, scrollHeight, …})` (`web.31d1cd3e6e440749.js` → `"UPDATE_CHANNEL_DIMENSIONS"`).
- [Observed] **Two "am I at the bottom" notions coexist**: the layout store's persisted `isAtBottom`, and the live `isScrolledToBottom()` computed from `scrollTop/scrollHeight/offsetHeight` with a 2px tolerance. The live one wins for immediate decisions; the persisted one wins on mount.
- [Observed] **`chatOpen` tracking**: `updateChatOpen(channelId, false)` is dispatched when the user leaves the bottom, and `SCROLLTO_PRESENT` when they return — used to decide whether the channel can auto-close the composer.
- [Observed] **New-message buffer**: `newMessageBarBuffer()` = `32px`, or `64px` for forum posts (module `381941` → `k8:32`, `Gt:64`).
- [Observed] **Jump padding**: `nH.mZ = 16` px, plus a per-context `additionalMessagePadding`.
- [Observed] **Scroll damping**: the generic scroller exposes `spring`, `scrollTo({to, animate, callback})`, `mergeTo`, `scrollIntoViewRect`, `scrollIntoViewNode`, `scrollPageUp`, `scrollPageDown`, `scrollToTop`, `scrollToBottom`, and clamps `to` to `[0, scrollSize - offsetSize + 1]` (`web.31d1cd3e6e440749.js` → `"scrollIntoViewNode(t)"`, `"mergeTo"`, `"scrollPageUp()"`).
- [Observed] **`will-change: scroll-position`** is applied to the scroller while hovered (`will-change` hint to keep the scrollbar composited).

## Interaction model
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Trigger | Effect | Evidence |
|---|---|---|
| Wheel / touch drag on the scroller | marks a user gesture (`handleUserScrollGesture`), clears the load-more pause | `9a87b685b0e83591.js` → `"handleUserScrollGesture=()=>{this.loadMorePausedUntilUserScroll&&(this.loadMorePausedUntilUserScroll=!1,this.handleScroll())}"` |
| Scrolling up into the placeholder region | triggers a history fetch | `"isInPlaceholderRegion"`, `"isInScrollTriggerLoadingRegion"`, `"handleScrollSpeed"` |
| Scrolling up past the speed threshold | auto-load fires (not just on the threshold edge) | `"handleScrollSpeed"` |
| Clicking the jump-to-present bar | `scrollToBottom` (smooth) if a present position is cached, else a store rewrite + jump | `"hasPresent()"`, `"jumpToPresent"` |
| Clicking the unread bar | jump to the ack message and mark read | `"context:\"Mark As Read\""` |
| Arrow / Page / Home / End keys on the list | navigator moves focus between messages; the scroller also treats them as a user gesture | `"l6=new Set([\"ArrowUp\",\"ArrowDown\",\"PageUp\",\"PageDown\",\"Home\",\"End\"])"` |
| `SCROLLTO_PRESENT` / `SCROLL_PAGE_UP` / `SCROLL_PAGE_DOWN` | global actions | `em.jej.SCROLLTO_PRESENT` etc. |
| Jumping to a message (notification, search, pin) | `scrollIntoViewNode` with 16px padding; the row flashes (`backgroundFlash__5126c`) | `"flashKey"`, `"backgroundFlash__5126c"` |

## Performance notes

- [Observed] **Anchor computation is O(n) in loaded messages on every prepend**: `findAnchor()` calls `getAnchorData` per message until it finds the first row below the fold. With a few hundred loaded rows this is a full DOM measurement pass — the price of not virtualizing.
- [Observed] **Every scroll event re-measures the anchors** (`updateAutomaticAnchor`, `updateFetchAnchor`) — but visible-message bookkeeping is debounced at 300 ms.
- [Observed] **The placeholder block carries an estimated height** (`style={{height: totalHeight}}`) so the scrollbar does not jump when skeletons are swapped for real messages; the real correction happens in `getAnchorFixData`, which adds `messageFetchAnchor.offsetHeight - node.offsetHeight` to the fix.
- [Observed] **`overflow-anchor:none` on both the host and the content column** means the browser contributes zero to anchoring — all stability is JS, which is deterministic but not free.
- [Observed] **The scroll host is `overflow-y: scroll`**, not `auto`: the scrollbar gutter is always reserved, so the content width does not change when messages arrive.
- [Observed] `ResizeObserver` on both the host and the content element re-runs `handleResize` when an image loads or an embed expands, keeping `offsetHeightCache`/`scrollHeightCache` fresh.
- [Observed] **Reads are layout-thrashing prone**: `getAnchorData` reads `offsetTop`/`offsetHeight` immediately after DOM writes in the same task.

## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Claim | Pointer |
|---|---|
| Scroll host CSS (`overflow-y:scroll`, `overflow-anchor:none`) | `193433.6c7be9d5d6e8b51f.css` → `.managedReactiveScroller_d125d2{overflow-x:hidden;overflow-y:scroll}`, `.disableScrollAnchor_d125d2{overflow-anchor:none}` |
| Content column CSS | `97585.c5d9b4ece02fa77e.css` → `.scrollerContent__36d07{…justify-content:flex-end;min-height:100%;overflow-anchor:none}` |
| Scroll manager class and anchor fields | `9a87b685b0e83591.js` → `"automaticAnchor"`, `"messageFetchAnchor"`, `"focusAnchor"`, `"pinned"`, `"scrollCounter"`, `"getAnchorData"`, `"fixAnchorScrollPosition"`, `"findAnchor"` |
| Pinned predicate | `9a87b685b0e83591.js` → `isPinned(){return this.pinned&&!this.props.messages.hasMoreAfter}` |
| Bottom predicate | `9a87b685b0e83591.js` → `isScrolledToBottom(){…e>=t-n-2&&!this.props.messages.hasMoreAfter}` |
| Pagination query shape | `web.31d1cd3e6e440749.js` → `query:{before:n,after:i,limit:r,around:N,preload:d,feature:h}` |
| Message store window rewrite | `web.31d1cd3e6e440749.js` → `jumpToPresent(e){…t.hasMoreBefore=t._before.length>0…}` |
| Unread separator DOM id | module `381941` in `web.31d1cd3e6e440749.js` → `q4:"---new-messages-bar"`, `k8:32`, `Gt:64`, `mZ:16` |
| Jump-to-present component | `web.31d1cd3e6e440749.js` → module `44788` export `Ab`; `gpoQsB`=`"Jump To Present"`, `4EvBbw`=`"You're Viewing Older Messages"` |
| Unread copy variants | `8b9a4b4a55eaa34c.js` → `BctFH/`, `3wXb9P`, `4H8ldG`, `wvtbbG`, `tHqbtg`, `vaPWFe`, `GkAbqY`, `CBftDc` |
| Live DOM: list, placeholders, load-more, buffer | `inspect-main.json` → `dom.nodes[4835]`, `dom.nodes[4836]`, `dom.nodes[4838]`, `dom.nodes[4953]`, `dom.nodes[4954]` |
| Live unread separator | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → a11y `7353` |
| Target identity | `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` |

## Gaps

- **`isScrolledToBottom` and the pinned predicate** were read from the chat-renderer module in `9a87b685b0e83591.js`; both are quoted verbatim in the Evidence table above.
- **Live scroll offsets were not measured.** No programmatic scrolling was performed (read-only constraint), so `scrollTop`, `scrollHeight` and the size of the placeholder region are inferred from the bundle, not observed.
- **The jump-to-present bar was not captured live.** The inspected channel was scrolled to the bottom, so the bar was not rendered; its markup is taken from the bundle only.
- **Whether the unread bar in the live capture was the `NEW_MESSAGES` variant or the `SUMMARIES` variant** could not be determined from the a11y tree alone.
- **The exact `limit` used for a channel page** was not resolved (`D.d7Q` was referenced but not resolved to a number).
- **`preload` and `feature` query-parameter semantics** were not traced to their producer.
## User Decision:
## Target Contract

> Status: Target. CrowdOS's Chat Area already owns the auto-follow behaviour described in `re-docs/Frontend Docs/Domain Spec/Chat Area.md` (`useStickToBottom`, `maybeLoadOlder`, "Jump to present" pill with missed count, height anchoring on prepend). These invariants describe a Discord-shaped scroll model; CrowdOS's own locked contract wins wherever the two differ.

* **Follow mode is decided by wheel/touch intent, never by the `scroll` event.** The `scroll` event also fires for programmatic pins, so using it to decide follow would fight the auto-pin. CrowdOS's `useStickToBottom` already does this and must keep doing it.
* **While scrolled up, incoming messages never move the viewport.** They accrue a missed count, and a "jump to present" affordance carries that count and resumes follow with a smooth scroll.
* **Prepending older history must not move the visible content.** The prepended page is height-anchored: the viewport offset is corrected by the exact height delta of the inserted block, and the correction is applied in the same frame as the insert.
* **Native scroll anchoring is disabled on the message column** (`overflow-anchor:none`) and replaced by an explicit anchor strategy (anchor row id + measured offset). Mixing the two produces double-correction.
* **The scroll box is the channel column itself**, not an inner wrapper; the message column must not be its own scroll container, or the composer/scroll geometry splits.
* **Scroll state is per channel and persisted** (at-bottom flag plus scroll offset), so switching channels restores the position instead of snapping to the bottom.
* **Auto-load of older history is proximity-triggered and user-intent gated**: it fires when the user scrolls up into the top region, never on a programmatic jump, and it is paused until the next real user scroll gesture.
* **Loading older history shows a placeholder region of estimated height**, so the scrollbar does not jump when real rows replace it, and the correction accounts for the placeholder's own height.
* **Loading failures are surfaced, not swallowed**: an explicit "Messages Failed To Load" affordance with a retry, never a silently empty list.
* **The list is keyboard-navigable**: the list container is focusable with an orientation, rows are list items with stable ids, and arrow/Page/Home/End move focus and scroll. A hidden description tells the user that new messages arrive at the bottom.
* **A date separator uses `role="separator"`** and appears only on an honest day change. CrowdOS deliberately does **not** render an unread divider because it keeps no honest unread anchor; any future unread affordance must be backed by a real last-read anchor.

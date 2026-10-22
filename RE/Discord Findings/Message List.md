# Message List

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose

How Discord renders a channel's message list: the container element, the row anatomy, grouping rules, separators, affordances, rich content and reaction rendering. Written from the live Discord desktop client (Electron 42 / Chromium 148 / Discord 1.0.9264) on guild `NSU (ngasu)`, channel `#vibin-room`, plus the shipped web bundle.

Target surface: the chat message stream in `discord.com/channels/<guild>/<channel>`.
## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] The list is **plain DOM inside a scroll host**, not a windowed list. Three nested elements carry the structure:

1. [Observed] **Scroll host** — `DIV` with `role="group"`, `tabindex="-1"`, `dir`, `data-jump-section`. Holds `onScroll`, `onWheel`, `onTouchMove`, `onMouseDown/Up`, `onKeyDown`, `onResize`. Bundle: `9a87b685b0e83591.js` → `"onUserScrollGesture"` / `"handleScroll"` / `"handleResize"` / `"handleKeyDown"` / `"tabIndex:-1,role:\"group\""`.
2. [Observed] **Content column** — `DIV.scrollerContent__36d07` (flex column, `justify-content:flex-end`).
3. [Observed] **The list itself** — `<OL class="scrollerInner__36d07" aria-label="Messages in {channelName}">`.

- [Observed] Inside the `<ol>` the children are, in render order: a hidden `<span id="messagesNavigationDescription">`, then the message rows, then a trailing spacer `<div>`. Prepended above the rows are an optional skeleton block and a buffer `<div style="height:16px;flex:0 0 auto">`.

- [Observed] Each message is an `<li class="messageListItem__5126c" id="chat-messages-{channelId}-{messageId}" aria-setsize="-1">` wrapping a `DIV` that carries `role="listitem"`, `data-list-item-id`, `tabindex`, `aria-roledescription="Message"`, `aria-labelledby`, `aria-describedby`.

### Virtualization verdict: NOT VIRTUALIZED

- [Observed] This is the single most important finding in this document.

| Marker searched | Hits in chat renderer (`9a87b685b0e83591.js`) | Hits across all 1 606 loaded chunks | Meaning |
|---|---|---|---|
| `react-window` | 0 | 0 | absent |
| `react-virtual` / `react-virtuoso` | 0 | 0 | absent |
| `virtua` (virtua.org) | 0 | 0 | absent (`virtual` hits are `VirtualCurrency`, `virtual-currency` API paths) |
| `useVirtualizer` / `virtualizer` | 0 | 0 | absent |
| `overscan` / `estimatedItemSize` | 0 | 0 | absent |
| `renderRow` / `rowCount` / `rowHeight` / `stickyHeaders` / `visibleItems` | 0 | present only in the **member list / emoji picker** | Discord *has* a virtualized list component (`AI.Ei` / `k.A` with `renderRow`, `rowHeight`, `renderSection`, `rowCountBySection`, `stickyHeaders`) — the chat does not use it |
| `VirtualizedList` | 0 | 2, both in the member list | `isVirtualizedList: l>=64` threshold for the *people* list, not chat |
| `useVirtualFocus` | 0 | 8 | accessibility focus roving, not windowing |

- [Observed] Positive evidence that the chat list is fully materialized:

- [Observed] Message DOM ids are addressable: `9a87b685b0e83591.js` → `"chat-messages"` and `` `${l}-${e}-${t}` `` (module `375901`), consumed by `getElementFromMessageId()` → `document.getElementById(...)`.
- [Observed] The scroll manager measures real boxes: `getAnchorData()` reads `offsetHeight` and walks `offsetParent` (`l5()`), and `findAnchor()` iterates **the whole message array** calling `getAnchorData` per message.
- [Observed] Live DOM: 36 `<li>` elements under one `<ol>` at once, spanning 3:57 PM → 7:49 PM — far more than a viewport (`inspect-main.json` → `dom.nodes[4835]`, `dom.nodes[4957]`…`dom.nodes[6052]`).
- [Observed] The nearest thing to virtualization is **skeleton placeholders** for messages not yet loaded: `lY` renders `n1.Ay` (module `114212`, skeleton) rows inside `DIV.wrapper_d852db` with `style={{height: totalHeight}}`. Live: `inspect-main.json` → `dom.nodes[4838]` contains 26 `aria-hidden` skeleton `DIV`s.

- [Observed] Discord instead bounds memory in the **store**, not the DOM: the message store keeps `_array` plus `_before`/`_after` boundary caches and truncates via `truncateTop`/`truncateBottom` (`web.31d1cd3e6e440749.js` → `"truncateTop(e)"`, `"truncateBottom(e)"`, `"hasMoreBefore"`, `"hasMoreAfter"`).

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Element | DOM / class | Evidence |
|---|---|---|
| Scroll host | `DIV[role=group][tabindex=-1][dir][data-jump-section]` | `inspect-main.json` → `dom.nodes[4845]`; `9a87b685b0e83591.js` → `"tabIndex:-1,role:\"group\""` |
| Content column | `DIV.scrollerContent__36d07` | `97585.c5d9b4ece02fa77e.css` → `.scrollerContent__36d07{...justify-content:flex-end;min-height:100%;overflow-anchor:none}` |
| The list | `OL.scrollerInner__36d07` + `aria-label="Messages in {channelName}"` | `inspect-main.json` → `dom.nodes[4835]` attrs `class,aria-label,role,data-list-id,tabindex,aria-orientation`; `9a87b685b0e83591.js` → `"ol"`, `"XarRiL"` |
| Nav description | `SPAN#messagesNavigationDescription[aria-hidden]` | `inspect-main.json` → `dom.nodes[4836]`; `9a87b685b0e83591.js` → `"messagesNavigationDescription"`, `"Spb3s/"` |
| Skeleton block | `DIV.wrapper_d852db` + `aria-hidden` children | `inspect-main.json` → `dom.nodes[4838]` (26 children) |
| Buffer spacer | `DIV[style]` | `inspect-main.json` → `dom.nodes[4953]`; `9a87b685b0e83591.js` → `"height:nH.N0,flex:\"0 0 auto\""` |
| Load-more item | `DIV[role=listitem][data-list-item-id][aria-label]` | `inspect-main.json` → `dom.nodes[4954]` |
| Message row | `LI.messageListItem__5126c[id][aria-setsize=-1]` | `inspect-main.json` → `dom.nodes[4957]`; `524434.c590eb647314b0ab.js` → `"Nt":"messageListItem__5126c"` |
| Message inner | `DIV[role=listitem][data-list-item-id][aria-roledescription][aria-labelledby]` | `inspect-main.json` → `dom.nodes[4958]` |
| Row wrapper classes | `message__5126c`, `cozyMessage__5126c`, `groupStart__5126c`, `selected__5126c`, `replying__5126c`, `mentioned__5126c`, `systemMessage__5126c`, `ephemeral__5126c`, `guildOfficialMessage__5126c`, `nitroMessage__5126c`, `automodMessage__5126c`, `backgroundFlash__5126c` | `524434.c590eb647314b0ab.js` → `"iU":"message__5126c"`, `"HJ":"cozyMessage__5126c"`, `"_A":"groupStart__5126c"`, `"wH":"selected__5126c"`, `"$n":"replying__5126c"`, `"mK":"mentioned__5126c"`, `"H4":"systemMessage__5126c"` |
| Message list container class | `messageList__77b37`, `conversationContainer__77b37`, `skeletonMessage__77b37` | `993562.3a15e5287f3ae92e.js` → `"cl":"messageList__77b37"` |
| Hover toolbar row | `DIV.container__34c2c`, `header__34c2c`, `reactButtons__34c2c` | `97585.f392630811204e5a.js` → `"kL":"container__34c2c"` |
| Date divider | `role=separator`, `aria-label="October 21, 2026"` | `inspect-main.json` → `accessibility.nodes[5192]` |
| "New" divider | `role=separator`, `aria-label="new"` | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → accessibility node `7353` |

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Message row anatomy

| Part | Marker | Evidence |
|---|---|---|
| Avatar | `avatar_c19a55`, `avatarDecoration_c19a55` | `738015.4d96bd469ad86d12.js` → `"my":"avatar_c19a55"` |
| Author name | `username_c19a55`, `usernameText_c19a55`, `roleDot_c19a55`, `roleIcon_c19a55` | `738015.4d96bd469ad86d12.js` → `"oF":"username_c19a55"`, `"m4":"roleDot_c19a55"` |
| Server tag (chiplet) | `clanTagChiplet_c19a55`; live button name `"Server Tag: TORN"` | `738015.4d96bd469ad86d12.js` → `"s4":"clanTagChiplet_c19a55"`; `ev_ec275e…` → a11y button `5228` |
| Bot tag | `botTag_c19a55`, `botTagCompact_c19a55`, `botTagCozy_c19a55` | `738015.4d96bd469ad86d12.js` → `"jW":"botTagCompact_c19a55 botTag_c19a55"` |
| Timestamp | `timestamp_c19a55`, `timestampInline_c19a55`, `timestampVisibleOnHover_c19a55` | `738015.4d96bd469ad86d12.js` → `"vE":"timestamp_c19a55"`, `"ET":"timestampVisibleOnHover_c19a55"` |
| Compact timestamp variants | `latin12CompactTimeStamp_c19a55`, `latin24CompactTimeStamp_c19a55`, `asianCompactTimeStamp_c19a55` | `738015.4d96bd469ad86d12.js` → `"Xh":"latin12CompactTimeStamp_c19a55"` |
| Content | `contents_c19a55`, `messageContent_c19a55` | `738015.4d96bd469ad86d12.js` → `"PG":"contents_c19a55"` |
| Reply spine | `messageSpine_c19a55`, `repliedMessageClickableSpine_c19a55`, `replyAvatar_c19a55`, `replyBadge_c19a55` | `738015.4d96bd469ad86d12.js` → `"NB":"messageSpine_c19a55"`; live button `"Jump To Reply"` (`ev_ec275e…` a11y `5280`) |
| Reply preview | `repliedMessage_c19a55`, `repliedTextPreview_c19a55`, `repliedTextContent_c19a55` | `738015.4d96bd469ad86d12.js` → `"JZ":"repliedMessage_c19a55"` |
| Thread accessory | `threadMessageAccessory_c19a55`, `threadMessageAccessoryAvatar_c19a55`, `threadMessageAccessoryPreview_c19a55` | `738015.4d96bd469ad86d12.js` → `"up":"threadMessageAccessory_c19a55"` |
| Attachments / embeds | rendered by module `699352` → `renderAccessories`, `renderReactions`, `renderThreadAccessory`, `hideInviteEmbedBanner`, `hideActivityInvite` | `c6e61aa598b77723.js` → `"renderAccessories"`, `"renderReactions"`, `"renderThreadAccessory"` |
| Reactions | `reactions__34c2c`, `addReactButton__34c2c`, `hasNoReactions__34c2c` | `97585.f392630811204e5a.js` → `"Br":"reactions__34c2c"`, `"vU":"addReactButton__34c2c"` |
| Hover toolbar | `role="group" aria-label="Message Actions"` | `9a87b685b0e83591.js` → `"aria-label":eL.intl.string(eL.t.Lv7LxN)`; `ev_ec275e…` → a11y groups `6981`, `7146`, `7198`, `7250`, `7302` |
| Edited flag | `edited_c19a55`; live accessible name contains `(edited)` | `738015.4d96bd469ad86d12.js` → `"oh":"edited_c19a55"`; `inspect-main.json` → `accessibility.nodes[5405]` |

### Grouping

- [Observed] The store computes a `groupId` per message; the renderer re-keys a group to the **first** message's id: `let n = e.groupId===z?.groupId ? z.content.id : e.groupId` where `z` is the first `MESSAGE` item (`9a87b685b0e83591.js`).
- [Observed] `groupStart__5126c` is applied to the row whose `id === groupId`, and also to any `REPLY`-typed message, so replies never collapse into a neighbour: `[nC._A]: !C && (ex || i.type===em.lAJ.REPLY)` (`9a87b685b0e83591.js`).
- [Observed] Compact vs cozy is a **per-message prop, not a CSS variant of the container**: `compact={h && !l}` where `h` is the channel-level `messageDisplayCompact` and `l` is "is first message in forum post". Cozy rows get `cozyMessage__5126c` (`[nC.HJ]: !g`).
- [Observed] Group spacing is a first-class setting: `ACCESSIBILITY_SET_MESSAGE_GROUP_SPACING` with the option set `[0,4,8,16,24]` and default `16` (`web.31d1cd3e6e440749.js` → `"ACCESSIBILITY_SET_MESSAGE_GROUP_SPACING"`, module `381941` → `qh:[0,4,8,16,24]`, `ES:16`). Rendered as `group-spacing-{n}` on the outer wrapper (`9a87b685b0e83591.js` → `` `group-spacing-${o}` ``).

### Separators

- [Observed] A date separator is a `role="separator"` whose `aria-label` is the localized date: `October 21, 2026` (`inspect-main.json` → `accessibility.nodes[5192]`).
- [Observed] The separator component prefixes the label with the "new" string when `isUnread`: `r = ${intl(y2b7CA)}, ${b}` (`c859f3f5e6fac4b2.js` → `"role:\"separator\""`, `"y2b7CA"`).
- [Observed] The "new messages" line itself is a separator whose label is literally `new` (`ev_ec275e…` → a11y `7353`).
- [Observed] Divider CSS: `divider__0f481`, `dividerContent__0f481`, `dividerRed__0f481`; the read/unread variant is `dividerThin__31080` / `dividerThick__31080` (`247917.6b7a396bebba0935.css`, `97585.f392630811204e5a.js` → `"b1":"dividerThin__31080 divider__31080"`).

### Rich content

- [Observed] One renderer handles the body: module `470964` (`useMessageRenderedContent`), returning `{content, hasSpoilerEmbeds, hasBailedAst}`; options `allowHeading`, `allowList`, `allowLinks`, `allowDevLinks`, `previewLinkTarget`, `postProcessor`, `hideSimpleEmbedContent` (`063734acaba763c6.js`).
- [Observed] Two code paths: a Suspense-wrapped experimental renderer (`d.A`, `allowJumboEmoji`, `hideSingleLinkContent`) behind an experiment gate, and the legacy `u.Ay` fallback (`063734acaba763c6.js` → `"useMessageRenderedContent"`, `"allowJumboEmoji"`).
- [Observed] Spoilers are prefixed internally: module `381941` → `ZG:"SPOILER_"`; a spoilered attachment surfaces as a button `"Click to see attachment"` (`ev_ec275e…` a11y `5487`).
- [Observed] Simple embeds are suppressed when the message has a single link (`hideSingleLinkContent`) and `hideSimpleEmbedContent` is on.
- [Observed] Message types that render as **system** rows instead of chat bubbles: `REPLY=19`, `CHAT_INPUT_COMMAND=20`, `THREAD_STARTER_MESSAGE=21`, `CONTEXT_MENU_COMMAND=23`, `AUTO_MODERATION_ACTION=24`, `USER_JOIN=7`, `CHANNEL_PINNED_MESSAGE=6` (module `448761`, `web.31d1cd3e6e440749.js`).
- [Observed] Un-deletable message types: `MRS.UNDELETABLE = new Set([1,2,3,4,5,21,35,56,57,64,68])` (`web.31d1cd3e6e440749.js`).

### Reactions

- [Observed] Rendered as a row of emoji pills below the message; the CSS module owns `reactions__34c2c`, `addReactButton__34c2c`, `reactButtons__34c2c`, `hasNoReactions__34c2c`.
- [Observed] The hover bar's quick-reaction strip shows up to **3** guild emoji (or the defaults `100`, `laughing`, `sparkling_heart`) and then an add-reaction button: `nc=[getByName("100"),getByName("laughing"),getByName("sparkling_heart")]` and `i.slice(0,3)` (`9a87b685b0e83591.js`).
- [Observed] "You reacted" is expressed by the tooltip wording, not by a separate bubble class: `wunKKA` = `"Click to remove"` vs `XVx5BN` = `"Click to react"`, with `vjeruO` = `"Click to remove {emojiName}"` and `L1JQwE` = `"Click to react with {emojiName}"` (`8b9a4b4a55eaa34c.js`).
- [Observed] Reaction creation can be disabled per channel (`disableReactionCreates` from `canChat` / `ADD_REACTIONS` / lurk state / archived thread) (`9a87b685b0e83591.js` → `"disableReactionCreates"`).
- [Observed] Bulk reaction management lives in the context menu (`reactions`, `remove-emoji-reactions`, `remove-reactions`) — see *Interaction Vocabulary*.
### Timestamps

- [Observed] Each row carries a `<time>` element — the live message list has 39 `time` nodes for 38 message rows (`ev_ec275e…` → a11y subtree of the list).
- [Observed] Compact rows show a locale-shaped compact stamp (`latin12` / `latin24` / `asian` variants); the full stamp is revealed on hover via `timestampVisibleOnHover_c19a55`.
- [Observed] The edited timestamp is exposed separately in the row's accessible name: `"(edited) Wednesday, October 21, 2026 4:32 PM"` (`inspect-main.json` → `accessibility.nodes[5405]`).
- [Observed] Timestamp is computed from `i.editedTimestamp ?? i.timestamp` (`9a87b685b0e83591.js` → `"editedTimestamp"`).
## Interaction model

- [Observed] **Hover** — `onMouseMove` / `onMouseLeave` on the row drive `hasHovered` / `isHovered`; the toolbar is mounted only when `hasHovered || hasFocused` (`childrenButtons: P||U ? ... : undefined`), so it is not in the DOM at rest (`9a87b685b0e83591.js`).
- [Observed] **Focus** — the inner row `DIV` is `tabindex`-able, `onFocus`/`onBlur` set `hasFocused`; `selected__5126c` is applied when hovered, focused, or keyboard-mode focused (`z = T||K||V&&G`).
- [Observed] **Right-click** — `onContextMenu` opens the message context menu with `navId:"message"`, `aria-label="Message Actions"` (`727ee9421e324cee.js`).
- [Observed] **Keyboard** — the row has `onKeyDown`; the key map (Backspace/C/E/P/+/R/F/S/T/Enter/Escape) is documented in *Interaction Vocabulary*. Arrow keys are handled by the **list** navigator, not the row.
- [Observed] **Accessible name** — the row is not a flat string; it is `aria-labelledby` → the author/content/time block and `aria-describedby` → the reply/thread metadata, with `aria-roledescription="Message"` (`BAB0yK` = `"Message"`).
- [Observed] **Reply naming** — the reply spine is announced as `"{author} replying to {repliedAuthor}"` (`RhbQ2K` in `8b9a4b4a55eaa34c.js`).

## Performance notes

- [Observed] **No windowing** means cost scales with loaded messages: every row is a real DOM subtree with an avatar image, a `<time>`, and markdown output. Crowdsourced channels with deep history are the risk case.
- [Observed] Mitigation in Discord is store-level: `truncateTop`/`truncateBottom` move trimmed rows into `_before`/`_after` caches and set `hasMoreBefore`/`hasMoreAfter`, keeping the DOM bounded in practice.
- [Observed] Scroll anchoring is **manual and JS-driven**: CSS `overflow-anchor:none` is explicitly set on the content column, and the browser's native scroll anchoring is replaced by `automaticAnchor` / `messageFetchAnchor` / `focusAnchor` bookkeeping plus `offsetTop`/`offsetHeight` reads.
- [Observed] `ResizeObserver` drives `onResize` → `handleResize` on both the container and the content node, so image loads and embed expansion re-measure the anchors (`9a87b685b0e83591.js` → `"resizeObserver"`, `"key:\"content\""`).
- [Observed] The `<ol>` is `role="list"` with `data-list-id` / `data-list-item-id` attributes, giving the assistive-tech tree a stable list identity without extra ARIA.
- [Observed] `contain:size` on `.messages__36d07` hints the browser to isolate layout for the message area (`97585.c5d9b4ece02fa77e.css`).

## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Claim | Pointer |
|---|---|
| Message list is an `<ol>` labelled "Messages in {channel}" | `inspect-main.json` → `dom.nodes[4835]`; `9a87b685b0e83591.js` → `"ol"`, `"XarRiL"` |
| No virtualization library present | grep over 1 606 chunks: 0 hits for `react-window`/`react-virtuoso`/`virtua`/`useVirtualizer`/`overscan`/`estimatedItemSize` |
| Virtualized list exists elsewhere | `web.31d1cd3e6e440749.js` → `"renderRow"`, `"rowHeight"`, `"rowCountBySection"`, `"stickyHeaders"` (member list / emoji picker) |
| Messages are real DOM nodes | `9a87b685b0e83591.js` → `"chat-messages"`, `` `${l}-${e}-${t}` ``, `getElementById` |
| Anchors measured from DOM | `9a87b685b0e83591.js` → `"getAnchorData"`, `"offsetFromTop"`, `"findAnchor"` |
| Row markup and classes | `9a87b685b0e83591.js` → `"messageListItem__5126c"` usage via `nC.Nt`; `524434.c590eb647314b0ab.js` class map |
| Live DOM shape | `inspect-main.json` → `dom.nodes[4835]` (OL), `dom.nodes[4836]` (hidden span), `dom.nodes[4838]` (26 skeletons), `dom.nodes[4953]` (buffer), `dom.nodes[4954]` (load-more item), `dom.nodes[4957]` (first `<li>`) |
| Date separator | `inspect-main.json` → `accessibility.nodes[5192]` |
| "new" separator | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → accessibility node `7353` |
| Hover toolbar group | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → accessibility groups `6981`, `7146`, `7198`, `7250`, `7302` |
| Author/server-tag buttons | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → a11y `5201` (`Falheim`), `5228` (`Server Tag: TORN`) |
| Reaction wording | `8b9a4b4a55eaa34c.js` → `"wunKKA"`, `"XVx5BN"`, `"vjeruO"`, `"L1JQwE"` |
| Live target identity | `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` → title `#vibin-room \| NSU (ngasu)`, url `https://discord.com/channels/345096814443233301/345096814443233302` |

## Gaps

- **No live thread was reachable.** The inspected guild had no active thread in the sidebar or channel list (a11y shows only a `button` named `"Threads"` at node `303`), so thread-row rendering was not observed live; thread structure is derived from the bundle only. Recorded honestly rather than fabricated.
- **Class-name → DOM-element mapping for `messageList__77b37`** is inferred: the module `708510` export `cl` is `messageList__77b37`, but the chat renderer never references it directly; the observable `<ol>` class is `scrollerInner__36d07`.
- **Message content internals** (markdown AST, code-block language label, line numbers, link-unfurl card types, poll markup) were not dumped at DOM level — the evidence here is the renderer module's option surface plus the CSS class vocabulary, not a live code block.
- **Reply/thread/mention/embed rich rendering** was observed only for the reply spine and a spoilered attachment; embeds, polls and spoilers were not present in the sampled channel.
- **Search-in-channel** and **message pinning UI** were not exercised (no live interaction performed, by design).
- The 1 606 chunks were pulled over HTTPS from `discord.com/assets` as static assets; no authenticated API call, mutation or websocket write was performed.

## User Decision:
## Target Contract

> Status: Target. The CrowdOS Chat Area (`re-docs/Frontend Docs/Domain Spec/Chat Area.md`) already owns the channel message stream, the composer and the auto-follow behaviour. These invariants describe what a CrowdOS implementation of a Discord-shaped message list must satisfy. They do not change the locked CrowdOS design; where Discord's mechanism differs, CrowdOS's own contract wins.

* **Non-virtualized by default.** CrowdOS renders one DOM row per message in the loaded window and bounds the window at the store/loader level (`loadOlderMessages` with `limit + 1` probing), not by unmounting rows. A CrowdOS message must remain addressable by id in the DOM so the scroll anchor can measure it.
* **One list element with a stable accessible name.** The stream is a single list container (`role="list"` or `<ol>`) whose accessible name names the channel, with a stable per-item identity (`data-list-item-id` or equivalent) so the assistive-tech tree matches the visual order.
* **Row = list item with an accessible name, not a flat string.** Each message row exposes author, optional reply target, body and timestamp, and announces a reply as `"{author} replying to {repliedAuthor}"` rather than embedding it in the text.
* **Grouping is a first-class row property.** Consecutive same-author messages collapse into a compact row; a message that starts a group, and any reply, always breaks the group and renders in full (CrowdOS rule: same author within 5 minutes, excluding system/tool/governance rows).
* **Group spacing is a user setting, not a hard-coded constant** (CrowdOS exposes message group spacing as an accessibility-style setting with discrete steps).
* **Date separators use `role="separator"`** and are inserted only on an honest day change from a real message timestamp; orphan tool rows must never open a divider (CrowdOS already enforces this).
* **Unread markers must not be fabricated.** Discord anchors the unread line to a real read-state; CrowdOS deliberately omits the unread divider because it keeps no honest unread anchor. Any CrowdOS unread affordance must be backed by a real last-read anchor or it must not render.
* **Manual scroll anchoring.** Native CSS scroll anchoring is disabled on the message column and replaced by an explicit anchor strategy (an anchor row id + measured offset) so prepending older history never jumps the viewport.
* **Auto-follow is intent-driven, not event-driven.** Follow mode is decided by wheel/touch intent, never by the `scroll` event (which also fires for programmatic pins). While scrolled up, new messages accrue a missed count and never yank the viewport; a "jump to present" control resumes follow.
* **Older history loads on proximity to the top, with a loader affordance**, and the prepended page is height-anchored so the visible messages do not move.
* **Every per-message action is permission-gated and gated actions are omitted, not disabled-and-hidden** — the permission set is read from the channel's own permission model, and the UI never renders an action the actor cannot take.
* **Action vocabulary is centralized.** Reply, react, edit, delete, pin, bookmark, forward, copy link/text/id, mark unread, report, start thread, view thread, publish and open-in-browser are a single named set with one trigger model (hover toolbar vs context menu vs keyboard), not ad-hoc per-component buttons.
* **Reply and thread are different primitives.** Reply stays inside the channel as a quoted reference; a thread is its own conversation with its own id, its own list, its own composer, and its own unread state — the two must not be conflated in the render tree.

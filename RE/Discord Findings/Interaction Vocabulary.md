# Interaction Vocabulary

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose

The complete per-message action vocabulary in Discord: every action, how it is triggered, what it does, and how permission gating is expressed in the UI. Covers the hover toolbar, the right-click context menu, the keyboard map, and the notification-capable subset.

Scope: actions on an existing message in a channel. Channel-level actions (mute, clear, search) and composer actions are out of scope.

## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] Discord exposes one action set through **three triggers**, all rendering the same underlying operations:

| Trigger | Surface | Structure |
|---|---|---|
| **Hover toolbar** | appears on the right of the hovered/focused row | a horizontal toolbar (`nt.Ay`), each button a `nt.qv` |
| **Right-click / context menu** | a popover menu anchored to the pointer | a `ContextMenu` (`o.W`) with `navId`, groups (`r.rX`) and items (`r.Dr`) |
| **Keyboard** | the focused row / the list | a single `onKeyDown` switch on the row (`tE`) |

- [Observed] Both the toolbar and the context menu are built from the **same action modules**, so an action's availability logic is written once:
`copy-link` (345254), `delete` (483768), `mark-unread` (20883), `pin`/`unpin` (979766), `bookmark`/`reminder` (880457), `apps` (646911).

- [Observed] Gating is expressed in two distinct ways, and the difference matters:

- [Observed] **Structural gating** — the action component returns `null`, so the item is *absent* from the menu and the button is *absent* from the toolbar. This is the normal case.
- [Observed] **Disabled-with-reason** — the item renders with `disabled:true` (e.g. `publish` when the message is already published, `report-to-mod` when already reported, `translate` while a translation is in flight).

### The hover toolbar

- [Observed] Rendered only when the row is hovered or focused (`childrenButtons: P||U ? … : undefined`). Wrapper: `DIV[role="group"][aria-label="Message Actions"]` with class `container__34c2c` (+ `header__34c2c` for the group-start row, `reactButtons__34c2c` for the reaction strip).

- [Observed] Toolbar button keys, in render order (`9a87b685b0e83591.js`):

| Key | Label | Condition | Action |
|---|---|---|---|
| `copy-id` | `"Copy Message ID"` | developer mode **and** author is you | `(0,tx.DT)(t,n,e)` |
| `copy-link` | `"Copy Link"` | `canCopy` (client copy capability) | `(0,tx.S)(t,n)` |
| `configure` | `"Configure"` | `canConfigureJoin` (server-side join config) | `(0,tx.vc)(t)` |
| `mark-unread` | `"Mark Unread"` | channel id is valid | `(0,tx.cl)(t,n)` |
| `bookmark` | `"Bookmark Message"` / `"Remove Bookmark"` | always | `(0,nn.x)` / `(0,nn.Y)` |
| `pin` | `"Pin Message"` / `"Unpin Message"` | `canPin` | `(0,tx.rS)(t,n,e)` |
| `thread` | `"Create Thread"` | `canStartThread && canForward` | `(0,tx.Nw)(t,n)` |
| `reply-self` | `"Reply"` | `canReply` and the author is you | `(0,tx.$b)(t,n,e)` |
| `reply-other` | `"Reply"` | `canReply` and the author is not you | `(0,tx.$b)(t,n,e)` |
| `edit` | `"Edit Message"` | `canEdit` | `(0,tx.u_)(t,n)` |
| `forward` | `"Forward"` | `canForward` | `(0,tx.Z4)(t,n)` |
| `thread` | `"Create Thread"` | `canStartThread && !canForward` | `(0,tx.Nw)(t,n)` |
| `view-thread` | `"View Thread"` | `!canStartThread && canViewThread` | `(0,tx.mF)(t,n)` |
| `guild-official` | make/unmake official | `canManageOfficialMessages` | `patchMessageGuildOfficial(...)` |
| `publish` | publish to announcement channel | `canPublish` (announcement channel + `NEWS` feature + sender permission) | `(0,tx.Le)(t,n)` |
| `delete` | `"Delete"` | `canDelete` | `(0,tx.RC)(t,n,e)` |
| `more` | opens the context menu popout | always | `setPopout({moreUtilities:true})` |

- [Observed] Reaction strip (rendered instead of the icon row while collapsed): up to 3 quick-reaction emoji (`nh`), an add-reaction button (`ns`, label `"Add Reaction"`), and — when `canReact` — the full emoji picker.

- [Observed] Failed-sent messages get a different toolbar (`ng`): `retry` and `delete-usent`.

### The context menu

- [Observed] Built by module `355682` (`727ee9421e324cee.js`). Two entry points:

- [Observed] `nk` (default export) — the DOM-attached right-click handler: it walks up from the event target collecting `data-type`, `data-id`, `data-name`, `href`, `src`, `data-safe-src`, `textContent`, then delegates.
- [Observed] `nB` — the builder, called with `{message, channel, navId, ariaLabel, canReport, textSelection, …}`.

- [Observed] Both produce the same menu with `aria-label="Message Actions"` (`ChPNkN`) and `navId:"message"`. The hover bar's "more" popout calls the same builder with `navId:"message-actions"` (`Lv7LxN`).

- [Observed] Menu groups, in order:

| Group | Item ids |
|---|---|
| Quick reactions | `quickreact-{emojiId\|index}` (up to 4 guild emoji) |
| Text selection | copy-selected-text (from `f.A`/`h.A`) |
| Reactions | `add-reaction` (with a nested emoji submenu and `other-reactions`), `reactions` |
| Core | `edit`, `reply`, `forward`, `thread` |
| Everything else | `copy-text`, `translate` / `translate-{locale}` / `revert-translation`, `copy-link`, `guild-official-set` / `guild-official-unset`, `bookmark`, `reminder` (+ `mark-complete`), `apps` (frequently-used commands), `resend`, `mark-unread`, `configure`, `view-conversation`, `tts`, `end-poll-early`, `view-interaction-info` (+ `integration-owner`, `interaction-user`) |
| Danger | `remove-emoji-reactions` (+ `remove-emoji-reactions-{emojiName\|id}`), `remove-reactions`, `report`, `report-to-mod` |
| Details / media | `message-details` (+ `copy-message-id`, `copy-item-id`, `copy-image-link`, `open-image-link`), `copy-image`, `save-image`, `report-image-false-positive`, `save-voice-message-audio`, `video-stats-for-nerds`, `copy-native-link`, `open-native-link`, `copy-native-contact`, `native-send-sms` |

- [Observed] Every item carries a stable `id` string; those ids are the closest thing Discord has to a public action vocabulary.

### The keyboard map

- [Observed] The row's `onKeyDown` handler (`tE` in the chat renderer) is a single switch. Modifier classification: `i` = no modifier, `s` = Alt, `a` = Ctrl, `r` = Cmd, `o` = Shift.

| Key | Modifiers | Action | Gate |
|---|---|---|---|
| `Backspace` | none | delete message | `MANAGE_MESSAGES` **or** `canDeleteOwnMessage` |
| `C` | Ctrl or Cmd | copy message text | copy capability |
| `E` | none | edit message | `(0,tA.A)(message, userId)` and not a system DM |
| `P` | none or Shift | pin message | `(0,tf.A)(message, channel)` |
| `+` | none or Shift | open the reaction picker | not disabled by `disableReactionCreates` |
| `R` | none or Shift | reply | `(0,tr.r)(channel, message)` |
| `F` | none or Shift | forward | `(0,ti.p)(message)` |
| `S` | none | speak / stop speaking (TTS) | message has content |
| `T` | none | create thread, or open the existing thread | `(0,to.D1)` else `HAS_THREAD` |
| `Enter` | Alt | secondary message action (mark read / jump) | — |
| `Escape` | — | cancel edit, or focus the composer | — |

- [Observed] The list itself handles `ArrowUp`, `ArrowDown`, `PageUp`, `PageDown`, `Home`, `End` for focus movement (see *Scroll Model*).

### Reply vs thread — the exact product distinction

| | Reply | Thread |
|---|---|---|
| Action name | `"Reply"` (`5IEsGx`) | `"Create Thread"` (`rBIGBL`) / `"View Thread"` (`39d0Wj`) |
| Where the answer goes | the same channel | a new channel |
| Visible in parent | yes, as a quoted reply spine | only the starter row |
| Has its own URL | no | yes (`/channels/{g}/{c}/{t}` or `/channels/{g}/{c}/threads/{t}`) |
| Has its own unread state | no | yes |
| Forwardable | — | `forward` sends the message; `thread` forks the conversation |

- [Observed] The "reply" action also supports **cross-posting**: replying can target another channel (`"Also send to"`, `Pi3JW7`), and the result is announced with `"Message also sent to {channelName}"` (`IFPJ6J`) or `"Message also sent to main channel"` (`gi2swM`) — i.e. replying to a message in a thread can deliver to the parent channel.

### Forwarding

- [Observed] `forward` is a distinct action from `reply`, with its own vocabulary: `"Forward"` (`I3ltXO`), `"Forward embed from this message"` (`JEzRSt`), `"Forward media from this message"` (`Lz3qZu`), `"Forward To"` (`+SkRRj`). Forwarding carries the message content and optionally its embed or media into another channel.

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Element | Marker | Evidence |
|---|---|---|
| Hover toolbar container | `role="group" aria-label="Message Actions"`, class `container__34c2c` | `9a87b685b0e83591.js` → `"aria-label":eL.intl.string(eL.t.Lv7LxN)`; `97585.f392630811204e5a.js` → `"kL":"container__34c2c"` |
| Toolbar row | `buttons__5126c` / `buttonsInner__5126c` on the row; `nt.Ay` = toolbar | `524434.c590eb647314b0ab.js` → `"Uo":"buttons__5126c"`, `"Mc":"buttonsInner__5126c"` |
| Toolbar button | `nt.qv` with `label`, `ariaLabel`, `icon`, `disabled`, `dangerous`, `separator` | `9a87b685b0e83591.js` → module `194085` export `qv` |
| Context menu | `o.W` with `data-menu-migrated`, `navId`, `aria-label` | `727ee9421e324cee.js` → `{"data-menu-migrated":!0,navId:tl,onClose:ti,"aria-label":ta,onSelect:to}` |
| Menu item | `r.Dr` with `id`, `label`, `icon`, `leadingAccessory`, `action`, `color:"danger"`, `group`, `disabled` | `727ee9421e324cee.js` |
| Reaction strip | `reactButtons__34c2c`, `addReactButton__34c2c` | `97585.f392630811204e5a.js` → `"hY":"reactButtons__34c2c"`, `"vU":"addReactButton__34c2c"` |
| Quick-reaction button | `nt.qv` with `tooltipText` = `:name:` + state text | `9a87b685b0e83591.js` → `"wunKKA"` / `"XVx5BN"` |
| "Message" role description | `aria-roledescription="Message"` on the row | `9a87b685b0e83591.js` → `"aria-roledescription":eL.intl.string(eL.t.BAB0yK)` |
| Context menu observed live | a11y `role=group` named `"Message Actions"` | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → a11y `6981`, `7146`, `7198`, `7250`, `7302` |

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Permission gates, by action

| Gate | Check | Where |
|---|---|---|
| Delete own message | `message.canDeleteOwnMessage(userId)` | `9a87b685b0e83591.js` |
| Delete any message | `MANAGE_MESSAGES` | `9a87b685b0e83591.js` → `tm.A.can(em.xBc.MANAGE_MESSAGES,t)` |
| Delete is blocked for | `MRS.UNDELETABLE` message types, `AUTO_MODERATION_ACTION` (unless moderator), the first message of a moderator-report channel | `web.31d1cd3e6e440749.js` → `UNDELETABLE:new Set([1,2,3,4,5,21,35,56,57,64,68])`; `727ee9421e324cee.js` |
| Edit | not a system DM, `(0,tA.A)(message, userId)`, channel id valid | `9a87b685b0e83591.js` |
| Pin | `PIN_MESSAGES` **and** `READ_MESSAGE_HISTORY`; not in voice/stage/media threads; not a system DM | `681e846fab87a0c8.js` → module `492841` |
| Unpin | same gate, message not already pinned | `681e846fab87a0c8.js` → module `979766` |
| Reply | `SEND_MESSAGES` + `READ_MESSAGE_HISTORY` (or a DM), and the target type is replyable | `727ee9421e324cee.js` → module `517997` |
| React | `ADD_REACTIONS`; also blocked by lurk / archived-thread / `disableReactionCreates` | `9a87b685b0e83591.js`; `727ee9421e324cee.js` → `en(e)` |
| Add new reactions | `ADD_REACTIONS` permission (`9DtKDB` = "Members with this permission can add new reactions to a message…") | `8b9a4b4a55eaa34c.js` |
| Start thread | `canStartThread` (channel-level) | `9a87b685b0e83591.js` → `(0,to.n)(t,n)` |
| Forward | `canForward` | `9a87b685b0e83591.js` → `(0,ti.m)(n)` |
| Publish (announcement) | announcement channel + guild `NEWS` feature + `SEND_MESSAGES` + author is the sender or a moderator | `9a87b685b0e83591.js` → `L=t.type===em.rbe.GUILD_ANNOUNCEMENT&&…` |
| Configure join | `MANAGE_GUILD` (partial context) on a `USER_JOIN` message | `727ee9421e324cee.js` → `tm.A.canWithPartialContext(B.xBc.MANAGE_GUILD,{guildId:P})` |
| Remove all reactions | `MANAGE_MESSAGES` | `727ee9421e324cee.js` → `ee.A.can(B.xBc.MANAGE_MESSAGES,n)` |
| Report | `(0,e5.ul)(message)` — reportable by any user | `727ee9421e324cee.js` |
| Mark as unread | channel id valid | `681e846fab87a0c8.js` → module `20883` |
| Bookmark | requires `READ_MESSAGE_HISTORY` in a guild, unless private | `8b980d157af44f08.js` → `!n.isPrivate()&&!m.A.can(I.xBc.READ_MESSAGE_HISTORY,n)` |
| Copy image / save image | embedded platform only (`isPlatformEmbedded`) | `e921316e4ac02b0c.js` → module `115184` |
| Copy text / message link | desktop: copy text is available via keyboard; the "copy" item needs `isPlatformEmbedded` | `681e846fab87a0c8.js` → module `373963` |

### Confirmation and acceleration patterns

- [Observed] **Delete**: shift+click deletes immediately, otherwise a confirm dialog (`"Are you sure you want to delete this message?"`, `AMvpS4`) — and the dialog itself explains the accelerator: `"You can hold down shift when clicking delete message to bypass this dialog."` (`IxY7E6`).
- [Observed] **Pin / unpin**: shift+click pins/unpins immediately, otherwise `confirmPin` / `confirmUnpin` (`681e846fab87a0c8.js` → module `979766`).
- [Observed] **Remove reactions**: shift+click removes immediately, otherwise a confirm dialog with `confirmVariant:"critical-primary"` (`727ee9421e324cee.js`).
- [Observed] **Bulk emoji removal**: each emoji is its own submenu item `remove-emoji-reactions-{name|id}` with shift-click acceleration.

### Notification-capable actions

- [Inferred] Only a small set of actions produce a notification for another member:

| Action | Notification |
|---|---|
| Reply | a mention/quote notification in the parent channel (or the cross-posted target channel) |
| Create thread | a thread-start system message plus, for private threads, notifications to the invited members |
| Add a member to a thread | "X added Y to the thread." — a system message, not a notification |
| @mention inside a reply/thread | a mention notification scoped to the thread's channel |

- [Inferred] The remaining actions are local to the actor: edit, delete, pin, bookmark, copy, react, mark unread, forward (notifies only if the forward lands in another channel), report, publish.

### Enumerated constant arrays in the bundle

- [Observed] Where Discord exposes the vocabulary as data rather than JSX:

- [Observed] `TZK` — the channel-stream item types: `MESSAGE`, `MESSAGE_GROUP_BLOCKED`, `MESSAGE_GROUP_IGNORED`, `MESSAGE_GROUP_SPAMMER`, `MESSAGE_GROUP_SUSPENDED_USER`, `THREAD_STARTER_MESSAGE`, `DIVIDER`, `JUMP_TARGET`, `FORUM_POST_ACTION_BAR`, `MESSAGE_GROUP`, `DIVIDER_TIME_STAMP`, `DIVIDER_NEW_MESSAGES`.
- [Observed] `MRS` — message-role sets: `UNDELETABLE`, `GUILD_DISCOVERY_STATUS`, `USER_MESSAGE`, `NOTIFIABLE_SYSTEM_MESSAGE`.
- [Observed] `lAJ` — message types: `THREAD_CREATED=18`, `REPLY=19`, `CHAT_INPUT_COMMAND=20`, `THREAD_STARTER_MESSAGE=21`, `CONTEXT_MENU_COMMAND=23`, `AUTO_MODERATION_ACTION=24`.
- [Observed] `xBc` — the permission enum used by every gate (`ADD_REACTIONS`, `MANAGE_MESSAGES`, `MANAGE_GUILD`, `PIN_MESSAGES`, `READ_MESSAGE_HISTORY`, `SEND_MESSAGES`).
- [Observed] `Fd` — the message popout flags: `referencedAvatarProfile`, `referencedUsernameProfile`, `interactionAvatarProfile`, `interactionUsernameProfile`, `interactionData`, `avatarProfile`, `usernameProfile`, `emojiPicker`, `emojiBurstPicker`, `moreUtilities`, `contextMenu`.
- [Observed] The report-reason list is a literal array: `[{value:"not_useful"},{value:"off_topic"},{value:"missing_messages"},{value:"misleading_title"},{value:"inappropriate"},{value:"too_cluttered"},{value:"hard_to_use"},{value:"too_old"},{value:"other"}]` (`9a87b685b0e83591.js`).
- [Observed] The quick-reaction defaults are a literal array: `["100","laughing","sparkling_heart"]`.
- [Observed] The context-menu item **ids** are literal strings and form the de-facto public vocabulary: `edit`, `reply`, `forward`, `thread`, `copy-text`, `copy-link`, `copy-message-id`, `copy-item-id`, `copy-image-link`, `open-image-link`, `copy-image`, `save-image`, `copy-native-link`, `open-native-link`, `copy-native-contact`, `native-send-sms`, `add-reaction`, `other-reactions`, `reactions`, `remove-reactions`, `remove-emoji-reactions`, `mark-unread`, `pin`, `unpin`, `delete`, `bookmark`, `reminder`, `mark-complete`, `tts`, `resend`, `configure`, `report`, `report-to-mod`, `report-image-false-positive`, `translate`, `revert-translation`, `translate-{locale}`, `guild-official-set`, `guild-official-unset`, `view-conversation`, `view-interaction-info`, `integration-owner`, `interaction-user`, `end-poll-early`, `save-voice-message-audio`, `video-stats-for-nerds`, `message-details`, `quickreact-{id}`.

## Interaction model
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Trigger | Result | Evidence |
|---|---|---|
| Mouse enter on a row | mounts the toolbar (`hasHovered`) | `9a87b685b0e83591.js` → `"childrenButtons:P||U?…:void 0"` |
| Focus on a row | mounts the toolbar (`hasFocused`) and marks the row `selected__5126c` | `"z=T||K||V&&G"`, `"[nC.wH]:z"` |
| Right-click a row | opens the context menu (`navId:"message"`) | `"onContextMenu:R"` |
| Click "more" in the toolbar | opens the same menu as a popout (`navId:"message-actions"`) | `"renderPopout:e=>(0,a.jsx)(nu,{…})"` |
| Click a reaction pill you own | removes the reaction; otherwise adds it | `"type":null!=l?"remove":"add"` |
| Click "add reaction" | opens the emoji picker popout | `TOGGLE_REACTION_POPOUT` with `{emojiPicker:true}` |
| Shift+click delete / pin / remove-reactions | bypasses the confirmation | `"e.shiftKey?a.A.deleteMessage(i.id,n.id):p.A.confirmDelete(i,n,!0)"` |
| Long-press / right-click on a link or image | a **media** submenu (`copy-native-link`, `open-native-link`, `copy-image`, `save-image`) | module `777933`, module `115184` |
## Performance notes

- [Observed] The toolbar is **conditionally mounted**, not CSS-hidden: hovering a row creates a subtree of buttons. With fast pointer movement across a list this is the main per-hover allocation in the chat; Discord mitigates it by keeping the reaction strip separate from the icon row and by rendering only when `hasHovered || hasFocused`.
- [Observed] The context menu is built lazily and its height is measured (`onHeightUpdate`) so the popout can be repositioned; the open/close is timed for analytics (`MESSAGE_MENU_TIME_TO_CLOSE`, `MESSAGE_MENU_TIME_TO_SELECT`).
- [Observed] The `apps`/commands section is fetched on demand (`allowFetch`, `limit`) and scores commands with `scoreMethod`; it is the only menu section that performs a network read.
## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Claim | Pointer |
|---|---|
| Toolbar mount condition | `9a87b685b0e83591.js` → `"childrenButtons:P||U?function(e){…}({…}):void 0"` |
| Toolbar button keys | `9a87b685b0e83591.js` → `"copy-id"`, `"copy-link"`, `"configure"`, `"mark-unread"`, `"bookmark"`, `"pin"`, `"thread"`, `"reply-self"`, `"reply-other"`, `"edit"`, `"forward"`, `"view-thread"`, `"guild-official"`, `"publish"`, `"delete"`, `"more"`, `"retry"`, `"delete-usent"` |
| Context-menu item ids | `727ee9421e324cee.js` → `id:"edit"`, `id:"reply"`, `id:"forward"`, `id:"thread"`, `id:"copy-text"`, `id:"add-reaction"`, `id:"other-reactions"`, `id:"reactions"`, `id:"remove-reactions"`, `id:"remove-emoji-reactions"`, `id:"report"`, `id:"report-to-mod"`, `id:"tts"`, `id:"resend"`, `id:"configure"`, `id:"end-poll-early"`, `id:"view-interaction-info"`, `id:"message-details"`, `id:"copy-message-id"`, `id:"copy-item-id"`, `id:"copy-image-link"`, `id:"open-image-link"`, `id:"save-voice-message-audio"`, `id:"video-stats-for-nerds"`, `id:"quickreact-…"` |
| Pin / delete / mark-unread / copy-link items | `681e846fab87a0c8.js` → `id:"copy-link"`, `id:"delete"`, `id:"mark-unread"`, `id:"pin"`, `id:"unpin"`, `id:"copy"` |
| Bookmark / reminder items | `8b980d157af44f08.js` → `id:"bookmark"`, `id:"reminder"`, `id:"mark-complete"` |
| Media items | `e921316e4ac02b0c.js` → `id:"copy-image"`, `id:"save-image"`; `d5621fd9c10fcdb0.js` → `id:"copy-native-link"`, `id:"open-native-link"`, `id:"copy-native-contact"`, `id:"native-send-sms"` |
| Apps / commands section | `80607ee23894299a.js` → module `646911`, `"V0w2ap"` = "Frequently Used Commands" |
| Keyboard map | `9a87b685b0e83591.js` → `case"backspace"`, `case"c"`, `case"e"`, `case"p"`, `case"+"`, `case"r"`, `case"f"`, `case"s"`, `case"t"`, `case"enter"`, `case"escape"` |
| Permission gates | `681e846fab87a0c8.js` → `PIN_MESSAGES`, `READ_MESSAGE_HISTORY`; `727ee9421e324cee.js` → `MANAGE_MESSAGES`, `ADD_REACTIONS`, `SEND_MESSAGES` |
| Reaction state wording | `8b9a4b4a55eaa34c.js` → `"wunKKA"`, `"XVx5BN"`, `"vjeruO"`, `"L1JQwE"` |
| Live hover toolbar | `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` → a11y groups `6981`, `7146`, `7198`, `7250`, `7302` named "Message Actions" |
## Gaps

- **No context menu was opened live** (right-click is an interaction, and opening a menu is state-adjacent), so the menu's rendered item order and grouping were not confirmed in the a11y tree. The grouping above is reconstructed from the builder's JSX group order.
- **The "apps"/commands section contents depend on installed apps** and were not resolvable without opening the menu.
- **Long-press** is a touch-only path; the bundle shows the same `ContextMenu` component but the touch trigger was not distinguished in the code examined.
- **"Open in browser"** as a per-message action was not found under that name in the message menu; the equivalent is the media `open-native-link` / `open-image-link` items, which are link/media scoped rather than message scoped. Recorded as not found rather than mapped onto a different action.
- **"Assign"** (assigning a message/issue) does not exist in Discord's message vocabulary; it is a GitHub-Issues concept. Recorded as absent.
- **"Run command (bot)"** corresponds to the `apps` / application-commands section (module `646911`), which runs an installed application command against the message — its exact affordance depends on the app.
- **"View history / profile"** appear as *targets* rather than message actions: `view-conversation` opens a conversation, and the author profile opens from the username button (`onClickUsername`, `onClickAvatar`).
- The live capture confirms the hover toolbar's presence and its `aria-label` (five `role=group` nodes named "Message Actions"), but the individual button labels inside those groups were not enumerated.
## User Decision:
## Target Contract

> Status: Target. CrowdOS's Chat Area already exposes a per-message hover action set (edit/resend, regenerate/retry) and a `ThreadDrawer`. These invariants describe a Discord-shaped action vocabulary and do not change the locked CrowdOS design.

* **One action vocabulary, multiple triggers.** Every per-message action is defined once and reachable from a hover toolbar, a context menu and a keyboard map. The three surfaces must not drift apart.
* **Permission gating is structural.** An action the actor cannot take is **absent**, not present-and-disabled, except where the reason must be visible (e.g. "publish" already published, "report" already reported). A disabled-forever button is noise.
* **The gate set is explicit and server-derived.** Actions read the channel's own permission model; the client never hard-codes an allow-list that could disagree with the server.
* **Actions are safe by default and fast on intent.** Destructive actions (delete, remove all reactions) confirm; an explicit modifier bypasses the confirmation. The confirm dialog states the bypass.
* **Every action has a stable id.** Menu items and toolbar buttons carry a machine-readable id alongside the label, so actions can be driven by keyboard, automation and analytics without string-matching the label.
* **The action set is finite and enumerated.** Reply, react, add reaction, edit, delete, pin/unpin, bookmark/save, reminder, forward, copy text, copy link, copy id, mark unread, report, start thread, view thread, publish, open in browser — plus per-message extras (run app command, assign) only where the domain actually has them.
* **Reply and thread are separate actions with separate targets.** Reply targets the current channel (and may cross-post to another channel); thread creates a new conversation. They must never be merged into one "respond" action.
* **Notifications are a property of the action, not a side effect.** Only actions that target another member (reply with mention, thread start, thread member add) may notify; editing, deleting, pinning, bookmarking and copying never notify.
* **Bulk variants are explicit.** Removing all reactions is a distinct action from removing one, with its own confirm.
* **The hover toolbar is conditionally mounted.** The action buttons are not in the DOM for unhovered rows; the reaction strip and the action row are separate.
* **Keyboard access mirrors the pointer surface.** The same actions are reachable without a pointer, and the list's own key handling (arrows, Page, Home, End) does not conflict with the message's.
* **Missing actions are honest.** CrowdOS must not ship a disabled placeholder for an action the domain does not implement.

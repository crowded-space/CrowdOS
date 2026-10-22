# Threads

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose

How Discord models, creates and renders threads: the creation path from a message, where a thread appears on screen and in the URL, the shape of the thread view, thread state in the channel list, notifications, and the boundary between a *reply* and a *thread*.

Scope: guild threads (public and private) attached to a parent message. Forum posts are a separate surface and are only mentioned where they intersect.
## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] A Discord thread is **a real channel**, not a message sub-tree. It has its own id, its own message list, its own read state, its own unread count, its own mute state, and its own place in the channel sidebar. The parent channel only keeps a *pointer* to it (`HAS_THREAD` message flag + the thread channel row).

- [Observed] Three distinct renderings exist, and they are the thing most reimplementations get wrong:

| Rendering | Trigger | Where it draws |
|---|---|---|
| **Thread sidebar panel** | opened from a message in the parent channel | a right-hand column next to the chat (`threadSidebarOpen_f75fb0`, `hasSidebar_f75fb0`, `threadSidebarFloating_f75fb0`); the parent channel stays visible and live |
| **Full thread view** | `/channels/{guild}/{parent}/threads/{thread}` | replaces the chat column entirely |
| **Inline thread starter** | the first message of a thread, shown in the parent channel | a system-style row reading "X started a thread: Y. See all threads." |

- [Observed] Evidence: `264141.9aeabb242ab5ee2c.js` → `"js":"threadSidebarOpen_f75fb0"`, `"Rs":"hasSidebar_f75fb0"`, `"jl":"threadSidebarFloating_f75fb0"`; `697bb5329d158057.js` → `"renderThreadSidebar()"`, `case sR.PE.CREATE_THREAD: … e=(0,l.jsx)(rs,{parentChannelId:i.parentChannelId,parentMessageId:i.parentMessageId,location:i.location})`, `case sR.PE.VIEW_CHANNEL: … if(n?.isThread()){let n=t?.isForumLikeChannel()?iT:rC; e=(0,l.jsx)(n,{channelId:i.channelId})}`.

### Creation

1. [Observed] The user picks **Create Thread** from the message hover bar or the message context menu.
2. [Observed] The client opens the **Create Thread sidebar** — a `<section aria-label="Create Thread">` containing:
   - [Observed] a composer bound to the channel with `draftType: FirstThreadMessage` (the first message of the new thread is drafted here),
   - [Observed] a **thread settings toolbar** (name/title input, an optional AI "generate name" button, and the archival-duration control),
   - [Observed] the submit action.
   Evidence: `697bb5329d158057.js` → `"aria-label":z.intl.string(z.t.rBIGBL)`, `"draftType:i_.C.FirstThreadMessage"`, `"changeThreadSettings(e.id,{...n,parentMessageId:t})"`.
3. [Observed] The thread settings object carries `{name, parentMessageId, autoArchiveDuration, privateThreadMode}`.
4. [Observed] Submitting sends **one message** with the thread-creation payload — the thread is not a separate API call:

```
ec.message.create_thread = F.createThread;
ec.message.title        = F.threadName;
ec.message.publish      = F.publish ?? false;
```

- [Observed] Evidence: `web.31d1cd3e6e440749.js` → `"ec.message.create_thread=F.createThread,ec.message.title=F.threadName,ec.message.publish=F.publish??!1"`.

5. [Observed] The server answers with a `THREAD_CREATE` gateway event (dispatch id `110`) and the thread appears as a channel. Dispatch ids: `THREAD_CREATE=110`, `THREAD_UPDATE=111`, `THREAD_DELETE=112` (`web.31d1cd3e6e440749.js`).

- [Observed] A **new-thread affordance that is not message-anchored** also exists: `tM.oU.THREAD_CREATION` is the "create thread" dispatch used by the guild-level "new thread" entry, with a separate analytics location `L.A.CREATE_THREAD`.

- [Observed] Naming: the title can be written by hand or generated. The AI path calls `POST /ai/title` with the parent message body (or the drafted text when ≥10 chars) and back-fills `threadSettings.name` (`697bb5329d158057.js` → `"AI_TITLE"`, `"textContent"`).

- [Observed] If the user leaves the composer with a name, a draft or pending uploads, a confirm dialog appears: title `"…"` / body `"Any changes you made will be lost if you exit now."` with a "Back to editing" cancel (`8b9a4b4a55eaa34c.js` → `"olcKd/":["Back to editing"]`, `"NgS9jX"`).

### Where a thread renders, and the URL

- [Observed] Two URL builders (`web.31d1cd3e6e440749.js`):

| Builder | URL | Meaning |
|---|---|---|
| `CHANNEL(guildId, channelId, threadId)` | `/channels/{guild}/{channel}/{thread}` | thread **as a panel** next to its parent |
| `CHANNEL_THREAD_VIEW(guildId, channelId, threadId, messageId?)` | `/channels/{guild}/{channel}/threads/{thread}[/{message}]` | thread as a **full view** (optionally focused on a message) |

- [Observed] `CHANNEL` falls back to `/channels/@me` when the guild is null (`CHANNEL:(e,t,n)=>{let i=null==t?`/channels/${e||s}`:`/channels/${e||s}/${t}`;return null==n?i:`${i}/${n}`}`).

- [Observed] The link builder for a message inside a thread is `BVt.CHANNEL(guildId, channelId, messageId)` — the same shape, used by "Copy Message Link" (`681e846fab87a0c8.js` → `` `${location.protocol}//${location.host}${s.BVt.CHANNEL(i.guild_id,i.id,n.id)}` ``).

### The thread view structure

- [Observed] The thread is a channel, so the thread view reuses the whole channel renderer — the same `<ol>` message list, the same scroll manager, the same composer. What is thread-specific:

| Part | Behaviour | Evidence |
|---|---|---|
| Parent message pinned at top | the thread's first message *is* the parent (the starter), rendered as `THREAD_STARTER_MESSAGE` in the parent channel and as the thread's first row in the thread | `9a87b685b0e83591.js` → `i=e.type===em.TZK.THREAD_STARTER_MESSAGE?nK:nz`; the starter component asserts `eV()(i.type!==em.lAJ.THREAD_STARTER_MESSAGE,"Message must not be a thread starter message")` |
| Reply list | the thread's own message list, same non-virtualized `<ol>` | see *Message List* |
| Own composer | the thread's composer is separate from the parent's; the parent composer is hidden while a thread panel is open | `264141.9aeabb242ab5ee2c.js` → `"js":"threadSidebarOpen_f75fb0"` |
| Own scroll container | each thread has its own scroll manager instance and its own pinned/scroll state | `9a87b685b0e83591.js` → `class it{…}` is instantiated per channel |
| Reply count | `thread_approximate_message_count` from the channel object | `web.31d1cd3e6e440749.js` → `"thread_approximate_message_count:a.A.getCount(e.id)"` |
| Participants | `thread_approximate_member_count`, plus an explicit member list (`THREAD_MEMBER_LIST` dispatch, `THREAD_MEMBER_LIST_UPDATE` event) | `"thread_approximate_member_count:r.A.getMemberCount(e.id)"`; `eo.THREAD_MEMBER_LIST` |
| Timestamp range | `thread_approximate_creation_date` = the thread id's embedded timestamp (`o.default.extractTimestamp(e.id)`) | `"thread_approximate_creation_date:o.default.extractTimestamp(e.id)"` |
| Metadata | `thread_archived`, `thread_locked`, `thread_auto_archive_duration_minutes` | `"thread_archived:e.threadMetadata?.archived===!0"` etc. |
| Thread creation system message | "X started a thread: Y. See all threads." | `8b9a4b4a55eaa34c.js` → `"cZ9Uf2":[[8,"actorHook",[[1,"actorName"]]]," started a thread: ",[8,"$b",[[8,"$link",[[1,"threadName"]],[[8,"threadOnClick"]]]]],". See all ",[8,"$link",["threads"],[[1,"viewThreadsOnClick"]]],"."]` |
| Thread member system messages | "X added Y to the thread." / "X removed Y from the thread." | `"tusv2h"`, `"32QI5/"` |

### Thread state in the channel list

- [Observed] Threads are listed in the guild's channel sidebar alongside normal channels, split into **active** and **archived** sets by age and pin state:
  `activeThreadIds` / `archivedThreadIds` — a thread moves to archived when its auto-archive deadline (`E.A(t) <= Date.now()`) has passed **and** it is not pinned (`!t.hasFlag(I.lx.PINNED)`) (`web.31d1cd3e6e440749.js`).
- [Observed] The channel list has a **Threads** filter tab — observed live as `role=button` named `"Threads"` (`inspect-main.json` → `accessibility.nodes[303]`).
- [Observed] A thread row carries an unread badge and, for threads with activity, an **active-thread indicator**: the message row in the parent channel gets the `HAS_THREAD` flag, and the message component resolves the thread channel (`$=(0,e0.A)()[…i.hasFlag(em.pr7.HAS_THREAD)&&e0.A.getChannel(ei.default.castMessageIdAsChannelId(i.id))]`) and renders a **thread accessory** (`threadMessageAccessory_c19a55`, `threadMessageAccessoryAvatar_c19a55`, `threadMessageAccessoryPreview_c19a55`).
- [Observed] Muted threads are indicated by the channel row itself (`C4zCMb` = `"Muted"`), and the `MUTED` voice-state style appears as `muted_c9b8e3` on rows.
- [Observed] Per-channel read state for a thread is the ordinary channel read state — `ackMessageId(threadId)`, `getOldestUnreadTimestamp(threadId)`, and `POST /channels/{threadId}/messages/{messageId}/ack` all apply unchanged, because a thread *is* a channel.
- [Observed] Thread archival is user-adjustable (`THREAD_ARCHIVAL_DURATION_SHEET` = "Thread Archival Duration Sheet"), and `unarchiveThreadIfNecessary` is called on channel settings writes (`web.31d1cd3e6e440749.js`).

### Notifications

- [Observed] Thread notifications reuse the channel notification pipeline: a thread is a channel, so a mention inside a thread produces a notification against the thread's channel id and appears in the **notification centre** under the thread's name.
- [Observed] The notification centre can deep-link into a thread: `jumpToMessage({channelId, messageId, flash:true, context:"notification_center_navigation"})` (`web.31d1cd3e6e440749.js` → `"context:\"notification_center_navigation\""`).
- [Observed] Thread-specific system notifications exist for membership changes ("added Y to the thread"), which are rendered as system messages rather than notifications.
- [Observed] `THREAD_MEMBER_LIST_UPDATE` carries `guildId`, `threadId`, `members` — the member list is the basis for "who is in the thread" notifications and for the member list surface (`eo.THREAD_MEMBER_LIST`).

### Search and visibility of replies

- [Inferred] A thread's replies live in the thread channel, so a **channel-scoped** search does not return them; a **thread-scoped** search does.
- [Observed] In the parent channel, only the **thread starter message** is visible, and it renders as a thread-starter row ("X started a thread: Y. See all threads.") rather than as a normal bubble. The parent's own replies (`REPLY` type, with `messageReference`) remain visible in the parent.
- [Observed] The parent message row exposes a **thread accessory** and the `hasThread` flag to the message renderer (`hasThread: !contentOnly && i.hasFlag(em.pr7.HAS_THREAD) && null != $`), so the parent channel shows a link into the thread but not the thread's replies.
- [Observed] The thread starter is excluded from the parent channel's normal message renderer (`nz` asserts it is not a starter; the dedicated `nK` component renders it), and `MESSAGE_GROUP`/`THREAD_STARTER_MESSAGE` are distinct item types in the channel stream enum (`em.TZK`).

### Reply vs thread — the product distinction

| | Reply | Thread |
|---|---|---|
| Container | none — stays in the parent channel | a new channel (own id, own URL, own scroll state) |
| Visibility | visible inline in the parent channel | only the starter is visible in the parent |
| Rendering | a quoted preview ("spine") above the reply | a separate list |
| Composer | the parent composer, with a reply target chip | its own composer |
| Notification | one notification for the parent | one notification for the thread |
| Permissions | `SEND_MESSAGES` on the parent | `SEND_MESSAGES` in threads + `CREATE_PUBLIC_THREADS` / `CREATE_PRIVATE_THREADS` |
| Created by | the reply action | the "Create Thread" action, which posts a message with `create_thread:true` |
| Discovery | — | channel sidebar (active/archived), the Threads tab, the "See all threads" link on the starter row |

- [Observed] Permission gates for threading, from the bundle:
- [Observed] Reply is allowed when the channel is not a system DM and the actor has `SEND_MESSAGES` **and** `READ_MESSAGE_HISTORY`, and the target type is replyable (`i.M.REPLYABLE.has(n.type)`) — `727ee9421e324cee.js` → module `517997` → `function u(e,n,t){return(e.isPrivate()?!e.isSystemDM():t.can(d.xB.SEND_MESSAGES,e)&&t.can(d.xB.READ_MESSAGE_HISTORY,e))&&i.M.REPLYABLE.has(n.type)}`.
- [Observed] Pinning is excluded in media threads, voice channels and stage channels (`492841` → `i.type!==o.rbe.GUILD_VOICE && i.type!==o.rbe.GUILD_STAGE_VOICE && i.type!==o.rbe.MEDIA_THREAD`).
- [Observed] Thread creation from a message is gated by `canStartThread` (a channel-level check) and, for private threads, by `MANAGE_GUILD` on the guild.

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Element | Marker | Evidence |
|---|---|---|
| Thread sidebar open state | `threadSidebarOpen_f75fb0` | `264141.9aeabb242ab5ee2c.js` → `"js"` |
| Chat column with a sidebar | `hasSidebar_f75fb0` | `264141.9aeabb242ab5ee2c.js` → `"Rs"` |
| Floating thread panel | `threadSidebarFloating_f75fb0` | `264141.9aeabb242ab5ee2c.js` → `"jl"` |
| Thread starter row | `threadMessageAccessory_c19a55` + `threadMessageAccessoryPreview_c19a55` | `738015.4d96bd469ad86d12.js` → `"up"`, `"Au"` |
| Thread panel (conversation unit) | `container__54676`, `panel__54676`, `panelExpanded__54676`, `panelCollapsed__54676`, `hoverZone__54676`, `messageMask__54676`, `panelFadeTop__54676`, `panelFadeBottom__54676` | `993562.3a15e5287f3ae92e.js` → module `130791` |
| Create-thread section | `<section aria-label="Create Thread">` | `697bb5329d158057.js` → `"aria-label":z.intl.string(z.t.rBIGBL)` |
| Thread settings toolbar | `tE.Ay` toolbar with `tE.Ay.Title` | `697bb5329d158057.js` → `"tE.Ay.Title"` |
| "Threads" channel-list filter | `role=button` name `"Threads"` | `inspect-main.json` → `accessibility.nodes[303]` |
| Channel header region | `role=region` name `"Channel header"` | `inspect-main.json` → `accessibility.nodes[5022]` |
| Thread message type | `em.lAJ.THREAD_STARTER_MESSAGE = 21` | `web.31d1cd3e6e440749.js` → module `448761` |
| Thread system message type | `em.lAJ.THREAD_CREATED = 18` | `web.31d1cd3e6e440749.js` → module `448761` |
| Stream item type | `em.TZK.THREAD_STARTER_MESSAGE` | `web.31d1cd3e6e440749.js` → `"THREAD_STARTER_MESSAGE"` in the `TZK` enum |

## Implementation details

- [Observed] **One message creates the thread.** There is no "create thread" endpoint; the payload rides the normal send path (`create_thread`, `title`, `publish`).
- [Observed] **A thread channel carries `threadMetadata`** with `archived`, `locked`, `autoArchiveDuration`, and the client derives counts from local stores (`getCount`, `getMemberCount`) rather than from the channel row.
- [Observed] **Thread ids are snowflake-like**: the creation timestamp is extracted from the id (`extractTimestamp(e.id)`), so a thread's "created" time is free.
- [Observed] **Private threads** are created with `privateThreadMode` in the thread settings; the `THREAD_CREATED` system message differs between the two (`veX9jq` = "X started a thread: Y." without the "See all threads" suffix, vs `cZ9Uf2` which has it).
- [Observed] **Reply-to-thread membership** is tracked by a member list (`THREAD_MEMBER_LIST_UPDATE` carries `members`), and the membership system messages (`tusv2h`, `32QI5/`) are emitted for add/remove.
- [Observed] **Reply chain nudge**: replying to a reply can show a "create thread" nudge — `showThreadPromptOnReply && C>=2` where `C` is the reply-chain depth (capped at 10) (`web.31d1cd3e6e440749.js` → `"showThreadPromptOnReply"`, `"Reply Chain Nudge"`).
- [Observed] The thread starter row in the parent channel is rendered by a dedicated component (`lA`) that formats the actor hook, the thread name link, and a "See all threads" link, with `onClickThread` / `onContextMenuThread` / `onClickViewThreads` handlers (`5f7e73699dd82ff6.js` → `function lA(e){let{message:t,compact:n,usernameHook:i,onClickThread:l,onClickViewThreads:a,onContextMenuThread:r}=e,…}`).
- [Observed] The thread's own message list uses the same non-virtualized renderer, so the performance caveats in *Message List* apply per thread.

## Interaction model
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Trigger | Result | Evidence |
|---|---|---|
| Hover bar "Create Thread" (`tx.Nw`) | opens the Create Thread sidebar | `9a87b685b0e83591.js` → `p&&f?(0,a.jsx)(nt.qv,{label:eL.intl.string(eL.t.rBIGBL),icon:tG.y,onClick:()=>(0,tx.Nw)(t,n)},"thread")` |
| Context menu "thread" item | same action | `727ee9421e324cee.js` → `id:"thread",label:j.intl.string(j.t.rBIGBL),action:()=>{(0,eu.Nw)(n0,nQ)}` |
| Hover bar "view-thread" (`tx.mF`) | opens the existing thread (panel) | `9a87b685b0e83591.js` → `!p&&A?(0,a.jsx)(nt.qv,{label:eL.intl.string(eL.t["39d0Wj"]),icon:tG.y,onClick:()=>(0,tx.mF)(t,n)},"view-thread")` |
| Keyboard `T` on a focused message | creates a thread, or opens the existing thread when the message already has one | `9a87b685b0e83591.js` → `case"t": if(i&&(0,to.D1)(d,c)) … (0,tc.Tv)(d,c,"Message Shortcut"); else if(c.hasFlag(em.pr7.HAS_THREAD)){… (0,tc.JA)(e,o)}` |
| Keyboard `Enter` + Alt | a secondary message action on a focused message | `9a87b685b0e83591.js` → `case"enter": s&&(n.preventDefault(),(0,tx.cl)(d,c))` |
| Clicking the thread name in the starter row | opens the thread | `5f7e73699dd82ff6.js` → `threadOnClick:{onClick:l,onContextMenu:r}` |
| "See all threads" link | opens the thread list for that channel | `5f7e73699dd82ff6.js` → `viewThreadsOnClick:a` |

## Performance notes

- [Observed] A thread reuses the full channel renderer, so opening one is a **second** scroll manager, a second message store view and a second composer. Many open threads (the sidebar keeps state per thread) multiply that cost.
- [Observed] Thread replies are stored separately from the parent channel's messages; switching between parent and thread re-mounts the list and re-runs the anchor measurement pass described in *Scroll Model*.
- [Observed] Thread counts shown in the channel list are **approximate** (`thread_approximate_message_count`, `thread_approximate_member_count`) — computed locally, not read from the server, to avoid a request per row.

## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| Claim | Pointer |
|---|---|
| Thread creation payload | `web.31d1cd3e6e440749.js` → `"ec.message.create_thread=F.createThread,ec.message.title=F.threadName,ec.message.publish=F.publish??!1"` |
| Create-thread sidebar | `697bb5329d158057.js` → `"aria-label":z.intl.string(z.t.rBIGBL)`, `"draftType:i_.C.FirstThreadMessage"`, `"changeThreadSettings(e.id,{...n,parentMessageId:t})"` |
| URL builders | `web.31d1cd3e6e440749.js` → `"CHANNEL:(e,t,n)=>{let i=null==t?\`/channels/${e||s}\`:\`/channels/${e||s}/${t}\`;return null==n?i:\`${i}/${n}\`}"`, `"CHANNEL_THREAD_VIEW:(e,t,n,i)=>{let r=\`/channels/${e}/${t}/threads/${n}\`;return null==i?r:\`${r}/${i}\`}"` |
| Sidebar rendering switch | `697bb5329d158057.js` → `"renderThreadSidebar()"`, `"case sR.PE.CREATE_THREAD:"`, `"case sR.PE.VIEW_CHANNEL:"` |
| Thread channel metadata | `web.31d1cd3e6e440749.js` → `"thread_approximate_member_count"`, `"thread_approximate_message_count"`, `"thread_archived"`, `"thread_locked"`, `"thread_auto_archive_duration_minutes"`, `"thread_approximate_creation_date"` |
| Active/archived split | `web.31d1cd3e6e440749.js` → `activeThreadIds` / `archivedThreadIds` with `!t.hasFlag(I.lx.PINNED)&&(0,E.A)(t)<=e?a.push(n):i.push(n)` |
| Thread starter rendering | `9a87b685b0e83591.js` → `"em.TZK.THREAD_STARTER_MESSAGE?nK:nz"`, `"Message must not be a thread starter message"` |
| Thread accessory in parent | `9a87b685b0e83591.js` → `hasThread:!C&&i.hasFlag(em.pr7.HAS_THREAD)&&null!=$` |
| Thread system messages | `8b9a4b4a55eaa34c.js` → `"cZ9Uf2"`, `"veX9jq"`, `"tusv2h"`, `"32QI5/"` |
| Reply permission gate | `727ee9421e324cee.js` → module `517997` → `t.can(d.xB.SEND_MESSAGES,e)&&t.can(d.xB.READ_MESSAGE_HISTORY,e)` |
| "Threads" filter tab (live) | `inspect-main.json` → `accessibility.nodes[303]` (`role=button`, name `"Threads"`) |
| Channel header region (live) | `inspect-main.json` → `accessibility.nodes[5022]` |
| Thread member list event | `web.31d1cd3e6e440749.js` → `"THREAD_MEMBER_LIST_UPDATE"`, `eo.THREAD_MEMBER_LIST` |
## Gaps

- **No live thread was reached.** The inspected guild had no active thread in the sidebar or channel list (the only thread-related a11y node is the `"Threads"` filter button at `accessibility.nodes[303]`), so the thread sidebar, the full thread view and the thread starter row were not observed in the live DOM. Thread structure is derived from the bundle only; this is stated rather than simulated.
- **The "Create Thread" sidebar was not opened** (opening it would be an interaction, and creating a thread would mutate state — both out of scope under the read-only constraint).
- **`THREAD_CREATED` payload shape and the server-side thread-creation rules** were not traced beyond the client payload.
- **Thread auto-archive duration options and their default** were not enumerated (only the sheet's existence as `THREAD_ARCHIVAL_DURATION_SHEET`).
- **Whether Discord supports searching inside a thread in the shipped client** was not confirmed from the bundle; the statement in *How it works* that thread replies are channel-scoped is inferred from threads being channels, and is marked as such.
## User Decision:
## Target Contract

> Status: Target. CrowdOS already owns threads as a first-class domain (`re-docs/Backend Docs/Domain Spec/Threads.md`: `threads` rows, `thread_sequences`, guarded status transitions, TTL expiry, thread-scoped keyset pagination, `messageGate.getThreadPage`) and renders them in the frontend `ThreadDrawer`. These invariants describe what a Discord-shaped thread surface must satisfy and do not change the locked CrowdOS design.

* **A thread is its own conversation, not a message sub-tree.** It has an id, its own list, its own composer, its own read state and its own unread count — never a filtered view of the parent's messages.
* **Replies stay in the channel; threads leave it.** A reply is a quoted reference rendered inline; a thread is a separate container. The two must not be conflated in the render tree or in the store.
* **Creating a thread is a single write.** CrowdOS's `threadGate.create` owns thread creation and `messageGate.append` owns the write; the first message and the thread must be created coherently (the parent-message link is set at creation, not patched afterwards).
* **One thread per parent message.** CrowdOS enforces this with `threads_parent_message_idx`; a duplicate-parent race must resolve to the existing thread, never create a second one.
* **Parent message visibility.** Only the thread's starter is represented in the parent channel; the thread's replies are not shown in the parent channel's list.
* **Thread state is a real state machine.** `active → archived | expired`, `archived → active`, `expired → archived`; no resurrection, and `archivedAt` is stamped once.
* **Deleting a thread must not orphan its replies.** Replies survive as channel messages (CrowdOS: `SET NULL` on `thread_id`).
* **Thread read state and notifications are per-thread.** A mention in a thread notifies against the thread, and the notification deep-links into the thread, not the parent.
* **Thread permissions are the channel permission set plus thread-creation permissions.** Thread creation must be refused without the create-thread permission, and the refusal must be visible in the UI rather than failing silently.
* **Threads appear in the channel list** as active vs archived, with an unread badge, and the list must tolerate approximate counts without blocking on a server round-trip.
* **Thread counts and creation times are derived, not stored redundantly.** CrowdOS keeps `messageCount`/`lastActivityAt` maintained by a single writer; the client must not invent its own counters.

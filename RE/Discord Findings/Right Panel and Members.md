# Right Panel and Members

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of everything Discord renders **to the right of the chat column**: the member list, the pinned-messages surface, the threads surface, and the other right-hand panels Discord exposes. Covers the member list's grouping rule (exact), ordering, role colouring, per-member indicators, the hover/context affordances, the "add friends" affordance, toggleability and width behaviour. Visual style is out of scope.

Target build analysed: Discord 1.0.9264, Electron 42.11.15 (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`).

**Scope correction, stated up front:** in the captured session the right-hand column was **closed** — the channel header exposed `button "Show Member List"`. The read-only constraint for this task forbids activating it. Member-list *behaviour* below is therefore taken from the shipped bundle (authoritative static source); the *closed-state* DOM/a11y evidence is live. Every bundle-derived claim is marked `[Inferred]` or `[Observed-from-bundle]` accordingly.

## How it works

Discord does **not** have a permanent right column with tabs. The right of the chat is occupied by one *optional* column — the member list — and by **popovers anchored to the channel header** that overlay that space transiently.

| Right-side surface | Kind | Anchor / trigger | Evidence |
| --- | --- | --- | --- |
| Member list | Full-height column, left of window edge | `button "Show Member List"` in channel header | `inspect-main.json` → `accessibility.nodes[333]`; `8b9a4b4a55eaa34c.js` → `"gxChDx":["Show Member List"]` / `"Axvx8c":["Hide Member List"]` |
| Thread member list | Column variant | thread surface | `web.31d1cd3e6e440749.js` → `"THREAD_MEMBER_LIST=\"Thread Member List\""` |
| Pinned messages | Popover (`expanded` toggles) | `button "Pinned Messages"` | `inspect-main.json` → `accessibility.nodes[332]`; `8b9a4b4a55eaa34c.js` → `"mp1N/2":["Pinned Messages"]`, `"2BSH7n":["Pins"]` |
| Threads | Popover (`expanded` toggles) | `button "Threads"` | `inspect-main.json` → `accessibility.nodes[330]` |
| Notification settings | Popover (`expanded` toggles) | `button "Notification Settings"` | `inspect-main.json` → `accessibility.nodes[331]` |
| Activity panel | Column (voice/activity contexts) | — | `web.31d1cd3e6e440749.js` → `"ACTIVITY_PANEL=\"Activity Panel\""` |
| Account panel | Column (user popout) | — | `web.31d1cd3e6e440749.js` → `"ACCOUNT_PANEL=\"Account Panel\""` |
| Chat sidebar | Column | — | `web.31d1cd3e6e440749.js` → `"CHAT_SIDEBAR=\"Chat Sidebar\""` |
| Friends list | Column (DM home) | — | `web.31d1cd3e6e440749.js` → `"FRIENDS_LIST=\"Friends List\""` |
| Add-friends widget / popout / modal | Overlay | — | `web.31d1cd3e6e440749.js` → `"ADD_FRIENDS_WIDGET=\"Add Friends Widget\""`, `"ADD_FRIENDS_POPOUT=\"Add Friends Popout\""`, `"ADD_FRIENDS_MODAL=\"Add Friends Modal\""` |

There is **no tab strip** in the right pane. Discord's chat is a single right column; the other right-side surfaces are popovers/columns opened on demand. The bundle string `"Search, members, media, pins, threads, and more"` (`8b9a4b4a55eaa34c.js`) is the description of the **command palette**, not a right-pane tab set.

### Verified behaviour
- `[Observed]` The right of the chat was **empty** in the captured session — the `main` landmark has no sibling column, and the only right-side affordances are the four channel-header buttons (`accessibility.nodes[108]`, `[330..333]`).
- `[Observed]` The right-pane toggle is a channel-header `button "Show Member List"`; the string flips to `"Hide Member List"` when open (`accessibility.nodes[333]`; `8b9a4b4a55eaa34c.js` → `"gxChDx"`, `"Axvx8c"`).
- `[Observed]` Pins and threads are **popovers on the header** (`aria-expanded` toggles), not tabs in a right column (`accessibility.nodes[330]`, `[332]`).
- `[Observed]` There is no right-pane tab strip in the captured accessibility tree; the only right-of-chat surfaces in the bundle are single-purpose columns (`"Member List"`, `"Activity Panel"`, `"Account Panel"`, `"Chat Sidebar"`, `"Friends List"`).
- `[Observed-from-bundle]` The member-list group key is `status !== OFFLINE && status !== INVISIBLE ? (hoistRoleId ?? "online") : "offline"` — so grouping is **role-first, status-second** and offline members never keep their role group (`web.31d1cd3e6e440749.js` → `l=a!==I.clD.OFFLINE&&a!==I.clD.INVISIBLE?n?.hoistRoleId??"online":"offline"`).
- `[Observed-from-bundle]` Members inside a group are ordered by lowercased display name and inserted at their sorted position, not appended (`web.31d1cd3e6e440749.js` → `d=n?.nick??f.Ay.getName(i);return[l,d?.toLowerCase(),s]`, `findUserIdSortedPosition`).
- `[Observed-from-bundle]` A member's displayed colour comes from the **highest role with `color > 0`**; the hoist role is the highest role with `hoist`; the two are computed independently in one pass (`web.31d1cd3e6e440749.js` → `t.color>0&&…`, `t.hoist&&…`).
- `[Observed-from-bundle]` The role chip is the name span itself (`et.Xh`), coloured by `colorString` and given the role name for gradient rendering — there is no separate pill node (`web.31d1cd3e6e440749.js` → `<span className:et.Xh>` wrapping `{roleName, colorString, colorStrings, name, className:et.UU}`).
- `[Observed-from-bundle]` Offline members get a distinct class only when not selected (`et.WK` applied when `status === OFFLINE && !selected`).
- `[Observed-from-bundle]` Authority refusals are rendered as a reason on the control, not by hiding it: `"Cannot action this member"`, `"This person has a higher role than you, so you cannot manage them."`, `"This person's highest role is the same as yours, so you cannot manage them."` (`8b9a4b4a55eaa34c.js`).
- `[Observed-from-bundle]` The owner is a guild-level fact, not a role, and Discord **hides** the owner id entirely when a hoisted role carries `ADMINISTRATOR` (`web.31d1cd3e6e440749.js` → `function B(e){return r().some(…,e=>e.hoist&&(0,h._m)(e,C.xBc.ADMINISTRATOR))?void 0:e.ownerId??void 0}`).
- `[Observed-from-bundle]` The add-friends affordance lives inside the member list — the telemetry event is literally `member_list_add_members_clicked` (`web.31d1cd3e6e440749.js`).
- `[Observed-from-bundle]` The member list store batches: more than 50 changed users trigger a full `rebuild()`, fewer patch per user, and a `version` counter drives re-render (`web.31d1cd3e6e440749.js` → `e.length>50?this.rebuild():e.forEach(…)`, `this.version++`).
- `[Observed-from-bundle]` Member rows carry full ARIA list semantics: `aria-posinset`, `aria-setsize`, `aria-controls`, `aria-expanded`, `id`, `tabIndex`.
- `[Inferred]` The right pane is a *view* toggle owned by the client, not a permission: nothing in the toggle path checks a permission, and the label is a plain affordance.
- `[Inferred]` Group render order follows the role hierarchy (`getSortedRoles`), because the store keeps `sections` as an unordered map and the natural key for a hoist-role id is its position.

## Structural inventory

### Member list — grouping and ordering (exact rule)
The one complete member-list implementation in the bundle is the thread member list store, and its grouping rule is the same one the channel member list uses.

| Aspect | Rule | Evidence |
| --- | --- | --- |
| Group key | `status !== OFFLINE && status !== INVISIBLE ? (member.hoistRoleId ?? "online") : "offline"` | `web.31d1cd3e6e440749.js` → `l=a!==I.clD.OFFLINE&&a!==I.clD.INVISIBLE?n?.hoistRoleId??"online":"offline"` |
| Group membership | one group per **hoisted role** (the highest role with `hoist: true`), plus a synthetic `"online"` group for online members with no hoisted role, plus a single `"offline"` group | same expression; group id is the role id itself |
| Offline rule | OFFLINE **and** INVISIBLE members are always bucketed into `"offline"` — a member's hoisted role does **not** create an offline sub-group | same expression |
| Ordering inside a group | by lowercased display name (`nick ?? username`), inserted at the first position where the new name sorts before the incumbent | `web.31d1cd3e6e440749.js` → `d=n?.nick??f.Ay.getName(i);return[l,d?.toLowerCase(),s]` and `findUserIdSortedPosition(e,t,n)` |
| Ordering of groups | `[Inferred]` role hierarchy order — the store keeps `sections` as an **unordered** map keyed by section id, so the render order is a component concern; the natural key for a hoist-role id is the role's position, which `getSortedRoles(guildId)` provides | `web.31d1cd3e6e440749.js` → `this.sections={}` (no order field); `T.A.getSortedRoles(e.id)` |
| Visibility filter | per-member `canViewChannel` computed with the `VIEW_CHANNEL` permission against the current channel context | `web.31d1cd3e6e440749.js` → `A.$3({permission:I.xBc.VIEW_CHANNEL,user:i,context:t})` |
| Section fallback label | `"Other Members"` | `8b9a4b4a55eaa34c.js` → `"mIx+gG":["Other Members"]` |

The grouping is therefore **role-first, status-second** — not status-first. A hoisted role is a group header; status only decides whether a member lands in their role group or in the trailing offline group.

### Member list — role-derived presentation
`web.31d1cd3e6e440749.js` → the member badge resolver computes four role-derived facts in one pass over the member's roles:

| Fact | Selection rule | Bundle symbol |
| --- | --- | --- |
| `colorString` | highest role with `color > 0` | `t.color>0&&(null==n||(0,T.zA)(t,n))&&(n=t)` |
| `hoistRoleId` | highest role with `hoist` | `t.hoist&&(null==i||(0,T.zA)(t,i))&&(i=t)` |
| `iconRoleId` | highest role with an icon or unicode emoji | `t.icon||t.unicodeEmoji` branch |
| `highestRoleId` | overall highest role | `null==a||(0,T.zA)(t,a)&&(a=t)` |

Role comparison `(0,T.zA)(t,a)` is the role-position comparator. The role object itself carries the full authority payload: `web.31d1cd3e6e440749.js` → `permissions:…, mentionable:…, position:…, color:…, colorString:…, hoist:…, managed:…, tags:…, icon:…, unicode_emoji:…`.

### Member row component
`web.31d1cd3e6e440749.js` → the memoised row component `ec` (member-list row) takes:

| Prop group | Props |
| --- | --- |
| Identity | `user`, `nick`, `currentUser`, `guildId`, `channel` |
| Role presentation | `colorString`, `colorStrings`, `colorRoleName` |
| Authority | `isOwner`, `ownerTooltipText`, `lostPermissionTooltipText` |
| Presence | `status`, `activities`, `applicationStream`, `isTyping`, `shouldAnimateStatus`, `isMobile`, `isVR`, `premiumSince`, `nameplate`, `quest` |
| View | `selected`, `className`, `hideClanTag`, `hideSubtext`, `hideTooltip` |
| Interaction | `onClick`, `onKeyDown`, `onMouseDown`, `onContextMenu`, `onClickPremiumGuildIcon` |
| ARIA | `id`, `tabIndex`, `aria-controls`, `aria-expanded`, `aria-posinset`, `aria-setsize` |

Rendered structure:

* Container class `et.Dc`, plus conditional `et.WK` applied when `status === OFFLINE && !selected` (offline members are dimmed **only** when not selected), plus `et.PJ`.
* Inner class `et.Hz`.
* Name is a `<span class="et.Xh">`; when `lostPermissionTooltipText` is set the name is additionally wrapped in a tooltip component and the span gains `et.oj`.
* The name body is rendered with `roleName` (= `colorRoleName`), `colorString`, `colorStrings`, `name`, `className: et.UU` — this is the **role chip**: the member's display name coloured by the highest coloured role, with the role name available for gradient/animated role rendering.
* `decorators` sub-component receives `isOwner`, `ownerTooltipText`, `lostPermissionTooltipText`, `premiumSince`.
* `avatar` sub-component receives `status`, `activities`, `applicationStream`, `isTyping`, `isMobile`, `isVR`, `avatarDecorationSrc`, `animateOnHover`.
* `subText` sub-component receives `activities`, `status`, `applicationStream`, `voiceStatusChannel`, `quest`, `hideTooltip`.

### Per-member indicators
| Indicator | Source | Evidence |
| --- | --- | --- |
| Online / Idle / DND / Offline / Streaming | `status` prop, rendered as an SVG status mask | `web.31d1cd3e6e440749.js` → `"svg-mask-status-online"`, `"svg-mask-status-idle"`, `"svg-mask-status-dnd"`, `"svg-mask-status-offline"`, `"svg-mask-status-streaming"` |
| Mobile / VR variants | `isMobile`, `isVR` | `"svg-mask-status-online-mobile"`, `"svg-mask-status-online-vr"` |
| Typing | `isTyping` + typing ref | `"svg-mask-status-typing"` |
| Screenshare | `activities` / `applicationStream` | `"svg-mask-status-screenshare"` |
| In-voice | `voiceStatusChannel` → subText `"In a Voice Channel"` | `8b9a4b4a55eaa34c.js` → `"grGyaf":["In a Voice Channel"]` |
| Listening | subText `"Listening to <name>"`, `"Listening to Spotify"`, `"Listening to a Stage"` | `"NF5xop":["Listening to ",[1,"name"]]"`, `"rmnkz4":["Listening to Spotify"]`, `"4eazb6":["Listening to a Stage"]` |
| Playing | `"Playing Multiple Games"`, `"Playing a Quest"`, `"Playing on Xbox"`, `"Playing on Spotify"` | `"sau5tt":["Playing Multiple Games"]`, `"tO8wOx":["Playing on Xbox"]` |
| Streaming | `"Streaming on Twitch"` | `"HyGHj7":["Streaming on Twitch"]` |
| Quest / launching | `"Launching <name>."` | `"WtSQwG":["Launching ",[1,"name"],"."]` |

### Authority affordances on a member row
| Condition | Surfacing | Evidence |
| --- | --- | --- |
| Target is the server owner | `isOwner` prop + crown decorator + `ownerTooltipText` = `"This person is the server owner and always has all permissions regardless of roles."` | `8b9a4b4a55eaa34c.js` → `"8qGnTC"` |
| Target cannot be acted on (permission lost) | `lostPermissionTooltipText` = `"Cannot action this member"` | `8b9a4b4a55eaa34c.js` → `"Se4c7+":["Cannot action this member"]` |
| Target outranks you | `"This person has a higher role than you, so you cannot manage them."` | `8b9a4b4a55eaa34c.js` → `"This person has a higher role than you, so you cannot manage them."` |
| Target ties your highest role | `"This person's highest role is the same as yours, so you cannot manage them."` | `8b9a4b4a55eaa34c.js` → `"This person's highest role is the same as yours, so you cannot manage them."` |
| Your own role lacks access | `"Your role does not have permission to access this channel."` | `8b9a4b4a55eaa34c.js` → `"Your role does not have permission to access this channel."` |

The owner/role-relationship messages are **explanations attached to a disabled affordance**, not hidden controls: the action target stays visible and carries a reason.

### Context / overflow menu
The member row exposes `onContextMenu`; Discord's user menu surfaces are distinct per context:

| Menu test id | Context | Evidence |
| --- | --- | --- |
| `guild channel user menu` | member in a guild channel | `web.31d1cd3e6e440749.js` → `"GUILD_CHANNEL_USER_MENU=\"guild channel user menu\""` |
| `guild user menu` | member in a guild, non-channel | `"GUILD_USER_MENU=\"guild user menu\""` |
| `guild moderation user menu` | moderation surface | `"GUILD_MODERATION_USER_MENU=\"guild moderation user menu\""` |
| `thread user menu` | thread member list | `"THREAD_USER_MENU=\"thread user menu\""` |
| `dm user menu` | DM | `"DM_USER_MENU=\"dm user menu\""` |
| `user generic menu` | generic | `"USER_GENERIC_MENU=\"user generic menu\""` |

### Add-friends affordance
| Aspect | Evidence |
| --- | --- |
| Analytics | `web.31d1cd3e6e440749.js` → `"MEMBER_LIST_ADD_MEMBERS_CLICKED=\"member_list_add_members_clicked\""` — the event name is scoped to `member_list`, confirming the affordance lives **inside the member list** |
| Labels | `8b9a4b4a55eaa34c.js` → `"zIJnA6":["Add Friends"]"`, `"w5uwoI":["Add Friend"]"`, `"9nbDJx":["Add a Friend"]"`, `"1x/UBX":["Add friends to start messaging."]`, `"6Phf4K":["Add more friends"]` |
| Surfaces | `web.31d1cd3e6e440749.js` → `"ADD_FRIENDS_WIDGET=\"Add Friends Widget\""`, `"ADD_FRIENDS_POPOUT=\"Add Friends Popout\""`, `"ADD_FRIENDS_MODAL=\"Add Friends Modal\""` |

## Implementation details

### Member list store (`ThreadMemberListStore`)
`web.31d1cd3e6e440749.js` → `class T{guildId;parentId;threadId;version=0;sections={};allUserIds=new Set;…}` and `class N extends a.Ay.Store{static displayName="ThreadMemberListStore";…}`.

| Store member | Behaviour | Evidence |
| --- | --- | --- |
| `sections` | `sectionId -> {sectionId, usersById, userIds}` — a map plus an ordered id array, so a section supports O(1) lookup and ordered iteration | `t in this.sections||(this.sections[t]={sectionId:t,usersById:{},userIds:[]})` |
| `allUserIds` | `Set` of every member currently known to the list | `this.allUserIds=new Set(e)` |
| `rebuild(e)` | full recompute: map every user to `[sectionId, displayName, canViewChannel]`, sort by user id, then `sortBy(displayName)`, then insert into sections | `this.version++,this.sections={},…` |
| `updateMultipleUserIds(e,t)` | filters to known ids; **batches above 50 ids fall back to a full `rebuild()`**, smaller batches patch per user | `e.length>50?this.rebuild():e.forEach(e=>this.updateUserId(e))` |
| `updateUserId(e)` | recompute one member's state; only moves the member if `(sectionId, displayName, canViewChannel)` actually changed | `if((t!==r||n!==a||i!==s)&&(this.removeUserId(e,t),this.addUserId(e,r,a,s),!0))` |
| `addUser(e,t,n,i,r)` | inserts into the section; new members are inserted at their sorted position rather than appended | `this.findUserIdSortedPosition(s,e,n);s.userIds.splice(t,0,e)` |
| `removeUserId(e,t)` | removes from the known set and from whichever section holds the member; returns whether anything was removed | `if(this.allUserIds.delete(e),null!=t&&this.removeUserIdFromSection(e,t))return!0;for(let t in this.sections)…` |
| `calculateNewState(e,t)` | the single source of the group key, display name and view permission for one member | see grouping rule above |
| Public API | `getMemberListVersion(e)`, `getMemberListSections(e)`, `isMember(e,t)`, `canUserViewChannel(e,t,n)` | `getMemberListVersion(e){return p[e]?.version}` |
| Store lifecycle | `syncWith` on the thread-id store prunes dead threads; `syncWith` on the user store re-derives the current user's own entry | `this.syncWith([d.A],()=>{…e.has(n)||(delete p[n],t=!0)…})` |

### Pinned messages
| Aspect | Value | Evidence |
| --- | --- | --- |
| Trigger | channel-header `button "Pinned Messages"` with `expanded=false` | `accessibility.nodes[332]` |
| Labels | `"Pinned Messages"`, `"Pins"`, `"Pinned"`, `"Pin"` | `8b9a4b4a55eaa34c.js` → `"mp1N/2":["Pinned Messages"]`, `"2BSH7n":["Pins"]`, `"1QLRYb":["Pinned"]`, `"uKw3A+":["Pin"]` |
| Permission gate | `"Users with the 'Pin Messages' permission can pin a message from its context menu."` / `"You can pin a message from its context menu."` | `8b9a4b4a55eaa34c.js` → `"KTbRcg"`, `"3dLGAs"` |
| Pin metadata | channel model carries `lastPinTimestamp` | `web.31d1cd3e6e440749.js` → `this.lastPinTimestamp=e.lastPinTimestamp` |

### Threads
| Aspect | Value | Evidence |
| --- | --- | --- |
| Trigger | channel-header `button "Threads"` with `expanded=false` | `accessibility.nodes[330]` |
| Route | `/channels/<guild>/<channel>/threads/<thread>/<message>` | `web.31d1cd3e6e440749.js` → `"^/channels/(\\d+)(?:/)(\\d+)(?:/threads/)(\\d+)(?:/)(\\d+)"` |
| Member list variant | dedicated store + dedicated test id | `"THREAD_MEMBER_LIST=\"Thread Member List\""`, `static displayName="ThreadMemberListStore"` |

### Toggleability and width
| Aspect | Value | Evidence |
| --- | --- | --- |
| Toggle control | channel-header button; label flips between `"Show Member List"` and `"Hide Member List"` | `accessibility.nodes[333]`; `8b9a4b4a55eaa34c.js` → `"gxChDx"`, `"Axvx8c"` |
| Who may toggle | every member — it is a **client view preference**, not a permission | no permission check in the toggle path; `aria` role is `button`, not gated |
| Analytics | `"member_list_viewed"`, `"member_list_toggled"`, `"member_list_swipe_peek"`, `"member_list_swipe_toggled"`, `"memberlist_content_feed_expander_toggled"`, `"memberlist_content_feed_hidden_toggled"` | `web.31d1cd3e6e440749.js` |
| Width | user-settable; the channel sidebar is separately resizable | `8b9a4b4a55eaa34c.js` → `"Adjust the space between server, channel, and member lists."`; `web.31d1cd3e6e440749.js` → `"channel_sidebar_resized"` |
| Narrow screens | the member list gets **swipe** gestures rather than a hard breakpoint | `"member_list_swipe_peek"`, `"member_list_swipe_toggled"` |
| Content feed | the member list also hosts a "content feed" region that can be expanded/hidden | `"memberlist_content_feed_expander_toggled"`, `"memberlist_content_feed_hidden_toggled"` |

## Interaction model
| Action | Target | Result | Evidence |
| --- | --- | --- | --- |
| Toggle member list | header `button "Show Member List"` | column mounts; label becomes `"Hide Member List"`; `member_list_toggled` fires | `accessibility.nodes[333]` |
| Hover a member | member row | row `hovered` state; avatar may animate (`animateOnHover`) | `web.31d1cd3e6e440749.js` → `hovered:e_`, `animateOnHover:!(t||e_)` |
| Right-click a member | member row `onContextMenu` | context menu chosen by context (guild channel / thread / DM / moderation) | `"GUILD_CHANNEL_USER_MENU"`, `"THREAD_USER_MENU"`, … |
| Click a member | member row `onClick` | opens the user profile popout (the "Account Panel" column) | `"ACCOUNT_PANEL=\"Account Panel\""` |
| Act on an outranked member | member row | action disabled with `"This person has a higher role than you, so you cannot manage them."` | `8b9a4b4a55eaa34c.js` |
| Add friends | member-list footer | `member_list_add_members_clicked`; opens the Add Friends modal/popout | `web.31d1cd3e6e440749.js` |
| Open pins | header `button "Pinned Messages"` | `expanded=true` popover | `accessibility.nodes[332]` |
| Open threads | header `button "Threads"` | `expanded=true` popover | `accessibility.nodes[330]` |
| Swipe member list (narrow) | member list | `member_list_swipe_peek` / `member_list_swipe_toggled` | `web.31d1cd3e6e440749.js` |

## Performance notes
| Aspect | Approach | Evidence |
| --- | --- | --- |
| Render invalidation | a monotonic `version` counter per member-list instance; the UI reads `getMemberListVersion()` and re-renders on change instead of deep-diffing sections | `web.31d1cd3e6e440749.js` → `this.version++`, `getMemberListVersion(e){return p[e]?.version}` |
| Incremental vs full rebuild | threshold at **50** changed users: above it, `rebuild()`; below it, per-user `updateUserId()` | `e.length>50?this.rebuild():e.forEach(e=>this.updateUserId(e))` |
| Membership test | `Set` (`allUserIds`) gives O(1) `isMember` | `isMember(e,t){let n=p[e];return null==n?null:n.allUserIds.has(t)}` |
| Section insert | ordered insert by linear scan over `userIds` (`findUserIdSortedPosition`) — O(n) per insert, O(n·m) for a full rebuild of an n-member section | `findUserIdSortedPosition(e,t,n){…}` |
| Per-user recompute cost | one member lookup + one status read + one permission evaluation (`VIEW_CHANNEL`) per user | `calculateNewState(e,t)` |
| No per-row network | the store is gateway-driven; `syncWith` on store events, not polling | `this.syncWith([d.A],()=>{…})` |

## Evidence
| ID / pointer | What it shows |
| --- | --- |
| `inspect-main.json` → `accessibility.nodes[332]`, `[333]`, `[330]`, `[331]` | The four channel-header right-side affordances and their `expanded` states, including the closed member list |
| `inspect-main.json` → `accessibility.nodes[108]` | `main` landmark of the chat column — no sibling right column exists in the captured tree |
| `web.31d1cd3e6e440749.js` → `l=a!==I.clD.OFFLINE&&a!==I.clD.INVISIBLE?n?.hoistRoleId??"online":"offline"` | The exact member-list grouping rule |
| `web.31d1cd3e6e440749.js` → `class T{…version=0;sections={};allUserIds=new Set;…}`, `class N extends a.Ay.Store{static displayName="ThreadMemberListStore"…}` | Member-list store internals: sections, version counter, rebuild threshold, ordered insert |
| `web.31d1cd3e6e440749.js` → member-row component `ec` props (`colorString`, `colorStrings`, `colorRoleName`, `isOwner`, `lostPermissionTooltipText`, `isTyping`, `aria-posinset`, `aria-setsize`, …) and `et.Dc` / `et.Hz` / `et.Xh` / `et.oj` / `et.UU` / `et.WK` class bindings | Member row structure and the role chip rendering |
| `web.31d1cd3e6e440749.js` → `t.color>0&&…&&(n=t)`, `t.hoist&&…&&(i=t)`, `getSortedRoles(e.id)` | Role colour / hoist / highest-role selection and role ordering |
| `web.31d1cd3e6e440749.js` → `"MEMBER_LIST_VIEWED"`, `"MEMBER_LIST_TOGGLED"`, `"MEMBER_LIST_SWIPE_PEEK"`, `"MEMBER_LIST_SWIPE_TOGGLED"`, `"MEMBER_LIST_ADD_MEMBERS_CLICKED"`, `"memberlist_content_feed_expander_toggled"` | Member-list interaction telemetry |
| `web.31d1cd3e6e440749.js` → `"svg-mask-status-online"`, `-idle`, `-dnd`, `-offline`, `-streaming`, `-typing`, `-screenshare`, `-online-mobile`, `-online-vr` | Presence indicator vocabulary |
| `8b9a4b4a55eaa34c.js` → `"8qGnTC"`, `"Se4c7+"`, `"mIx+gG"`, `"This person has a higher role than you…"`, `"This person's highest role is the same as yours…"`, `"Your role does not have permission to access this channel."` | Authority affordances and group fallback label |
| `8b9a4b4a55eaa34c.js` → `"gxChDx":["Show Member List"]`, `"Axvx8c":["Hide Member List"]`, `"mp1N/2":["Pinned Messages"]`, `"2BSH7n":["Pins"]`, `"KTbRcg"`, `"grGyaf"`, `"NF5xop"`, `"HyGHj7"` | Toggle labels, pins surface, permission gate, activity sub-text vocabulary |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live client identity and page target |

## Gaps
- **The member list was never observed open.** The session capture has the pane closed (`button "Show Member List"`), and activating it was out of scope for this read-only pass. The grouping rule, row structure and indicator set are bundle-derived; they were **not** cross-checked against a live open member list.
- **The "offline" group's collapse behaviour is unverified.** The group id is literally `"offline"`, but whether the section renders collapsed by default, whether it is user-collapsible, and whether it is persisted were not observed.
- **The `"online"` group's label was not read.** The synthetic group id is `"online"`; the visible header text for it (and for `"offline"`) is not in the bundle as a plain literal and was not seen live.
- **The member hover card was not observed.** The row has `onMouseEnter`/`onMouseLeave`/`hovered` state, and a popout component exists (`targetElementRef` + `renderPopout` in `web.31d1cd3e6e440749.js`), but the card's contents and its sections were not read.
- **The member row's hover "…" overflow button was not observed** as a separate node; only the context-menu path is evidenced (`onContextMenu` + the per-context user-menu test ids). Whether Discord also renders a visible "…" button on hover is unverified.
- **Whether the member list can ever become a modal** on very narrow viewports is unverified; the only narrow-width evidence is the swipe telemetry.
- **Pins and threads popover contents** were not read (both `expanded=false` in the capture); only their triggers, labels and permission strings are evidenced.
- `discord-re\screenshot-main.png` shows the same closed-pane state and adds nothing beyond the a11y tree for this surface.

## User Decision:

## Target Contract
> Status: Target. Discord is a reference source only; CrowdOS's locked design contract (§1–§34) takes precedence, in particular §5.3 (authority comes from tier, never from name or label) and §5.4 (L3 workers are stateless).

* CrowdOS MUST treat the right-hand panel as a **single optional column** with an explicit toggle owned by the channel header, exactly as Discord does — not as a permanent tab strip. If CrowdOS ever adds tabs, the tab set MUST be server-authoritative and declared, not inferred.
* The member list MUST be a **derived view over a workspace-scoped member set**, never a separately stored roster. CrowdOS's agent roster already lives behind the Agents gate; the right panel MUST read it through that gate and MUST NOT hold a second copy.
* Grouping in CrowdOS MUST NOT be role-based. Discord's grouping key is a role id; CrowdOS's authority is a **tier** (L0–L3). CrowdOS MUST group by an explicit, documented key (e.g. tier band + presence) and MUST keep the tier as the sole authority input (§5.3).
* Any element that displays an agent's authority MUST show the tier, not a role name, role colour, or badge. A role-coloured name that could be read as authority is forbidden unless the tier is rendered alongside it.
* Every right-panel row MUST carry the same accessibility contract Discord uses: accessible name, `aria-posinset`/`aria-setsize` within its group, `selected` state, and keyboard handlers for click / context-menu / focus.
* The member-list store MUST keep Discord's two-tier update strategy (a per-user incremental path plus a bounded full-rebuild path) **and** a monotonic version counter for render invalidation, so a busy workspace does not force a deep re-diff of the roster.
* Grouping and ordering MUST be deterministic and documented: one stated rule for groups and one stated rule for order inside a group, both testable without a screenshot.
* Authority-relationship refusals (outranked / tied / owner) MUST be rendered as an explicit reason on the control, exactly as Discord does (`"Cannot action this member"`), instead of silently hiding the action.
* CrowdOS MUST NOT implement pins, threads, or activity panels as right-column tabs without a stated contract; if it implements them, each MUST be an independent surface with its own permission gate and its own dismissal path, like Discord's header popovers.
* Narrow-viewport behaviour MUST be an explicit, tested contract (Discord uses swipe gestures with dedicated telemetry); an accidental breakpoint that hides the roster with no telemetry is not acceptable.

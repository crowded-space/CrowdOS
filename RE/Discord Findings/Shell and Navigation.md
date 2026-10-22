# Shell and Navigation

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of the Discord **desktop client application shell** (renderer side): the chrome that frames a conversation — title bar, guild rail, channel sidebar, channel header, chat column, user area — plus the URL/deep-link scheme that encodes navigation state. Window-process internals (BrowserWindow, tray, IPC) are covered separately in `Desktop Shell Delta.md` and are out of scope here. Visual style is out of scope; this document is about structure, state encoding, interaction and performance approach.

Target build analysed: Discord 1.0.9264, Electron 42.11.15, Chromium 148.0.7778.280 (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`).

## How it works

The renderer is a single React tree that renders **four independent landmark columns** plus a chrome bar. The accessibility tree of the captured session (`inspect-main.json` → `accessibility.nodes`) shows the whole shell:

| Column / bar | Landmark | Root node | Contents |
| --- | --- | --- | --- |
| Chrome bar (top) | none (generic) | `accessibility.nodes[52]` region | Server name `StaticText`, `Go back` / `Go forward` buttons, `Inbox` button, `Help` link, `Minimize` / `Maximize` / `Close` buttons |
| Guild rail (left) | `navigation` | `accessibility.nodes[46]` `"Servers sidebar"` | `tree` of `treeitem`s: `Direct Messages`, guilds, guild folders |
| Channel sidebar | `navigation` | `accessibility.nodes[48]` `"NSU (ngasu) (server)"` | `heading` level 2 `"Channels"`, `list` `"Channels"`, boost-goal button, `Events` / `Server Boosts` entries, category `button`s, channel `link`/`button`s |
| Channel header | `region` | `accessibility.nodes[107]` `"Channel header"` | `heading` level 1 `"NSU (ngasu): vibin-room"`, action `button`s, `combobox` search |
| Chat column | `main` | `accessibility.nodes[108]` `"vibin-room (channel)"` | `heading` level 2 `"vibin-room chat"`, message `listitem`/`article` list, composer `textbox` |
| User area (bottom) | `region` | `accessibility.nodes[50]` `"User status and settings"` | status/menu button, Mute/Deafen switches, device pickers, settings button |
| Live regions | `log` | `accessibility.nodes[12]` (`live=assertive`), `accessibility.nodes[13]` (`live=polite`) | Toast/announcement channels, both `atomic=false` |

Two structural properties are load-bearing:

1. **The window is frameless and the title bar is an in-app React region.** The OS frame is replaced by DOM buttons. Proof is two-sided: the live accessibility tree exposes `button "Minimize"`, `button "Maximize"`, `button "Close"` *inside the page* (`accessibility.nodes[62]`, `[63]`, `[64]`), and the bundle contains the component that renders them and calls the host bridge directly — `web.31d1cd3e6e440749.js` → `"A.Ay.close(t)"` and `"A.Ay.maximize(e)"` inside module `71855`, whose sizing helper is `"return t?16:24"` (popout windows use a small variant) and whose class modifier is `"refresh-title-bar-small"`. The root renderer threads a `withTitleBar` prop and renders the bar only when set: `web.31d1cd3e6e440749.js` → `let f=eO({withTitleBar:a,isFullScreen:r})`.
2. **State is encoded in the accessible name, not only in styling.** Every piece of channel/guild state that a user must perceive without seeing colour is serialised into the `aria-label` of the control. This is the single most transferable implementation idea in the shell.

### Verified behaviour
- `[Observed]` The window is frameless: `Minimize`, `Maximize` and `Close` are DOM buttons inside the page, and the renderer draws its own bar from the `withTitleBar` prop (`accessibility.nodes[62..64]`; `web.31d1cd3e6e440749.js` → `"A.Ay.close(t)"`, `"A.Ay.maximize(e)"`).
- `[Observed]` Chrome bar order is: server name, `Go back`, `Go forward` (disabled), `Inbox`, `Help`, then the three window controls (`accessibility.nodes[80]`, `[57]`, `[58]`, `[82]`, `[60]`, `[62..64]`).
- `[Observed]` The guild rail is an ARIA `tree` inside `navigation "Servers sidebar"`, with a `group "Servers"` holding one `treeitem` per guild and a separate `treeitem "Direct Messages"` above it (`accessibility.nodes[46]`, `[66]`, `[114]`, `[896]`).
- `[Observed]` Guild state is encoded in the accessible name, not in colour: `"Unread messages, <Server>"`, `"N mention(s), <Server>"`, `"… , Voice call active"`, `"… , Screenshare active Voice call active"` (`accessibility.nodes[1352]`, `[1357]`, `[1372]`, `[2947]`).
- `[Observed]` The count badge and the server-name tooltip are separate `StaticText` nodes from the `treeitem` label (`accessibility.nodes[1374]` = `"255"`, `[923]` = `"DNDJKT"`).
- `[Observed]` Guild folders are a real tree level (`treeitem "… , folder"` with `expanded=false`) and the current guild inside a folder sits at `level=2` (`accessibility.nodes[909]`, `[2947]`).
- `[Observed]` The channel sidebar is `navigation "<guild> (server)"` → `heading` level 2 `"Channels"` → `list "Channels"`, whose items mix channel rows, category rows and the boost/events rows in one flat list (`accessibility.nodes[48]`, `[71]`, `[94]`, `[123]`, `[124]`, `[125]`).
- `[Observed]` Categories are `button "<Name> (category)"` carrying `aria-expanded`, paired with a `heading` level 3 and a sibling `button "Create Channel"` (`accessibility.nodes[577]` + `[812]` + `[813]`).
- `[Observed]` Channel state is likewise in the accessible name: `"unread, <name> (text channel)"`, `"<name> (voice channel), unread"`, `"<name> (voice channel), Private Channel (locked)"` (`accessibility.nodes[583]`, `[605]`, `[609]`).
- `[Observed]` A voice channel with a live call publishes participants, elapsed duration and the running activity in one label (`accessibility.nodes[613]`).
- `[Observed]` The search combobox lives in the channel header, not the channel list (`accessibility.nodes[460]`, ancestor `accessibility.nodes[107]`).
- `[Observed]` The user area is one `region "User status and settings"` holding the status menu, `switch "Mute"`, `switch "Deafen"`, the two device pickers and `button "User Settings"` (`accessibility.nodes[50]`, `[308]`, `[100]`, `[104]`, `[102]`, `[105]`, `[106]`).
- `[Observed]` The mute control's sibling label states the **action** (`"Unmute"` while `checked=true`), not the state (`accessibility.nodes[100]`, `[318]`).
- `[Observed]` Toast and announcement output use two `log` live regions, `live=assertive` and `live=polite`, both `atomic=false` (`accessibility.nodes[12]`, `[13]`).
- `[Inferred]` The rail and the channel list are driven by roving focus inside the ARIA `tree`/`list`; the actual arrow-key handling was not exercised (see Gaps).
- `[Inferred]` The chat column is the only column that scrolls independently; the rail, sidebar and user area are fixed — inferred from the landmark layout, not from a scroll observation.

## Structural inventory

### Chrome bar
| Element | Role / accessible name | State carried | Evidence |
| --- | --- | --- | --- |
| Server / workspace name | `StaticText` `"NSU (ngasu)"` | current guild name | `inspect-main.json` → `accessibility.nodes[80]` |
| Back | `button "Go back"` | `focusable=true` | `accessibility.nodes[57]` |
| Forward | `button "Go forward"` | **`disabled=true`** (no forward history) | `accessibility.nodes[58]` |
| Inbox | `button "Inbox"` | `expanded=false` (popover) | `accessibility.nodes[82]` |
| Help | `link "Help"` | external link | `accessibility.nodes[60]` |
| Window controls | `button "Minimize"` / `"Maximize"` / `"Close"` | in-app frame | `accessibility.nodes[62..64]` |

Notification-centre placement is an **experiment with three entrypoints and three variants**: `web.31d1cd3e6e440749.js` → `"server-rail-top"`, `"server-rail-bottom"`, `"title-bar-left"`, `"popout"`, `"sidebar"`, `"legacy"`, experiment name `"2026-04-desktop-notification-center"`. In the captured session the Inbox button sits in the title-bar-left position.

### Guild rail
| Property | Value | Evidence |
| --- | --- | --- |
| Landmark | `navigation` `"Servers sidebar"` | `accessibility.nodes[46]` |
| Tree | `tree` `focusable=true, orientation=vertical, multiselectable=false` | `accessibility.nodes[66]` |
| Group | `group "Servers"` | `accessibility.nodes[114]` |
| Entry | `treeitem` `focusable=true, level=1, selected=false` | `accessibility.nodes[896]`, `[1352]`, `[1357]`, `[1372]`, `[1380]`, `[1387]`, `[1395]`, `[1400]` |
| DM home | `treeitem "Direct Messages"` `selected=true` | `accessibility.nodes[896]` |
| Folder | `treeitem "Alignerr Warrior, Alignerr Mango, Alignerr Apollo, Alignerr, ..., folder"` `expanded=false` | `accessibility.nodes[909]` |
| Guild context menu | `"Edit Your Server List"`, `"Add a Server"`, `"Customize"`, `"Grid View"`, `"List View"` | `8b9a4b4a55eaa34c.js` → `"Edit Your Server List"`, `"LD9vsr":["Add a Server"]`, `"kAUBbc":["Customize"]`, `"JKlIvH":["Grid View"]`, `"KuzWUU":["List View"]` |

**Guild accessible-name grammar** (the label is a comma-separated state list):

| Label shape | Meaning | Example node |
| --- | --- | --- |
| `"Unread messages, <Server>"` | unread, no mentions | `accessibility.nodes[1352]` `"Unread messages, BioCleanup DEV"` |
| `"1 mention, <Server>"` | exactly one mention | `accessibility.nodes[1357]` `"1 mention, The Resurgence Command"` |
| `"255 mentions, <Server>, Voice call active"` | mention count + live call | `accessibility.nodes[1372]` `"255 mentions, DNDJKT, Voice call active"` |
| `"Unread messages, <Server>, Screenshare active Voice call active"` | screenshare + call, current guild | `accessibility.nodes[2947]` `selected=true` |

Supporting parts of a guild entry: a badge `StaticText` carrying the raw count (`"255"` at `accessibility.nodes[1374]`, `"1"` at `[1381]`, `"3"` at `[1183]`), a tooltip `StaticText` carrying the plain server name (`"DNDJKT"` at `accessibility.nodes[923]`), and a `"NEW"` `StaticText` (`accessibility.nodes[111]`) for the newly-created-server affordance. Server ordering is user-controlled and persisted: `8b9a4b4a55eaa34c.js` → `"sWekP9":["Server Order"]`, `"fL0oaC":["Edit Your Server List"]`. Guilds can be grouped into folders (`"GuildFolder"`, 24 occurrences in `web.31d1cd3e6e440749.js`), and the rail has a grid/list density switch (`"Grid View"` / `"List View"`).

### Channel sidebar
| Element | Role / name | Evidence |
| --- | --- | --- |
| Landmark | `navigation "NSU (ngasu) (server)"` | `accessibility.nodes[48]` |
| Heading | `heading` level 2 `"Channels"` | `accessibility.nodes[71]` |
| Boost progress | `button "Boost Goal 0/33 Boosts"` | `accessibility.nodes[123]` |
| Server events | `button "Events"` | `accessibility.nodes[573]` |
| Server boosts | `button "Server Boosts"` | `accessibility.nodes[575]` |
| Channel list | `list "Channels"` | `accessibility.nodes[94]` |
| Category | `button "<Name> (category)"` + `heading` level 3 | `accessibility.nodes[577]` + `[812]` |
| Category actions | `button "Create Channel"` | `accessibility.nodes[813]` |
| Text channel | `link "<name> (text channel)"` | `accessibility.nodes[580]` |
| Text channel actions | `button "Invite to Channel"`, `button "Edit Channel"` | `accessibility.nodes[1975]`, `[1976]` |
| Voice channel | `button "<name> (voice channel)"` | `accessibility.nodes[605]` |
| Private voice | `button "<name> (voice channel), Private Channel (locked)"` | `accessibility.nodes[609]` |

**Category ordering** is server-authoritative and exposed as heading level 3 under the level-2 "Channels" heading. Categories observed in the captured server: `Main Hall` `[812]`, `Learning Center` `[822]`, `Voice Channel` `[828]`, `Game Related` `[847]`, `Mancing` `[850]`, `Albino` `[853]`, `Media` `[856]`, `Bot Stuff` `[867]`, `NSFW` `[875]`.

**Collapse state** is on the category button itself: `accessibility.nodes[602]` `button "Voice Channel (category)" {expanded=true}`, `accessibility.nodes[577]` `button "Main Hall (category)" {expanded=true}`. Collapse is a *view* state, not a permission state.

**Per-channel affordances** are all in the accessible name, not in extra nodes:

| State | Encoded as | Example |
| --- | --- | --- |
| Unread text channel | `unread, ` prefix | `accessibility.nodes[583]` `"unread, random-mim-stuff (text channel)"` |
| Unread voice channel | `, unread` suffix | `accessibility.nodes[605]` `"Round Table (voice channel), unread"` |
| Private/locked | `, Private Channel (locked)` | `accessibility.nodes[609]` `"pacaran (voice channel), Private Channel (locked)"` |
| Voice-text-chat | sibling `StaticText "Open Chat"` | `accessibility.nodes[1989]` |
| Live participants + call duration + activities | comma list | `accessibility.nodes[613]` `"co-habitating space (voice channel), unread, reja vi es es, Carnivore, Foxeyyy, and 3 others, call duration 3 hours, 53 minutes, 16 seconds, Active activities in this channel: League of Legends"` |

The voice-channel row therefore publishes **presence, participant roster, elapsed call time and the running activity** in a single string — a fully text-accessible voice indicator.

### Channel header
| Element | Role / name | State | Evidence |
| --- | --- | --- | --- |
| Channel type | `StaticText "Text Channel"` | — | `accessibility.nodes[454]` |
| Title | `heading` level 1 `"NSU (ngasu): vibin-room"` | guild:channel | `accessibility.nodes[456]` |
| Threads | `button "Threads"` | `expanded=false` | `accessibility.nodes[330]` |
| Notifications | `button "Notification Settings"` | `expanded=false` | `accessibility.nodes[331]` |
| Pins | `button "Pinned Messages"` | `expanded=false` | `accessibility.nodes[332]` |
| Right pane | `button "Show Member List"` | toggle | `accessibility.nodes[333]` |
| Search | `combobox "Search NSU (ngasu)"` | `expanded=false, hasPopup=listbox, editable=richtext` | `accessibility.nodes[460]` |

The search combobox is a **descendant of the Channel header region**, not of the channel list: ancestry walk `accessibility.nodes[460] → [459] → [335] → [334] → [329] → [327] → [107] region "Channel header"`.

### User area
| Element | Role / name | State | Evidence |
| --- | --- | --- | --- |
| Status menu | `button "Manage profile and status"` | `expanded=false` | `accessibility.nodes[308]` |
| Mic mute | `switch "Mute"` | `checked=true` | `accessibility.nodes[100]` |
| Mute label | `StaticText "Unmute"` | reflects the *action*, not the state | `accessibility.nodes[318]` |
| Input device | `button "Input Options"` | — | `accessibility.nodes[102]` |
| Deafen | `switch "Deafen"` | `checked=false` | `accessibility.nodes[104]` |
| Output device | `button "Output Options"` | — | `accessibility.nodes[105]` |
| Settings | `button "User Settings"` | — | `accessibility.nodes[106]` |

## Implementation details

### URL / deep-link scheme
Routes are declared as regexes in `web.31d1cd3e6e440749.js`:

| Route | Regex literal | Purpose |
| --- | --- | --- |
| Guild or DM home | `` `^/channels/(\\d+\|${o.ME})(?:/)?(\\d+\|${u})?` `` | `/channels/@me`, `/channels/<guild>` |
| Guild + channel | `` `^/channels/(\\d+\|${o.ME})(?:/)(\\d+\|${u})(?:/)(\\d+)` `` | third segment = message id |
| Thread + message | `"^/channels/(\\d+)(?:/)(\\d+)(?:/threads/)(\\d+)(?:/)(\\d+)"` | `/channels/<g>/<c>/threads/<t>/<m>` |
| Roll dice | `` `^/channels/(\\d+)(?:/)(\\d+)/roll-dice(?:/(\\d+)d(\\d+))?$` `` | dice sub-route |
| Guild stages | `` `^/guild-stages/(\\d+)(?:/)?(\\d+)?` `` | — |
| User | `"/^\\/users\\/(\\d+)\\/?$/"` | — |
| Events | `` `^/events/(\\d+)(?:/)?(\\d+)?((?:/)(\\d+))?` `` | — |

Path builders in the same chunk: `GUILD_SETTINGS:(e,t,n)=>{let i=`/guilds/${e}/settings${null!=t?`/${t}`:""}`;return null==n?i:`${i}/${n}`}`, `SETTINGS:(e,t)=>`/settings/${e}${null!=t?`/${t}`:""}``, `CHANGELOGS:e=>`/settings/changelogs${null!=e?`/${e}`:""}``.

**Which paths count as "in-app"** is an explicit allowlist: `web.31d1cd3e6e440749.js` → `isAppRoute:e=>{let t=e.toLowerCase();return t.startsWith("/channels/")||t.startsWith(c.BVt.APPLICATION_STORE)||…||t.startsWith("/feature/boost")||t.startsWith(c.BVt.ACTIVITY)}`. Anything not on that list is opened as an external link rather than routed.

**Settings URL parsing** is its own mini-protocol: `web.31d1cd3e6e440749.js` → `function d(e){let t=e.split("/");return l.BVt.SETTINGS(t[0],t[1])}`, with the slug normaliser `function c(e){return null==e?"":e.toLowerCase().replace(o,"-")}` (`o=/[_\s]|%20/g`) and the validity check `function u(e){return Object.values(s.od).includes(e)}`. Two analytics events bracket the operation: `"user_settings_url_parsed"` (with `user_settings_url_path`, `user_settings_url_origin`) and `"user_settings_url_parsing_failed"`.

**Performance instrumentation reads the URL too**: `web.31d1cd3e6e440749.js` → `let e=window.location?.pathname,t=e?.startsWith("/channels/@me")?"channels/@me":e?.split("/")?.[1]`.

### Channel list ordering and category behaviour
- The list is a single `list` role containing `listitem`s; categories and channels are interleaved as siblings, so a category is a *sibling row*, not a container — Discord's sidebar is a flat virtual list with category header rows (`accessibility.nodes[124..160]` are all `listitem`).
- Boost-goal and Events/Boosts rows are also `listitem`s inside the same list, above the first category (`accessibility.nodes[123]`, `[124]`, `[125]`).
- Category collapse (`aria-expanded`) does not remove the children from the accessibility tree in the observed state (both observed categories were `expanded=true`).

### Rail and sidebar as ARIA trees
Both the guild rail and the channel list are real ARIA structures, not divs: `tree` with `focusable=true, orientation=vertical, multiselectable=false` (`accessibility.nodes[66]`), `group "Servers"` (`[114]`), `treeitem` with `level` and `selected` states (`[896]`, `[2947]`). The guild tree is two-level (`level=1` for guilds, `level=2` for the currently-selected guild inside a folder at `accessibility.nodes[2947]`), and folder nodes expose `expanded=false` (`[909]`).

### Window and pane switching
- Right pane toggle lives in the channel header (`accessibility.nodes[333]` `"Show Member List"`), not in the user area; the string flips to `"Hide Member List"` when open (`8b9a4b4a55eaa34c.js` → `"gxChDx":["Show Member List"]`, `"Axvx8c":["Hide Member List"]`).
- The channel sidebar is resizable: `web.31d1cd3e6e440749.js` → `"channel_sidebar_viewed"`, `"channel_sidebar_resized"`.
- The notification centre can be mounted in the rail or the title bar depending on experiment variant (`"server-rail-top"`, `"server-rail-bottom"`, `"title-bar-left"`).
- Narrow-window behaviour for the right pane is a *swipe* interaction, not a breakpoint: `web.31d1cd3e6e440749.js` → `"member_list_swipe_peek"`, `"member_list_swipe_toggled"`.
- Sidebar width in user settings is exposed as a number: `8b9a4b4a55eaa34c.js` → `"Adjust the space between server, channel, and member lists."`.

## Interaction model
| Action | Target | Result | Evidence |
| --- | --- | --- | --- |
| Move focus in rail | `tree` `treeitem` | roving focus between guilds; `level`/`selected` follow | `accessibility.nodes[66]`, `[896]` |
| Expand guild folder | `treeitem … folder` | `expanded` flips, children become `level=2` | `accessibility.nodes[909]`, `[2947]` |
| Move focus in channel list | `list` `listitem` | roving focus between channels and category headers | `accessibility.nodes[94]` |
| Toggle category | category `button` | `aria-expanded` flips; children hidden/shown | `accessibility.nodes[602]` |
| Open channel | channel `link` / `button` | URL becomes `/channels/<guild>/<channel>`; `main` accessible name changes to `"<channel> (channel)"` | `accessibility.nodes[108]` |
| Open search | header `combobox` | `expanded=true`, listbox popup | `accessibility.nodes[460]` |
| Toggle right pane | header `button "Show Member List"` | member list mounts/dismounts | `accessibility.nodes[333]` |
| Toggle pins | header `button "Pinned Messages"` | `expanded=false` popover | `accessibility.nodes[332]` |
| Open threads | header `button "Threads"` | `expanded=false` popover | `accessibility.nodes[330]` |
| Mute mic | user-area `switch "Mute"` | `checked` flips; adjacent label switches to `"Unmute"` | `accessibility.nodes[100]`, `[318]` |
| Deafen | user-area `switch "Deafen"` | `checked` flips | `accessibility.nodes[104]` |
| Open settings | user-area `button "User Settings"` | settings surface opens | `accessibility.nodes[106]` |
| Navigate back/forward | chrome `button "Go back"` / `"Go forward"` | history traversal; forward disabled with no history | `accessibility.nodes[57]`, `[58]` |
| Window control | `button "Minimize"/"Maximize"/"Close"` | host window operation | `web.31d1cd3e6e440749.js` → `"A.Ay.close(t)"`, `"A.Ay.maximize(e)"` |

## Performance notes
| Aspect | Approach | Evidence |
| --- | --- | --- |
| TTI measurement | `requestIdleCallback` + `firstRenderAfterReadyPayload` + `APP_WEB_PERF_STARTUP_METRICS` (`metric_name:"tti"`) | `web.31d1cd3e6e440749.js` → `"tti"`, `"url_root_path:t"` |
| Web vitals (observed live) | TTFB 161.90 ms; FCP 14,788 ms; LCP 14,788 ms (then 23,608 ms); CLS 0.00 → 0.06 | console capture from the settings navigation |
| Gateway READY | 2,628 ms; `READY_SUPPLEMENTAL` 5,760 ms | same console capture |
| READY split (observed) | `guilds_connect` 52.08 ms, `presence_started` 20.598 ms, `optimize_ready` 4.969 ms, `apex_experiments` 77.141 ms | same console capture (`[READY]` timing block) |
| Gateway transport | `wss://gateway.discord.gg/?encoding=etf&v=9&compress=zstd-stream` — ETF binary encoding + zstd stream compression | same console capture (`[FAST CONNECT]` line) |
| List update strategy | stores keep a `version` counter incremented on every mutation and expose `getMemberListVersion` for memoisation, instead of deep equality | `web.31d1cd3e6e440749.js` → `this.version++`, `"getMemberListVersion(e){return p[e]?.version}"` |
| Incremental vs rebuild | batch updates above 50 ids trigger a full rebuild, smaller batches patch per user | `web.31d1cd3e6e440749.js` → `e.length>50?this.rebuild():e.forEach(e=>this.updateUserId(e))` |
| Bundle shape | main app chunk 12,547,650 B; sibling chunks 1,433,778 / 1,268,835 / 1,192,954 / 698,302 / 437,962 B; 2 WASM payloads 1,202,025 / 1,805,335 B; 1,281 script resources and 1,917 resources observed on one page load | local chunk folder; `inspect-main.json` → `scripts.items` / `resources` |

## Evidence
| ID / pointer | What it shows |
| --- | --- |
| `inspect-main.json` → `accessibility.nodes[N]` | Whole renderer accessibility tree (3,215 nodes) of a live guild channel: chrome bar, rail, sidebar, header, chat, user area, live regions |
| `inspect-main.json` → `dom.nodes[N]` | 6,287-node DOM snapshot (attribute *names* only; values are stripped by the capture, so class names come from the bundle) |
| `web.31d1cd3e6e440749.js` → `"A.Ay.close(t)"`, `"A.Ay.maximize(e)"`, `"withTitleBar"`, `"refresh-title-bar-small"` | In-app frameless title bar and host window bridge |
| `web.31d1cd3e6e440749.js` → route regexes and `GUILD_SETTINGS:(e,t,n)=>…`, `SETTINGS:(e,t)=>…`, `isAppRoute:e=>{…}` | URL / deep-link scheme and app-route allowlist |
| `web.31d1cd3e6e440749.js` → `"channel_sidebar_viewed"`, `"channel_sidebar_resized"`, `"member_list_swipe_peek"`, `"member_list_swipe_toggled"`, `"server-rail-top"`, `"title-bar-left"` | Resizable sidebar, narrow-width swipe affordances, notification-centre entrypoints |
| `web.31d1cd3e6e440749.js` → `"url_root_path:t"`, `"tti"`, `this.version++`, `e.length>50?this.rebuild():…` | TTI instrumentation and list-update strategy |
| `8b9a4b4a55eaa34c.js` → `"gxChDx":["Show Member List"]`, `"Axvx8c":["Hide Member List"]`, `"sWekP9":["Server Order"]`, `"fL0oaC":["Edit Your Server List"]`, `"LD9vsr":["Add a Server"]`, `"5hM3Sq":["Tap to add a server!"]`, `"Adjust the space between server, channel, and member lists."` | Member-list toggle strings, guild ordering, add-server affordance, sidebar sizing setting |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live target identity: discord/1.0.9264, Electron/42.11.15, Chromium 148.0.7778.280, page target `A726384904E087D2F74FC6B86E22A4BD` |
| `ev_3e8a617d71c30123acd91bdd67d5bffa67f95b46a7a234302d5d56011803e6ee` | Target listing after navigating to `/channels/@me/settings` — URL accepted, title still the DM home |
| `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2` | Full passive inspection of the settings URL page — shows the DM home (title `"Friends"`), **no settings modal mounted** |
| `discord-re\screenshot-main.png` | Corroborating screenshot of the same session (used sparingly; a11y tree is authoritative) |

## Gaps
- **Right pane never observed open.** The session was captured with the member list closed (`button "Show Member List"`), and the read-only constraint for this task forbids clicking to open it. Member-list internals are therefore bundle-sourced; see `Right Panel and Members.md`.
- **Keyboard shortcuts for pane switching were not observed.** The ARIA tree structures imply arrow-key roving focus, but no key-press was performed, so the actual key map is unverified. The user-settings surface documents keybinds as a separate settings section (`"system_custom_keybinds_category"`, `"system_default_keybinds_category"`), but the in-shell pane-switch keys were not read from the live client.
- **Guild-rail scrolling implementation not read.** The rail's overflow/scroll container is not distinguishable in the accessibility tree, and no scroll event was observed.
- **Draft preview** in the channel list was **not observed**: no channel row in the captured session carried a draft preview string, and the bundle literal for it was not located. The per-channel `aria-label` grammar observed covers unread / mention / private / voice / call-state only.
- **REA tool error (verbatim)** when navigating with the scenario runner: `"Analysis could not complete. Run `rea doctor` and review the reported details; repeating the unchanged request is not expected to succeed."` — provider `rea-playwright-browser-scenario`, detail `"Scenario navigation failed before the initial state was captured."` The navigation itself did complete (console events prove the page loaded and reached `/channels/@me/settings`), so the failure was in the capture step, not the navigation.
- **`/settings/*` and `/guilds/<id>/settings/*` are not routable in the desktop shell.** Navigating to `https://discord.com/settings/account` and `https://discord.com/guilds/345096814443233301/settings` both redirected back to `/channels/345096814443233301/345096814443233302` (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` after the second attempt). The settings surfaces open in a separate window and are only reachable by activating the UI; see `Settings Surface.md`.
- The `discord-re\screenshot-main.png` artefact was not re-captured after navigation and reflects the guild-channel session only.

## User Decision:

## Target Contract
> Status: Target. Discord is a reference source only; CrowdOS's locked design contract (§1–§34) takes precedence. Nothing here may weaken the L0–L3 router authority model.

* CrowdOS MUST keep a single URL scheme that encodes workspace, channel and optional message/thread id, and MUST treat "is this an in-app route" as an explicit allowlist rather than a prefix guess. CrowdOS must not adopt Discord's `/channels/<guild>/<channel>` path shape verbatim; it must use its own workspace-scoped form.
* CrowdOS MUST keep navigation state in the URL as the single source of truth for "which channel am I in"; a separate client-only "current channel" variable that can disagree with the URL is forbidden.
* Every state a user perceives without colour — unread, mention count, live/active, restricted, muted, error — MUST be carried in the control's accessible name, not only in a class name or a colour. This is the highest-value transferable rule from Discord's rail and sidebar.
* The guild rail and channel list MUST be real ARIA structures (`tree`/`list` with `level` and `selected` state), so screen-reader users can navigate by structure rather than by pixel order.
* CrowdOS MUST NOT add a custom in-app title bar that duplicates OS window controls unless its desktop shell is frameless on every platform; if it does, the controls MUST call the shell's window bridge and MUST be reachable by keyboard with accessible names.
* Category collapse, sidebar width and notification-centre placement MUST be persisted view preferences scoped to the workspace, and MUST never be confused with permission or authority state.
* CrowdOS MUST keep authority derived from the agent tier only (§5.3). Nothing in the shell may infer authority from a role name, a badge, or a role colour; the router remains the only authority source.
* Any new rail/sidebar surface MUST be measured with the same instrumentation pattern (a `*_viewed` / `*_resized` / `*_toggled` analytics triple) so resize and toggle behaviour is observable without screenshots.

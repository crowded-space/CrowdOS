# Keyboard and Accessibility

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reverse-engineered map of Discord desktop/web keyboard handling and accessibility surface: the global shortcut registry, focus-management model, ARIA landmark and widget inventory, live regions, reduced-motion and focus-visibility handling, and the honest gaps. Implementation reference for CrowdOS `packages/client` input handling and `packages/desktop` shortcuts.

## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] Discord has **one** global shortcut registry. Every binding is an object `{ binds: string[], comboKeysBindGlobal?: boolean, action: (event, key) => boolean }` living in a per-feature module; the registry module `938812` composes them into a map keyed by a flat shortcut-ID enum (`tW`). `mod` means Ctrl on Windows/Linux and Cmd on macOS; the same binding array can differ per platform via `(0,N.isMac)()`.

| Concept | Value | Evidence |
| --- | --- | --- |
| Binding shape | `{binds:[...], comboKeysBindGlobal:!0, action:()=>(...,!1)}` | `web.31d1cd3e6e440749.js` @ `2311400` (`mod+shift+m` → `toggleSelfMute`) |
| Registry map | `let em={[y.IWg.SERVER_NEXT]:q.yx, [y.IWg.SERVER_PREV]:q.yv, ...}` | `2316076` module `938812` |
| Shortcut-ID enum | `SERVER_NEXT, SERVER_PREV, CHANNEL_NEXT, CHANNEL_PREV, NAVIGATE_BACK, NAVIGATE_FORWARD, UNREAD_NEXT, UNREAD_PREV, MENTION_CHANNEL_NEXT, MENTION_CHANNEL_PREV, JUMP_TO_CURRENT_CALL, TOGGLE_SETTINGS, TOGGLE_HELP, TOGGLE_USERS, TOGGLE_INBOX, MARK_TOP_INBOX_CHANNEL_READ, TOGGLE_CHANNEL_PINS, TOGGLE_PREVIOUS_GUILD, TOGGLE_MUTE, TOGGLE_DEAFEN, TOGGLE_CAMERA, TOGGLE_HOTKEYS, TOGGLE_CATEGORY_COLLAPSED, SEARCH_SOUNDBOARD, UPLOAD_FILE, RECORD_VOICE_MESSAGE, SEARCH_EMOJIS, SEARCH_GIFS, SEARCH_STICKERS, MARK_CHANNEL_READ, MARK_SERVER_READ, MENTION_NEXT, MENTION_PREV, CREATE_DM_GROUP, CREATE_GUILD, CREATE_THREAD, RETURN_TO_AUDIO_CHANNEL, CALL_ACCEPT, CALL_DECLINE, CALL_START, SCROLL_UP, SCROLL_DOWN, TEXTAREA_FOCUS, CLOSE_MODAL, POP_LAYER, SUBMIT, EDIT_LAST_MESSAGE, JUMP_TO_GUILD, JUMP_TO_FIRST_UNREAD, JUMP_TO_PRESENT, FOCUS_SEARCH, QUICKSWITCHER_SHOW, QUICKSWITCHER_HIDE, OPEN_CHANNEL_TAB, CLOSE_CHANNEL_TAB, TOGGLE_CHANNEL_TAB_PIN, ZOOM_IN, ZOOM_OUT, ZOOM_RESET, CAROUSEL_NEXT, CAROUSEL_PREV, MODAL_CAROUSEL_NEXT, MODAL_CAROUSEL_PREV, OPEN_APP_DIRECTORY, BROWSER_DEVTOOLS, VIBE_WITH_WUMPUS, OPEN_CONTEXT_MENU, COPY_CHANNEL_LINK` | `238119` (enum `tW`) |
| Help modal grouping | `NAVIGATION, CHAT, VOICE_AND_VIDEO, MISCELLANEOUS, MESSAGE, DND` | `2316076` `ef=((i={}).NAVIGATION="NAVIGATION",i.CHAT="CHAT",i.VOICE_AND_VIDEO="VOICE_AND_VIDEO",i.MISCELLANEOUS="MISCELLANEOUS",i.MESSAGE="MESSAGE",i.DND="DND")` |
| Dispatch bus | `dispatchToLastSubscribed` / `hasSubscribers` / `safeDispatch` over a `jej` action enum | e.g. `dispatchToLastSubscribed(r.jej.SCROLL_PAGE_UP)` |
| "global" flag | `comboKeysBindGlobal:!0` marks the binding as eligible outside the focused view | every registry entry above |

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Global shortcut map
- [Observed] Scope: **global** = the binding is registered app-wide (`comboKeysBindGlobal: true`); **view** = bound to the focused surface only.

| Shortcut | Action | Scope | Evidence (bundle literal) |
| --- | --- | --- | --- |
| `mod+shift+m` | Toggle self-mute | global | `{binds:["mod+shift+m"],comboKeysBindGlobal:!0,action:()=>(i.default.toggleSelfMute({usedKeybind:!0,location:"Default Keybind"}),!1)}` |
| `mod+shift+d` | Toggle self-deafen | global | `{binds:["mod+shift+d"],comboKeysBindGlobal:!0,action:()=>(i.default.toggleSelfDeaf({usedKeybind:!0,location:"Default Keybind"}),!1)}` |
| `mod+shift+a` | Collapse/expand the guild folder containing the current server | global | `{binds:["mod+shift+a"],comboKeysBindGlobal:!0,action(){...a.Ay.getChannels(e)[l.rbe.GUILD_CATEGORY]...}}` |
| `mod+/`, `mod+shift+/` | Show / hide the keyboard-shortcuts modal | global | `{binds:["mod+/","mod+shift+/"],comboKeysBindGlobal:!0,action:()=>((0,i.hasModalOpen)(a.P)?r.h.dispatch({type:"HIDE_KEYBOARD_SHORTCUTS"}):r.h.dispatch({type:"SHOW_KEYBOARD_SHORTCUTS"}),!1)}` |
| `mod+plus` / `mod+minus` / `mod+0` | Zoom in / out / reset | global | `{binds:["mod+plus"],comboKeysBindGlobal:!0,action:()=>((0,i.Qp)(s(1)),!1)}` etc., `a.hH7.ZOOM_SCALES` / `ZOOM_DEFAULT` |
| `alt+shift+down` / `alt+shift+up` | Next / previous unread channel | global | `{binds:["alt+shift+down"],comboKeysBindGlobal:!0,action(){...p(1,{channelPredicate:O,...})}}` |
| `mod+shift+alt+down` / `mod+shift+alt+up` | Next / previous channel with a mention | global | `{binds:["mod+shift+alt+down"],comboKeysBindGlobal:!0,action:()=>(p(1,{channelPredicate:v,...})),!1)}` |
| `alt+right` (`mod+]` on Mac) | Next channel | global | `{binds:(0,N.isMac)()\|\|(0,N.isMacWeb)()?["mod+]"]:["alt+right"],comboKeysBindGlobal:!0,...}` |
| `alt+up` | Previous channel | global | `O={binds:["alt+up"],comboKeysBindGlobal:!0,action:()=>(p(-1),!1)}` |
| `alt+left` (`mod+[` on Mac) | Navigate back | global | `L={binds:(0,N.isMac)()\|\|(0,N.isMacWeb)()?["mod+["]:["alt+left"],comboKeysBindGlobal:!0,action:()=>((0,T.OE)("keybind"),!1)}` |
| `mod+alt+right` | Navigate forward | global | `R={binds:["mod+alt+right"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+alt+down`, `mod+shift+\``, `ctrl+tab` | Next server | global | `binds:["mod+alt+down","mod+shift+\`","ctrl+tab"]` |
| `mod+alt+up`, `mod+shift+[`, `ctrl+shift+tab` | Previous server | global | `binds:["mod+alt+up","mod+shift+[","ctrl+shift+tab"]` |
| `mod+alt+left` | Scroll the channel list | global | `{binds:["mod+alt+left"],comboKeysBindGlobal:!0,action(){...i.A.channelListScrollTo(e,a.A.getChannelId()),!1}}` |
| `mod+k` | Quick switcher | global | `{binds:["mod+k"],comboKeysBindGlobal:!0,action:()=>(r.A.hasLayers()\|\|(0,i.WU)(),!1)}` |
| `mod+e` | Toggle the emoji picker | global | `{binds:["mod+e"],comboKeysBindGlobal:!0,action:()=>!(r.A.getLayers().length>0)&&(...dispatchToLastSubscribed(s.jej.TOGGLE_EMOJI_POPOUT),!1)}` |
| `mod+g` | Toggle the GIF picker | global | `{binds:["mod+g"],comboKeysBindGlobal:!0,action:()=>...TOGGLE_GIF_PICKER...}` |
| `mod+s` | Toggle the sticker picker | global | `{binds:["mod+s"],comboKeysBindGlobal:!0,action:()=>...TOGGLE_STICKER_PICKER...}` |
| `mod+shift+b` | Soundboard | global | `{binds:["mod+shift+b"],comboKeysBindGlobal:!0,action:()=>(L._.dispatch(y.jej.TOGGLE_SOUNDBOARD),!1)}` |
| `mod+p` | Toggle channel pins | global | `{binds:["mod+p"],comboKeysBindGlobal:!0,action:()=>(L._.dispatch(y.jej.TOGGLE_CHANNEL_PINS),!1)}` |
| `mod+i` | Toggle the inbox | global | `{binds:["mod+i"],comboKeysBindGlobal:!0,action:()=>...TOGGLE_INBOX...}` |
| `mod+u` | Toggle the members list / user profile | global | `{binds:["mod+u"],comboKeysBindGlobal:!0,action(){...el.A.toggleMembersSection(),!1}}` |
| `mod+f`, `mod+shift+f` | Focus search (shift = prefill current channel) | global | `{binds:["mod+f","mod+shift+f"],comboKeysBindGlobal:!0,action(e,t){...let n=!t.includes("shift");return L._.dispatch(y.jej.FOCUS_SEARCH,{prefillCurrentChannel:n}),!1}}` |
| `mod+shift+n` | Create / join a server | global | `{binds:["mod+shift+n"],comboKeysBindGlobal:!0,action(){...openCreateGuildModal({location:"Keyboard Shortcut"})}}` |
| `mod+shift+t` | New group DM | global | `{binds:["mod+shift+t"],comboKeysBindGlobal:!0,action:()=>...TOGGLE_DM_CREATE...}` |
| `mod+shift+alt+n` | Create thread | global | `{binds:["mod+shift+alt+n"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+shift+u` | Upload a file to the current channel | global | `{binds:["mod+shift+u"],comboKeysBindGlobal:!0,action(){...L._.dispatch(y.jej.UPLOAD_FILE,{channelId:e.id}),!1}}` |
| `alt+r` (`ctrl+shift+d` on Mac) | Record a voice message | global | `{binds:j?["ctrl+shift+d"]:["alt+r"],comboKeysBindGlobal:!0,action(e){...RECORD_VOICE_MESSAGE...}}` |
| `mod+shift+h`, `f1` | Open the help page (external `window.open`) | global | `{binds:["mod+shift+h","f1"],comboKeysBindGlobal:!0,action:()=>(window.open(et.C),!1)}` |
| `mod+alt+shift+w` | "Vibe with Wumpus" easter egg | global | `{binds:["mod+alt+shift+w"],comboKeysBindGlobal:!0,...}` |
| `mod+shift+e` | Mark the top inbox channel read (debounced 100 ms, leading) | global | `{binds:["mod+shift+e"],comboKeysBindGlobal:!0,action:m().debounce(()=>{...MARK_TOP_INBOX_CHANNEL_READ...},100,{leading:!0})}` |
| `pageup` / `pagedown` | Scroll the message list one page | global | `{binds:["pageup"],comboKeysBindGlobal:!0,action:()=>(i._.dispatchToLastSubscribed(r.jej.SCROLL_PAGE_UP),!1)}` |
| `mod+t` | Open a channel tab | global | `{binds:["mod+t"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+w` | Close the active channel tab | global | `{binds:["mod+w"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+shift+p` | Pin/unpin the active channel tab | global | `{binds:["mod+shift+p"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+shift+alt+v` | Jump to the current call | global | `{binds:["mod+shift+alt+v"],comboKeysBindGlobal:!0,action(e){e.preventDefault(),e.stopPropagation(),...}}` |
| `mod+ctrl+a` | Open the app directory | global | `{binds:["mod+ctrl+a"],comboKeysBindGlobal:!0,action(){...transitionToGlobalDiscovery({tab:F.GlobalDiscoveryTab.APPS,...})}}` |
| `mod+alt+i` | Browser devtools (no-op on `discord.com` web) | global | `{binds:["mod+alt+i"],comboKeysBindGlobal:!0,action(e){if((0,b.isWeb)()&&"discord.com"===location.host)return e.preventDefault(),e.stopPropagation(),!1}}` |
| `shift+f10` | Open the context menu of the focused element | global | `{binds:["shift+f10"],comboKeysBindGlobal:!0,action(){let e=document.activeElement;...e.dispatchEvent(new MouseEvent("contextmenu",{bubbles:!0,cancelable:!0,view:window,clientX:0,clientY:0})),!1}}` |
| `mod+shift+l` | Copy the channel link | global | `{binds:["mod+shift+l"],comboKeysBindGlobal:!0,action(){...}}` |
| `mod+return` | Accept an incoming call | global | `{binds:["mod+return"],comboKeysBindGlobal:!0,action(){if(i._.hasSubscribers(r.jej.CALL_ACCEPT))return i._.dispatch(r.jej.CALL_ACCEPT),!1}}` |
| `ctrl+'`, `ctrl+shift+'` | Start a call | global | `{binds:["ctrl+'","ctrl+shift+'"],comboKeysBindGlobal:!0,action(e){...CALL_START...}}` |
| `esc` | Close the topmost layer (call decline → layer → modal) | global | `action(e){if((0,r.ny)())return!1;if(l._.hasSubscribers(d.jej.CALL_DECLINE))return l._.dispatch(d.jej.CALL_DECLINE),!1;if(s.A.close())return!1;...MODAL_CLOSE...}` |
| `esc`, `shift+pagedown` | Close modal / layer (legacy binding family) | global | `{binds:["esc","shift+pagedown"],comboKeysBindGlobal:!0,action(t){if(O.A.isElementFullScreen())return!1;if(R._.hasSubscribers(L.jej.CALL_DECLINE))...}}` |
| `shift+esc` | Toggle the server-folder favourite path | global | `{binds:["shift+esc"],comboKeysBindGlobal:!0,action(){...getFavoriteChannels()...}}` |
| `shift+pageup` | Jump to present (newest message) | global | `{binds:["shift+pageup"],comboKeysBindGlobal:!0,action(){...i.A.jumpToMessage({channelId:e,messageId:t,offset:1,context:"Keyboard Shortcut"})}}` |

### View-scoped (message-focused) shortcuts
- [Observed] Declared in the in-app shortcut list (`group:"MESSAGE"`), each a single key that acts on the currently focused message: `e`, `backspace`, `p`, `plus`, `r`, `f`, `s`, `mod+c`, `alt+enter`, `escape` (`web...js` @ `2316076` region, i18n keys `fsBWmS`, `xwMqD7`, `CvQ18w`, `lfIHs4`, `5IEsGx`, `zSyDdA`, `yGLjXF`, `JrGD7E`, `RpE9k7`, `rrYBEu`). The `DND` group lists `up`/`down`, `spacebar`/`enter`, `esc` for the voice-channel call menu (`{keybinds:["Spacebar","Enter"],name:...}` @ `827887`).

### Composer-local keys
| Key | Behaviour | Evidence |
| --- | --- | --- |
| `Enter` | submit (see Composer.md for the full rule) | `3357872` |
| `ArrowUp` / `ArrowDown` | move the autocomplete selection | `3356620` `case G.Ks6.ARROW_UP: if(E(-1)) return void e.preventDefault()` |
| `Ctrl+P` / `Ctrl+N` | move the autocomplete selection up/down | `3356620` `case G.Ks6.P: if((0,ea.j)(e,{ctrl:!0})&&E(-1))...` |
| `Escape` | close the autocomplete | `3356620` `case G.Ks6.ESCAPE: _?.()` |
| `Tab` | next command option (Shift+Tab = previous) | `3356620` `case G.Ks6.TAB: ... e.shiftKey?K.b.selectPreviousCommandOption(t):K.b.selectNextCommandOption(t)` |
| `Enter` (in autocomplete) | select the highlighted option | `3356620` `case G.Ks6.ENTER: if((0,ea.j)(e,{})&&o?.(e)){...}` |
| `Space` | confirm a highlighted suggestion in a non-editor context | `3356620` `case G.Ks6.SPACE: ...` |
| `Return` (modal) | submit the focused modal (only when keyboard mode is off) | `251494` `{binds:["return"],action(){if(!i.Ay.keyboardModeEnabled&&r._.hasSubscribers(a.jej.MODAL_SUBMIT))return r._.dispatch(a.jej.MODAL_SUBMIT),!1}}` |
| Any printable character | moves focus into the composer from the body | `8350231` `if("Tab"===t&&d._.hasSubscribers(u.jej.TEXTAREA_FOCUS)&&null!=document.querySelector('[data-can-focus="true"]'))return e.repeat||(e.preventDefault(),...` |

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Focus management
- [Observed] Discord uses a **virtual focus** model rather than DOM focus movement for lists.

| Mechanism | Behaviour | Evidence |
| --- | --- | --- |
| `useVirtualFocus` | DOM focus stays on the container; the active option is published via `aria-activedescendant` | `3304284` `useVirtualFocus:!0,setFocus:function(e,t){let i=s.document.querySelector(e);null!=i&&n.current?.scrollIntoViewNode({node:i}),a?.(+t)}` |
| `autoFocusElement` | when false, the navigator does not steal DOM focus on mount | `4712869` `autoFocusElement:!1,useVirtualFocus:!0` |
| 2-D grid navigator | `focusedX`/`focusedY` reducer state for the server tree; `dispatch`/`getItemProps`/`getRowProps`/`getContainerProps` | `10160947` `let[i]=i.useReducer(m,{focusedX:c,focusedY:u,columnCounts:n})` |
| Grid keys | `NAVIGATE_CROSSLINE_START` / `NAVIGATE_CROSSLINE_END` cross-column navigation | `4712869` `case s.X2.NAVIGATE_CROSSLINE_START:case s.X2.NAVIGATE_CROSSLINE_END:_(t)` |
| Wrap-around | `onNavigateNextAtEnd` / `onNavigatePreviousAtStart` | `3304284` `onNavigateNextAtEnd:()=>l(!0),onNavigatePreviousAtStart:()=>o(!0)` |
| Focus preservation | `preserveFocusPosition`, `maintainFocusPosition` | `10153256` `preserveFocusPosition:I=!0` |
| Focus-on-list | `setFocusOnList` option | `10153256` |
| Composer focus target | `[data-can-focus="true"]` marks the only focusable element in the composer | `dom.nodes[6092]` has `data-can-focus`; `8350231` selector |
| Tree widgets | `role="treeitem"` with `aria-level`, `aria-setsize`, `aria-posinset`, `aria-selected`, `data-list-item-id`, `tabindex` | `dom.nodes[1599]`, `[1635]`, `[1699]` |
| Roving tabindex | tree items carry an explicit `tabindex` per item, so the tree owns the tab stop | `dom.nodes[1599]` `role,data-list-item-id,tabindex,aria-level,aria-setsize,aria-posinset,aria-selected,style` |

### Accessibility tree landmarks (from `inspect-main.json` → `accessibility.nodes`)
| Role | Count | Names observed | Node |
| --- | --- | --- | --- |
| `RootWebArea` | 1 | `#vibin-room \| NSU (ngasu)` | `accessibility.nodes[0]` |
| `navigation` | 2 | `Servers sidebar`, `NSU (ngasu) (server)` | `[46]`, `[48]` |
| `main` | 1 | `vibin-room (channel)` | `[108]` |
| `region` | 2 | `User status and settings`, `Channel header` | `[50]`, `[107]` |
| `tree` | 1 | (unnamed) — the server tree | `[66]` |
| `list` | 2 | `Channels`, `Messages in vibin-room` | `[94]`, `[887]` |
| `listitem` | 72 | channel rows + message rows | `[124]`–`[159]`, `[1293]`–`[1328]` |
| `treeitem` | 55 | server/folder rows | e.g. `[1140]` `Add a Server` |
| `separator` | 3 | `Resize Sidebar`, `October 21, 2026` | `[49]`, `[1292]` |
| `combobox` | 1 | `Search NSU (ngasu)` | `[460]` |
| `textbox` | 1 | `Message #vibin-room` | `[1333]` |
| `switch` | 2 | `Mute`, `Deafen` | `[100]`, `[104]` |
| `log` | 2 | (unnamed) | `[12]`, `[13]` |
| `sectionheader` | 1 | — | `[88]` |
| `timer` | 1 | — | `[2002]` |
| `button` | 136 | incl. `Add Emoji`, `Open GIF picker`, `Open sticker picker`, `Apps`, `Send a gift`, `Manage profile and status`, `Create Channel`, `More message options` | `[1338]`, `[1340]`, `[1342]`, `[1813]`, `[1814]`, `[308]`, `[813]`, `[1331]` |
| `article` | 36 | one per rendered message | — |
| `heading` | 39 | — | — |
| `link` | 18 | — | — |
| `group` | 22 | — | — |
| `image` | 45 | — | — |
| `StaticText` | 387 | — | — |
| `InlineTextBox` | 399 | Chromium inline-text internals | — |
| `generic` | 861 | unlabelled containers | — |
| `none` (ignored) | 1086 | subtrees with no exposed semantics | — |

- [Observed] **Landmarks Discord does NOT use**: no `banner`, `contentinfo`, `search`, or `complementary` roles appear in the capture (bundle-side `role:"search"`/`role:"banner"`/`role:"contentinfo"`/`role:"complementary"` = 0 occurrences). Discord models the server list as `navigation`, the member/user panel as `region`, and the channel view as `main`.

### ARIA widget inventory (bundle-side roles)
| Role | Bundle occurrences | Where |
| --- | --- | --- |
| `listbox` | 5 | autocomplete / expression suggestion popup (`aria-haspopup="listbox"` on the editor, `dom.nodes[6092]`) |
| `tree` | 1 | server/folder tree (`accessibility.nodes[66]`) |
| `tab` | 2 | tabbed panels (channel tabs / settings) |
| `grid` | 1 | grid navigator backing the 2-D focus model |
| `menu` | 2 | context menus (`aria-haspopup="menu"` on menu items, `1209621`) |
| `dialog` | 8 | modals (`accessibility.nodes[1338]`/`[1342]`/`[1814]` show `hasPopup=dialog`) |
| `alert` | 5 | inline error text (`role:"alert"` @ `1227111`) |
| `status` | 27 | polite status text (`role:"status","aria-live":"polite"` @ `1251244`, `1661552`) |
| `log` | 0 (bundle) / 2 (a11y) | Chromium assigns `log` to the two unnamed live regions |

### Live regions
| Region | Mechanism | Announced content | Evidence |
| --- | --- | --- | --- |
| Composer status | `span[aria-live][aria-atomic]` inside the composer `<form>` | composer-mode announcements | `dom.nodes[6256]` |
| Search result count | `role="status" aria-live="polite"` | `{count} results` | `1251244` `"aria-live":"polite",role:"status",children:R?tb.intl.formatToPlainString(tb.t.xIWGxu,{count:I.length}):""` |
| Form validation | `role:"alert"` (assertive) | error text | `1227111` `role:"alert"` |
| Form success | `role:"status" aria-live="polite"` | success text | `1227111` `role:"status","aria-live":"polite"` |
| Device pickers | `role:"status" aria-live="polite"` | selected device name | `1661552` |
| Message list | 2 unnamed `log` regions | message-stream updates (Chromium-assigned) | `accessibility.nodes[12]`, `[13]` |

### Reduced motion and focus visibility
| Concern | Handling | Evidence |
| --- | --- | --- |
| Reduced motion | `window.matchMedia("(prefers-reduced-motion: reduce)")` is read once at module scope and exposed through a `useReducedMotion()` hook | `2616877` `let A=window.matchMedia("(prefers-reduced-motion: reduce)")` |
| Usage breadth | 92 `useReducedMotion` call sites; animations degrade per component rather than globally | `useReducedMotion` x92 in `web...js` |
| Also honoured | `(prefers-contrast: more)`, `(prefers-contrast: less)`, `(prefers-color-scheme: dark|light)`, `(forced-colors: active)`, `(resolution: 2dppx)` | `2616877` |
| Animation library | framer-motion (`l.config.stiff`, `tension:2400,friction:52`), with an explicit `"animate-always"` variant | `827887` `(0,o.p)(f,{enter:{...}},...)` / `900002` `let h={tension:2400,friction:52}` |
| Focus visibility | `:focus-visible` styling is used in 7 places | `focus-visible` x7 in `web...js` |
| Keyboard mode | a `keyboardModeEnabled` user setting gates Enter-to-submit in modals and single-key focus navigation | `251494` `if(!i.Ay.keyboardModeEnabled&&r._.hasSubscribers(a.jej.MODAL_SUBMIT))` |
## Interaction model
1. [Observed] Every global shortcut is matched against the key event; the action returns `false` to indicate it did not consume the event, letting the chain continue (layer → modal → view).
2. [Observed] Composers and lists use virtual focus: the container keeps DOM focus, the active descendant is announced through `aria-activedescendant`.
3. [Observed] `Tab` inside a list moves the *logical* selection, not the DOM focus; `Shift+Tab` reverses.
4. [Observed] Pressing a printable key while the body is focused moves focus into the composer (`[data-can-focus="true"]`).
5. [Observed] Escape unwinds one layer at a time: full-screen → call → layer → modal → popout.
## Performance notes
- [Observed] The shortcut registry is a plain object of closures evaluated once at module load; matching cost is a linear scan over a small bind set (`2316076`).
- [Observed] The unread/mention channel walk is **throttled** (300 ms) so repeated keypresses do not thrash the channel list (`467691` `a().throttle(function(e,t){...})`).
- [Observed] `MARK_TOP_INBOX_CHANNEL_READ` is debounced at 100 ms with `leading: true`.
- [Observed] The tree's 2-D focus state lives in a reducer; `useVirtualFocus` avoids per-row DOM focus churn.
## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| ID | What it shows |
| --- | --- |
| `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | REA `inspect_web_page` capture (accessibility tree + DOM) of the logged-in client |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live page target; Electron/42.11.15, Chromium 148 |
| `chunks/web.31d1cd3e6e440749.js` | Shortcut registry, focus navigator, ARIA roles, reduced-motion plumbing |
| `chunks/8b9a4b4a55eaa34c.js` | i18n labels for shortcut descriptions (`MESSAGE`/`DND` groups) |
## Gaps
- The send control is **absent from the accessibility tree** in the capture (no button named "Send"); it exists in the DOM at `dom.nodes[6102]` with `role`/`aria-label`/`aria-disabled`/`tabindex`. Whether the button is genuinely unexposed or the snapshot dropped it is unverified.
- No modal was open during the capture, so **focus-trap behaviour in dialogs was not observed live**. The bundle contains `role:"dialog"` (8 occurrences) and a `Layer`/`Modal` component, but the trap implementation was not traced.
- `role:"search"`, `role:"banner"`, `role:"contentinfo"`, `role:"complementary"` are absent from both the capture and the bundle: Discord simply does not use those landmark roles.
- 1086 of 3215 accessibility nodes are `ignored` (`role:"none"`), so the effective ARIA surface is ~2,129 nodes; the ignored subtrees were not enumerated.
- The 399 `InlineTextBox` nodes are Chromium internals, not authored roles; they are not a usable contract.
- Voice-channel push-to-talk keybinds (`tY` enum: `PUSH_TO_TALK`, `PUSH_TO_TALK_PRIORITY`, `PUSH_TO_MUTE`, `SOUNDBOARD_HOLD`, `SWITCH_TO_VOICE_CHANNEL`, `DISCONNECT_FROM_VOICE_CHANNEL`, `VAD_PRIORITY`, `TOGGLE_OVERLAY`, `TOGGLE_STREAMER_MODE`, `TOGGLE_PRIORITY_SPEAKER`, `TOGGLE_GO_LIVE_STREAMING`, `TOGGLE_VOICE_MODE`, `OVERLAY_ACTIVATE_REGION_TEXT_WIDGET`) are user-configurable and have no default binding in the registry — the default map was not resolved.
- The `TEXTAREA_FOCUS` dispatch (`wasEnterPressed` flag) exists to distinguish Enter from Shift+Enter at the app level, but its consumer outside the composer was not traced.
## User Decision:
## Target Contract
> Status: Target. Keyboard and accessibility behaviour is a reference; CrowdOS's own design contract stays locked.

- CrowdOS MUST keep a single, discoverable shortcut registry where every binding is declared in one place with an explicit scope (global / view) and an explicit action. Per-component ad-hoc key handlers are forbidden.
- Every interactive list MUST expose a listbox/tree semantics with `aria-activedescendant` or roving `tabindex`; keyboard-only operation (arrows, Home/End, Enter, Escape) is mandatory.
- Focus MUST NOT be lost on close: a dismissed modal MUST restore focus to its trigger.
- CrowdOS MUST ship a reduced-motion path (`prefers-reduced-motion`) and MUST NOT rely on animation to convey state.
- Every async state change that the user must notice (streaming, connection loss, permission denial) MUST live in a polite live region; errors MUST be assertive.
- Landmarks MUST be present and unique (`banner`/`navigation`/`main`/`complementary`) so screen-reader users can skip regions. Discord's omission of `banner`/`contentinfo` is not a pattern to copy.
- Shortcuts MUST be rebindable or at least documented in one discoverable place; a hidden shortcut that mutates state is forbidden.
- CrowdOS MUST NOT ship a control that is absent from its own accessibility tree (the Discord send-button gap).

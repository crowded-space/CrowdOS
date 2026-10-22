# Composer

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reverse-engineered description of the Discord desktop/web message composer: the input widget, its accessory bar, send/validation semantics, autocomplete engines, expression pickers, attachment handling, typing indicator, and draft persistence. Implementation reference for CrowdOS `packages/client` chat input; visual style is out of scope.

## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

- [Observed] The composer is **not** a `<textarea>`. It is a Slate rich-text editor mounted on a `contenteditable` `<div>`, wrapped in a `<form>`, with a sibling accessory bar of icon buttons and a live region.

| Layer | Implementation | Evidence |
| --- | --- | --- |
| Container | `<form>` element as the composer root | `inspect-main.json` → `dom.nodes[6073]` (`FORM`, parent `MAIN` `dom.nodes[4828]`) |
| Input | `div[contenteditable]` with `data-slate-editor` + `data-slate-node` | `dom.nodes[6092]` — attributes `role,aria-multiline,spellcheck,aria-haspopup,aria-invalid,aria-autocomplete,class,autocomplete,autocorrect,data-can-focus,aria-label,data-slate-editor,data-slate-node,contenteditable,zindex,style` |
| Placeholder | sibling `span[data-slate-placeholder]` (not a native `placeholder` attribute) | `dom.nodes[6090]` (`class,aria-hidden,data-slate-placeholder`) |
| Empty-cell marker | `span[data-slate-zero-width][data-slate-length]` + `<br>` | `dom.nodes[6096]`, `dom.nodes[6098]` |
| Legacy path | non-Slate editor component selected by user setting `useRichChatTextBox` → `useRichChatInput` | `web.31d1cd3e6e440749.js` @ `8441612` `I("textAndImages","useRichChatTextBox",...)`; editor switch `b=E?(0,i.jsx)(eT,{...}):(0,i.jsx)(F,{...})` @ `3367402` region |
| Accessible name | `aria-label` = `Message #<channelName>` | `accessibility.nodes[1333]` role `textbox`, name `Message #vibin-room`; bundle template `"fxxYiB":["Message #general"]` in `8b9a4b4a55eaa34c.js` @ `1156370` |

- [Observed] Accessibility state of the live textbox (`accessibility.nodes[1333].states`): `autocomplete=list`, `editable=richtext`, `focusable=true`, `focused=true`, `hasPopup=listbox`, `invalid=false`, `multiline=true`, `readonly=false`, `required=false`.

### Composer type registry
- [Observed] Every composer surface is a `chatInputType` record. [Inferred] The registry is the single source of truth for capabilities, draft type, permissions and submit behaviour. `web.31d1cd3e6e440749.js` @ `3329478`–`3337916`:

| Type | Draft type | Notable flags |
| --- | --- | --- |
| `NORMAL` | `ChannelMessage` (+ `SlashCommand`, `autoSave`) | `attachments`, `commands.enabled`, `emojis.button`, `gifs.button`, `gifts.button`, `stickers.button`, `soundmoji`, `voiceMessages.button`, `submit.clearOnSubmit`, `showCharacterCount`, `showSlowmodeIndicator`, `showTypingIndicator`, `upsellLongMessages.iconOnly` |
| `OVERLAY` | `ChannelMessage` (`autoSave`) | `autocomplete.forceChatLayer`, no `gifts`, `upsellLongMessages.iconOnly` |
| `OVERLAY_INLINE_REPLY` | `ChannelMessage` | `submit.useDisabledStylesOnSubmit`, `clearOnSubmit` |
| `SIDEBAR` | `ChannelMessage` + `SlashCommand` | `disableAutoFocus`, no `gifs.button` |
| `EDIT` | `ChannelMessage` | `expressionPicker.onlyEmojis`, `showCharacterCount` |
| `FORM` | `ChannelMessage` | `submit.allowEmptyMessage`, `autocomplete.alwaysUseLayer`, `autocomplete.small` |
| `VOICE_CHANNEL_STATUS` | `ChannelMessage` | `submit.allowEmptyMessage`, `permissions.requireSendMessages` |
| `THREAD_CREATION` | `FirstThreadMessage` | `permissions.requireCreateTherads`, `submit.button` |
| `USER_PROFILE` / `USER_PROFILE_REPLY` | `ChannelMessage` | `submit.clearOnSubmit`, `toolbarType:2` |
| `PROFILE_BIO_INPUT` | `ChannelMessage` | `submit.disableEnterToSubmit` |
| `GENERIC_RICH_TEXTAREA` | `ChannelMessage` | `submit.disableEnterToSubmit`, `permissions.requireSendMessages` |
| `CUSTOM_GIFT` | `ChannelMessage` | `emojis:{}`, `submit.disableEnterToSubmit` |
| `RULES_INPUT` | `ChannelMessage` | `hideAttachmentBar`, `showCharacterCount` |
| `CREATE_FORUM_POST` | `FirstThreadMessage` | `submit.disableEnterToSubmit`, `hideAttachmentArea` |
| `CREATE_ANNOUNCEMENT_POST` | `FirstThreadMessage` | inherits `NORMAL`, `stickers.allowSending:false`, `gifts:{}`, `commands.enabled:false` |
| `CREATE_POLL` | `ChannelMessage` | `submit.disableEnterToSubmit` |
| `FORUM_CHANNEL_GUIDELINES` | `ChannelMessage` | `autocomplete.alwaysUseLayer` |
| `CHANNEL_TOPIC` | `ChannelMessage` | `autocomplete.alwaysUseLayer` |
| `ATOMIC_REACTOR_REPLY_INPUT` | `ChannelMessage` | `submit.disableEnterToSubmit` |
| `FORWARD_MESSAGE_INPUT` | `ChannelMessage` | `soundmoji.allowSending` |
| `SHARE_CUSTOM_CLIENT_THEME_INPUT` | `ChannelMessage` | `emojis.button` |
| `CONJURE_PATCH_NOTES` | `ChannelMessage` | `emojis.button` |
| `GUILD_ROOM` | `ChannelMessage` | `permissions.requireSendMessages` |
| `CREATE_GAME_INVITE_POST_DESCRIPTION` | `FirstThreadMessage` | `submit.disableEnterToSubmit` |

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Accessory bar (DOM)
| DOM idx | Attributes | Role | Evidence of name |
| --- | --- | --- | --- |
| `6082` | `class,tabindex,multiple,accept,aria-hidden,type,style` | hidden `<input type=file multiple>` for uploads | `aria-hidden`; `accept` present but value not captured |
| `6084` | `class,aria-label,aria-expanded,aria-haspopup,aria-disabled,tabindex,role` | attach / "Add Media" trigger | bundle label `"nzoF5p":["Add Media"]` (`8b9a4b4a55eaa34c.js` @ `180225` region) |
| `6102` | `class,aria-label,aria-disabled,tabindex,role` | send control (leftmost of the right cluster in DOM order) | **not present in the accessibility tree** — see Gaps |
| `6127` | `class,aria-label,aria-expanded,aria-haspopup,aria-controls,aria-disabled,tabindex,role` | expression picker (emoji) | `accessibility.nodes[1340]` button `Add Emoji` |
| `6165` | `class,aria-label,aria-expanded,aria-haspopup,aria-controls,aria-disabled,tabindex,role` | GIF / sticker picker | `accessibility.nodes[1814]` button `Open GIF picker`, `accessibility.nodes[1338]` button `Open sticker picker` |
| `6228` | `class,aria-expanded,aria-label,aria-controls,tabindex,role` | Apps launcher | `accessibility.nodes[1342]` button `Apps` (`hasPopup=dialog`) |
| `6233` | `class,tabindex,aria-label,aria-expanded,aria-haspopup,role` | gift picker | `accessibility.nodes[1813]` button `Send a gift` |
| `6256` | `class,aria-live,aria-atomic` | live region inside the composer `<form>` | `dom.nodes[6256]` |

- [Observed] Accessibility-tree names present in the composer subtree: `Add Emoji`, `Open GIF picker`, `Open sticker picker`, `Apps`, `Send a gift` (`accessibility.nodes[1338,1340,1342,1813,1814]`). Button labels used by the accessory bar are i18n entries in `8b9a4b4a55eaa34c.js`: `Add Emoji` (`lPHwuQ`), `Send GIF` (`nffuyb`), `Send Sticker` (`oOJ7KU`), `Launch Apps` (`dHDxOF`), `Add Media` (`nzoF5p`), `Reply to Message` (`3tYNDS`).

### Composer parts
| Part | Behaviour | Evidence |
| --- | --- | --- |
| Text box | Slate `contenteditable` div; `aria-invalid` set from length | `dom.nodes[6092]`; bundle `"aria-invalid":e.length>g` @ `3367402` region |
| Attachment strip | horizontal row of upload cards; `getUploads(channelId, draftType)` | `web...js` @ `3439817` `f.A.getUploads(t,n.drafts.type)`; `l.hD`/`l.PR` navigator at `3440876` |
| Command/app attachments | application-command `ATTACHMENT` option types render as upload cards | `3440297` `C?.filter(e=>e.type===_.n4.ATTACHMENT&&R?.[e.name]?.hasValue)` |
| Send button | present in DOM with `aria-disabled` | `dom.nodes[6102]` |
| Emoji picker | `TOGGLE_EMOJI_POPOUT` event; `insertEmoji` writes `:name:` text | `3422280` region `nh(...)`; `3346759` `insertEmoji(e){let{emoji:t,addSpace:n=!1}=e;this.insertText(`:${t.name}:`,void 0,n)}` |
| GIF picker | `TOGGLE_GIF_PICKER`; Shift → `insertGIF`, else insert URL + analytics | `3421023` `n_` helper: `if(r?.shiftKey===!0||...){n.current?.insertGIF(i)}else{...e(i.url,void 0,void 0,!0,void 0,t)}` |
| Sticker picker | `TOGGLE_STICKER_PICKER`; inserts `{value:"",uploads:void 0,stickers:[e.id]}` and clears the editor | `3422167` region |
| Voice message | `voiceMessages.button` flag + `RECORD_VOICE_MESSAGE` keybind (`alt+r`, `ctrl+shift+d` on Mac) | `3329478` region; shortcut map `938812` |
| Channel affordances | `showThreadPromptOnReply`, `showSlowmodeIndicator`, `showTypingIndicator`, `showCharacterCount` are per-type flags | `3329478`–`3337916` |

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Send semantics
| Rule | Value | Evidence |
| --- | --- | --- |
| Enter submits | yes, unless one of the escapes below | `web...js` @ `3357872` `e.key!==x.dh.ENTER\|\|(e.altKey\|\|e.shiftKey\|\|i&&!e.ctrlKey\|\|(0,ee.Q9)(t))&&c\|\|(e.preventDefault(),e.stopPropagation(),u())` |
| Shift+Enter | inserts a newline when `allowNewLines` is true; no send | same expression (`e.shiftKey`) |
| Alt+Enter | inserts a newline when `allowNewLines` is true; no send | same expression (`e.altKey`) |
| `disableEnterToSubmit` | when true, plain Enter does not submit unless Ctrl is held | same expression (`i&&!e.ctrlKey`) — `i` = `disableEnterToSubmit` |
| `allowNewLines=false` | Enter always submits, even with Shift/Alt | same expression (`&&c` where `c` = `allowNewLines`) |
| Character limit | **2000** base, **4000** with premium | `web...js` @ `315820` `let nx=100,nk=200,...,nY=2e3,nK=4e3,...`; exported as `uvi` (2000) and `CS1` (4000) @ `236671` |
| Limit selection | `canUseIncreasedMessageLength(currentUser)` picks the cap | `6202117` `function l(e){return a.Ay.canUseIncreasedMessageLength(e.getCurrentUser())?s.CS1:s.uvi}` |
| Where enforced | at submit, before the gateway call | `10005816`–`10006217` `let p=_?A.CS1:A.uvi;if(l.length>p){...}` |
| Over-limit path (free user) | modal alert: title `Your message is too long.`, body `Please make your message of {currentLength} characters shorter. We've set the limit at {maxLength} characters to be courteous to others.`, analytics `OPEN_MODAL` `{type:"Message Too Long Alert",message_content_length:g}` | `10006217` + i18n `"l8rYLt"`, `"FfjF15"`, `"BddRzS"` |
| Over-limit path (premium user) | dispatch `MESSAGE_LENGTH_UPSELL` `{channel, content}` | `10006217` `i.h.dispatch({type:"MESSAGE_LENGTH_UPSELL",channel:d,content:l})` |
| Failure reason | `MESSAGE_TOO_LONG` returned to the caller | `10006217` `I({valid:!1,failureReason:A.X8x.MESSAGE_TOO_LONG})` |
| Character counter | shown when `showCharacterCount`; "remaining" text appears in the last 10% of the budget | `3545219` `h=(o??u)-_,f=h>(d??o??u/10);return{isVisible:E&&h>=0||!f,showsUpsell:A&&!f}` |
| Counter strings | `{count} characters remaining`, `Message is at max length`, `Character limit reached`, `Message is too long` | i18n `"qH8uFW"`, `"tU6YQ7"`, `"c2Jqed"`, `"YSRIqa"` in `8b9a4b4a55eaa34c.js` @ `179465` |
| Nitro upsell copy | `You've hit the {maxLength} character count limit. Speak your mind with 2x longer messages, send larger file uploads, and more with Discord Nitro!` | i18n `"moN9wh"` @ `952445` |
| Submit clears draft | `submit.clearOnSubmit` → `saveDraft(channelId, "", drafts.type)` or `clearValue()` | `3420756` region |

### Send-time validation pipeline (order matters)
- [Inferred] The checks below run in this order.
1. [Observed] `0===l.length && !type.submit?.allowEmptyMessage && !hasStickers && !hasAttachments && !hasComponents` → `EMPTY_MESSAGE`.
2. [Observed] `l.length > maxLength` → modal or Nitro upsell → `MESSAGE_TOO_LONG`.
3. [Observed] Slowmode: `getSlowmodeCooldownGuess(channelId) > 0` (and `respectCooldown`) → `SLOWMODE_COOLDOWN`.
4. [Observed] Shout/confirm warning list: each `{check, analyticsType, animation}`; confirm → valid, cancel → `SHOUTING_CANCELLED`.
5. [Observed] Rate limit: `a.Ay.isFull()` → modal → `RATE_LIMITED`.
6. [Observed] Else `valid:true`.

- [Observed] Failure-reason enum: `tl.EMPTY_MESSAGE="EMPTY_MESSAGE", tl.MESSAGE_TOO_LONG="MESSAGE_TOO_LONG", tl.RATE_LIMITED="RATE_LIMITED", tl.SHOUTING_CANCELLED="SHOUTING_CANCELLED", tl.SLOWMODE_COOLDOWN="SLOWMODE_COOLDOWN"` (`web...js` @ `529510`).
### Reply state
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Reply prompt | a reply banner above the composer names the replied-to user | `3411334` region renders `y.intl.formatToPlainString(y.t.EpJL4E,{username:h})` |
| Reply depth | walks up to 10 `messageReference` hops to detect thread context | `3411334` `for(let n=0;n<10;n++){let i=tO.A.getMessage(t,e);if(i?.type!==el.lAJ.REPLY\|\|null==i.messageReference)return n;e=i.messageReference.message_id}` |
| Thread prompt | shown when `showThreadPromptOnReply && depth >= 2` | `3411334` `R=l.showThreadPromptOnReply&&C>=2&&O` |
| Cancel | the reply banner's dismiss control clears the reply reference | `3411334` `onClick:()=>(0,tN.pX)(el.BVt.CHANNEL(o.guild_id,...))` (channel navigation) plus the banner's own close affordance |
### Edit state
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Edit is a distinct composer type | `EDIT` type record with `drafts:{type:ChannelMessage}` and `showCharacterCount` | `3331322` region |
| Edit detection at runtime | `chatInputType===S.oU.EDIT` toggles markdown preview on parent edits | `3350677` `if("parent"===t&&!e.previewMarkdown&&e.chatInputType===S.oU.EDIT){...}` |
| Cancel path | `clearValue()` → `saveDraft(channelId,"",draftType)` then `CLEAR_TEXT` event | `3363561` + `handleClearText` @ `3367402` region |
| Draft type is shared with normal messages | both use `ChannelMessage` | `3329478` / `3331322` |
### Mention autocomplete
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Trigger character | `@` | `MENTION_HERE`/`MENTION_GAME`/`MENTION_TIMESTAMP` descriptors carry `text:"@here"`, `text:"@game"`, `text:"@time"` @ `10002681` |
| Autocomplete kind enum | `MENTIONS, CHANNELS, EMOJIS_AND_STICKERS, REACTIONS, STICKERS, GIFS, LEGACY_COMMANDS, COMMANDS, COMMAND_OPTIONS, CHOICES, GAME, TIMESTAMPS` | `web...js` @ `3314700` (module `597184` export `DB`) |
| Inner option kinds | `MENTION, CHANNEL, EMOJI, STICKER, SOUNDMOJI, REACTION, GIF, COMMAND, COMMAND_OPTION, COMMAND_SUGGESTION, CHOICE, EMOJI_UPSELL, GAME_MENTION, TIMESTAMP` | same module, export `kc` |
| Source of options | lazily imported module `778572` exposing `findCommandOptionAutocompleteType`, `findMatchingAutocompleteType`, `getOptions` | `3311210` `await Promise.all([n.e("435751"),n.e("423798"),n.e("753149")]).then(n.bind(n,778572))` |
| Current-word extraction | from the Slate editor: `getSelectedParentOfType` + `range` + `getTextFromRange` | `3311210` `t=null!=(e=l.VW.getSelectedParentOfType(A,E))?l.VW.getTextFromRange(A,l.VW.range(A,e[1])):null` |
| Result fetching | `typeInfo.queryResults(channel, guild, queryText, options, isRefresh)` returns `{results, metadata}` | `3311241` `let{results:N,metadata:C}=p.queryResults(this.props.channel,this.props.guild,T,u,m)` |
| Debounce | `setTimeout(..., 0)` coalescer, not a timed debounce | `3311210` `this.updateTimeout=setTimeout(()=>{...},0)` |
| Keyboard nav | ArrowUp / ArrowDown / Ctrl+P / Ctrl+N / Escape / Tab | `3356620` `case G.Ks6.ARROW_UP: if(E(-1)) return void e.preventDefault(); ... case G.Ks6.P: if((0,ea.j)(e,{ctrl:!0})&&E(-1))... case G.Ks6.N: ... case G.Ks6.ESCAPE: _?.()` |
| Selection mode | `INSERT` (insert into the editor) vs `SEND` (send the message directly, e.g. a slash command with no args) | `3314700` `I=((o={}).INSERT=0,o[o.SEND=1]="SEND")`; `selectResult` passes `type:t?_.lg.SEND:_.lg.INSERT` |
| Insertion format | raw markup, not a chip: user `<@id>`, role `<@&id>`, channel `<#id>\t` (trailing tab) | `3528339` `i.type===a.n4.CHANNEL\|\|... ? `<#${s}>\t` : ...USER... ? `<@${s}>` : ...ROLE... ? `<@&${s}>` : s` |
| In-editor rendering | the selected option renders as an inline non-editable span (`contentEditable:!1`) carrying `optionDisplayName` plus a `\u200B` zero-width space | `3348440`–`3348812` `contentEditable:!1,onClick:T,children:[a.optionDisplayName,"\u200B"]` |
| ARIA contract | `aria-haspopup="listbox"`, `aria-expanded`, `aria-activedescendant`, `aria-autocomplete="list"` | `3367402` region; `dom.nodes[6092]` |
| Virtual focus | the listbox uses `useVirtualFocus:!0` — DOM focus stays on the editor, `aria-activedescendant` moves | `3304284` `useVirtualFocus:!0,setFocus:function(e,t){...scrollIntoViewNode(...)}` |
| "@everyone/@here" | special mention descriptors with `test`/`text`/`description` | `10002681` `MENTION_HERE:()=>({test:"here",text:"@here",description:...})` |
| "@game" | `inlineAutocompleteType:"gameMentionInput"`, `autoInsertOnSpace:!0` | `10002681` |
### Slash command autocomplete
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Kinds | `LEGACY_COMMANDS` (text commands) and `COMMANDS` (slash/application commands) | `3314700` `DB` enum |
| Option kinds | `COMMAND`, `COMMAND_OPTION`, `COMMAND_SUGGESTION`, `CHOICE` | `3314700` `kc` enum |
| Catalogue | server application commands; per-channel active command state | `d.A.getActiveCommand(t.id)` / `d.A.getActiveOption(t.id)` @ `3392171` |
| Command options mode | `DISABLED`, `OLD_BUILT_INS`, `NEW_TEXT_ONLY`, `NEW` | `3314700` `f=((l={}).DISABLED=0,l[l.OLD_BUILT_INS=1]="OLD_BUILT_INS",l[l.NEW_TEXT_ONLY=2]="NEW_TEXT_ONLY",l[l.NEW=3]="NEW")` |
| Enabled flag | `chatInputType.commands.enabled` | `3329478` `commands:{enabled:!0}` |
| Tab cycles command options | `selectNextCommandOption` / `selectPreviousCommandOption` | `3356620` `case G.Ks6.TAB: ... e.shiftKey?K.b.selectPreviousCommandOption(t):K.b.selectNextCommandOption(t)` |
| Result type | a selected command is sent with `type: SEND` (immediate send) rather than inserted | `selectResult` `type:t?_.lg.SEND:_.lg.INSERT` |
| Interaction rendering | a command invocation renders as a distinct "interaction" message body, not plain text | bundle renders `optionDisplayName` + `optionDisplayName` for command options @ `3348440`; command result bodies use `interaction` message type server-side |
### Emoji picker
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Entry points | accessory-bar button (`Add Emoji`, `dom.nodes[6127]`) and the `mod+e` shortcut → `TOGGLE_EMOJI_POPOUT` | `877991` module: `{binds:["mod+e"],comboKeysBindGlobal:!0,action:()=>...dispatchToLastSubscribed(s.jej.TOGGLE_EMOJI_POPOUT)}` |
| Insertion | plain text `:name:` with optional trailing space | `3346759` `this.insertText(`:${t.name}:`,void 0,n)` |
| Search | `SEARCH_EMOJIS` keybind family; picker has a search field | shortcut map `938812` `[y.IWg.SEARCH_EMOJIS]:$.L` |
| Categories / recents | picker layout constants `EMOJI_PICKER_CONSTANTS_*` incl. `EMOJI_LIST_PADDING_TOP`, `EMOJI_SECTION_MARGIN_BOTTOM`, `EMOJI_PREMIUM_UPSELL_HEIGHT`, `UNICODE_CATEGORY_ICON_SIZE`, `GUILD_CATEGORY_ICON_SIZE`, `DIVERSITY_EMOJI_SIZE` | `web...js` @ `4493069` region |
| Picker chunk | emoji data is a separate chunk `vnd-emoji.eb9fa44f37371d3b.js` (1,192,954 bytes) | `resources.json` → `https://discord.com/assets/vnd-emoji.eb9fa44f37371d3b.js` |
| Custom emoji | guild emoji are stored separately per channel (`getStickerPreview` analogue) and rendered in the picker | `emojiPicker` code paths reference guild emoji stores |

### Attachments
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Entry points | hidden `<input type=file multiple>` (`dom.nodes[6082]`), `mod+shift+u` → `UPLOAD_FILE` event, paste, drag-drop | `dom.nodes[6082]`; shortcut map `[y.IWg.UPLOAD_FILE]:{binds:["mod+shift+u"],...}`; paste handler `handlePaste` @ `3367402` region |
| Upload state | per channel + per draft type: `getUploads(channelId, draftType)`, `getUploadCount`, `clearAll`, `remove` | `3392171`, `3440297`, `3440876` |
| Upload progress | throttled progress callback at **50 ms** | `throttle(...,50)` call sites |
| Size caps | server-driven perks `MAX_FILE_SIZE_50_MB`, `MAX_FILE_SIZE_100_MB`, `MAX_FILE_SIZE_250_MB`, perk kind `INCREASED_FILE_UPLOAD_SIZE` with `max_size` | `web...js` @ `253509` and `6996950` |
| Attachment option on slash commands | application-command `ATTACHMENT` option type produces an upload card in the attachment strip | `3440297` |
| Rendering | upload card component with optional clip preview, small/medium size (`p.L.SMALL`/`p.L.MEDIUM`), keyboard-mode aware | `3441262` `smallAttachments:T=!1 ... size:T?p.L.SMALL:p.L.MEDIUM` |
| Cancelling an upload restores the previous draft | `UPLOAD_CANCEL_REQUEST` → re-saves the previous draft text | `3571775` `p.cancel(e,t){h.h.dispatch({type:"UPLOAD_CANCEL_REQUEST",channelId:e,file:t}); ... h.h.dispatch({type:"DRAFT_SAVE",channelId:n.channel_id,draft:n.content,draftType:f.C.ChannelMessage})}` |

### Typing indicator
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Emission (outbound) | HTTP `POST /channels/{id}/typing`, not a gateway op | route constant `TYPING:e=>`/channels/${e}/typing`` @ `271788` |
| Receipt (inbound) | gateway dispatch `TYPING_START` → Redux `TYPING_START` with `guildId, channelId, userId, customTypingIndicatorConfig` | `5016182` `eB(["TYPING_START"],e=>{...ej({type:"TYPING_START",guildId:e.guild_id,channelId:e.channel_id,userId:e.user_id,...})})` |
| Rendering | per-channel tracking store; only text channels tracked; self-typing ignored | `6550087` `TYPING_START:es(function(e){if(!F)return!1;let t=h.default.getCurrentUser()?.id??null;if(null==t\|\|e.userId===t)return!1;...` |
| Composer flag | `showTypingIndicator` is a per-`chatInputType` flag | `3329478` region |

### Draft persistence
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Store | reducer-driven, dispatched action `DRAFT_SAVE` / `DRAFT_CHANGE` / `DRAFT_CLEAR` / `DRAFT_COMMAND_CLEAR` | `595532` `saveDraft(e,t,n,r){i.h.dispatch({type:"DRAFT_SAVE",channelId:e,draft:t,draftType:n,command:r})}` |
| Keying | `userId → channelId → draftType → {timestamp, draft, command}` | `9169586` `getDraft(e,t){let n=u.default.getId();if(null==n)return"";let i=I(n)[e];if(null!=i){let e=i[t];if(null!=e)return e.draft}return""}` |
| Draft types | `ChannelMessage`, `FirstThreadMessage`, `SlashCommand` | `3329478` `drafts:{type:s.C.ChannelMessage,commandType:s.C.SlashCommand,...}` |
| Autosave | **throttled at 500 ms**, only when `drafts.autoSave` is set | `3364771` `saveCurrentTextThrottled=o().throttle(this.saveCurrentText.bind(this,!1),500)`; `3364771` `n.drafts.autoSave&&(t&&e.saveCurrentTextThrottled.cancel(),e.handleSaveCurrentText(i.id))` |
| Survives reload | yes — persisted store, rehydrated by user id | `9169586` persisted selector `I(n)` |
| Survives tab/channel switch | thread creation explicitly migrates the channel draft into the first-thread-message draft | `8071405` `""===p.A.getDraft(e.id,p.C.FirstThreadMessage)&&{let t=p.A.getDraft(e.id,p.C.ChannelMessage);s.A.saveDraft(e.id,"",p.C.ChannelMessage),s.A.saveDraft(e.id,t,p.C.FirstThreadMessage)}` |
| Cleared on | successful submit (`submit.clearOnSubmit`), explicit clear (`clearValue()`), and thread migration | `3420756`, `3363561`, `8071405` |
| Unload flush | `handleBeforeUnload=()=>this.saveCurrentText()` | `3364771` |
| Recently edited list | `getRecentlyEditedDrafts(draftType)` sorted by `timestamp` descending | `9169586` |
| Command drafts | command state stored alongside text under the same record (`command` field) | `595532` |

### Disabled / "cannot send" states
| Reason | How it is computed | Evidence |
| --- | --- | --- |
| Missing `SEND_MESSAGES` permission | `messagesDisabled = !isPrivate && !can(SEND_MESSAGES) \|\| archived` | `3392808` `return{messagesDisabled:n\|\|!t&&!r\|\|a}` |
| Commands unavailable | same expression includes `!n` where `n = commands.enabled` | `3392808` |
| Archived / locked channel | helper `(0,u.UJ)(e)` folded into `messagesDisabled` | `3392808` |
| Empty message | `EMPTY_MESSAGE` at submit time | `10005816` region |
| Over limit | `MESSAGE_TOO_LONG` | `10006217` |
| Slowmode cooldown | `SLOWMODE_COOLDOWN` | `10006217` |
| Rate limited | `RATE_LIMITED` | `10006217` |
| Submit disabled styling | `submit.useDisabledStylesOnSubmit` flag | `3329478` region |
| Send button state | `aria-disabled` on the send control | `dom.nodes[6102]` |
| Lacking permission to attach | `canAttachFiles` = `attachments===true && (isPrivate \|\| pendingMember \|\| can(ATTACH_FILES) \|\| hasSendPermission)` | `3422280` region `nm(...)` |

## Interaction model
1. [Observed] Focus lands on the Slate editor; `data-can-focus="true"` marks the focusable target.
2. [Observed] Typing fires `onChange` → rich value + plain text; the composer state updates.
3. [Observed] `@` opens the mention autocomplete (virtual focus, `aria-activedescendant`).
4. [Observed] Arrow keys / Ctrl+P / Ctrl+N move the selection; Enter selects (INSERT or SEND); Escape closes.
5. [Observed] Enter submits unless Alt/Shift/`disableEnterToSubmit`; validation runs first and may raise a modal, an upsell, or a slowmode/permission failure.
6. [Observed] On success the composer clears (if `submit.clearOnSubmit`), the draft is emptied, and the editor is refocused.
7. [Observed] Typing in the channel fires `POST /channels/{id}/typing` (throttled upstream).

## Performance notes
- [Observed] Draft autosave is throttled to 500 ms — the editor never writes state on every keystroke (`3364771`).
- [Observed] Autocomplete result refresh is a `setTimeout(…, 0)` coalescer, so a burst of keystrokes produces one query per macrotask (`3311210`).
- [Observed] Autocomplete option sources (`findMatchingAutocompleteType`, `getOptions`) live in a **lazily loaded chunk** (`n.e("753149")`), so the mention engine is not in the main bundle (`3311210`).
- [Observed] The user/mention candidate set is maintained in a **Web Worker** (`/assets/167470`) with an explicit `rebootWebworker()` lifecycle (`3118306`).
- [Observed] Attachment upload progress is throttled to 50 ms.
- [Observed] The character counter recomputes only when length crosses the 10% band (`3545219`).

## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| ID | What it shows |
| --- | --- |
| `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | REA `inspect_web_page` capture of the live client (`inspect-main.json`): DOM node list, accessibility tree, script/resource inventories |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | REA `list_browser_targets`: page target `A726384904E087D2F74FC6B86E22A4BD`, `https://discord.com/channels/345096814443233301/345096814443233302`, Electron/42.11.15, Chrome/148 |
| `chunks/web.31d1cd3e6e440749.js` | 12,547,650 B main bundle: composer, autocomplete, validation, shortcuts, gateway client |
| `chunks/8b9a4b4a55eaa34c.js` | 1,433,778 B: i18n string table (composer labels, length-limit copy) |
| `chunks/72993.12b05c70c0a616dc.js` | 1,268,835 B: shared UI + Slate-adjacent modules |
| `chunks/vnd-emoji.eb9fa44f37371d3b.js` | 1,192,954 B: emoji dataset/picker chunk |
| `chunks/192743.883920cc41783fd8.js` | 698,302 B: legacy editor + emoji/formatting helpers |
| `chunks/c680dbcc4bd6182b.js` | 437,962 B: secondary chunk |
| `discord-re/screenshot-main.png` | Client screenshot for layout cross-check |

## Gaps
- The send control (`dom.nodes[6102]`) carries `role`/`aria-label`/`aria-disabled`/`tabindex` but **is not represented in the captured accessibility tree** — no button named "Send" exists in the 3,215-node a11y snapshot. Either the accessible name is computed and dropped, or the element is excluded. Not verified.
- `aria-label` **values** are not captured by the REA DOM projection (it records attribute names only). Names for the accessory bar were recovered from the accessibility tree and the i18n table, not from the DOM attributes themselves.
- The `accept` filter and `multiple` semantics of the file input (`dom.nodes[6082]`) were observed as attribute names only.
- The exact emoji-picker category list and recents algorithm live in the lazy `vnd-emoji` chunk and a runtime store; they were not enumerated.
- The message-persistence layer behind `DRAFT_SAVE` (IndexedDB vs localStorage) was not resolved; only the persisted-store contract was observed.
- The mention autocomplete's `getOptions` implementation is in a chunk not present locally (`n.e("753149")` → module `778572`); the option-set construction is inferred from the calling contract.
- Command "interaction" result rendering was confirmed at the composer/option level; the server-side message body shape was not observed.
## User Decision:
## Target Contract
> Status: Target. Discord's composer is a reference for CrowdOS's chat input; CrowdOS keeps its own locked design contract.

- CrowdOS composer MUST keep one text input, one accessory bar, one send affordance, and one attachment strip. Additional independent composers per surface are forbidden.
- Character limit MUST be enforced **at submit**, not only by UI truncation, and MUST produce an explicit, non-blocking failure reason rather than silent truncation.
- CrowdOS MUST keep a per-channel draft that survives reload and is cleared on successful send; draft writes MUST be throttled, never per-keystroke.
- Autocomplete MUST expose a listbox relationship (`aria-haspopup="listbox"`, `aria-expanded`, `aria-activedescendant`) and MUST support Arrow/Enter/Escape keyboard operation.
- CrowdOS MUST NOT block the composer for permission or archive state without an explicit, announced reason.
- Typing MUST be emitted on a throttle and MUST be delivered out-of-band (transport), never through the message pipeline.
- Attachments MUST have a server-authoritative size cap and MUST surface upload progress without re-rendering the text input.
- CrowdOS MUST NOT adopt Discord's raw-mention-markup storage format (`<@id>`) as its wire format; the CrowdOS message contract is fixed and takes precedence.
- Visual parity with Discord's composer is NOT required; structure and behaviour are.

# Composer, Mentions, Runtime

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding of the channel composer, the mention routing surface and the runtime/mode selector. Canonical CrowdOS documentation remains `re-docs/Frontend Docs/` (Domain Spec `Chat Area.md`, Feature and Flow Spec `Mention autocomplete.md`, `Send-message flow.md`); this file records what the code does today, for side-by-side comparison with the RE corpus.

## Purpose

Describe how a message is composed, addressed and dispatched: the composer's caps and auto-grow, the send pipeline and its overflow guard, mention detection and chip routing, per-channel drafts and the offline queue, the six-mode runtime selector with its server-backed per-channel pin, the follow-up scope toggle, and the status strip that reports what is actually known.

## How it works

The composer is **not a separate component**. It is inline in `MainChatArea.tsx`, inside a container div that is also the drag-and-drop target (`MainChatArea.tsx:1364-1657`). The text input is a plain `<textarea rows={1}>` with `maxLength={4000}` and a bounded auto-grow (`MainChatArea.tsx:1516-1530`, `:275-280`).

Three surfaces share the composer's local state:

| Surface | State | Lifetime |
|---|---|---|
| Text | `inputText` | per channel (draft-persisted) |
| Mentions | `selectedMentions` (one-shot) + `stickyMentionsByChannel` (pinned) | one-shot per channel; sticky in-memory only |
| Attachments | `attachments` | component-local, never persisted |
| Runtime | `selectedMode` from the store | per channel, server-pinned or temporary |
| Follow-up scope | `appliesTo[channelId]` | per channel, in-memory |

Send is a single function, `handleSend` (`MainChatArea.tsx:549-629`), with this order:

1. **Offline short-circuit.** `navigator.onLine === false` → `queueSend(...)` plus a "Queued offline" toast, and the composer keeps its text (`MainChatArea.tsx:554-563`).
2. **Projected-length overflow guard.** The projected send length (draft + mention prefix) is compared to the 4000-char cap; if over and the confirm dialog is not already open, the confirm opens and the send returns (`MainChatArea.tsx:568-573`).
3. **Empty check.** A send is refused only if there is no text, no attachment, no one-shot mention and no sticky mention (`MainChatArea.tsx:575`).
4. **Mention re-serialisation.** The mention chips are turned back into `@name` text and prefixed to the body (`MainChatArea.tsx:585-589`).
5. **Dispatch.** `addMessage({...})` with the live mode read from the store at send time (`MainChatArea.tsx:597-610`).
6. **Reset.** Text, attachments and one-shot mentions are cleared, the persisted draft is cleared, the missed count is zeroed and `resume()` re-pins the stream (`MainChatArea.tsx:612-624`).
7. **Refocus + cooldown.** `requestAnimationFrame(() => composerRef.current?.focus())` and a 600 ms `isSending` reset (`MainChatArea.tsx:626-628`).

Mention detection is caret-based: `handleInputChange` takes the text before the caret, splits on whitespace, and opens the listbox when the last token starts with `@` (`MainChatArea.tsx:483-504`). The filter is a plain case-insensitive **substring** match over agent names (`MainChatArea.tsx:506-508`). `insertMention` **removes** the `@token` from the textarea and adds a chip instead (`MainChatArea.tsx:531-547`) — so the draft text and the sent text are not the same string; the chips are the routing source of truth.

Runtime selection is a 6-entry dropdown (`auto`, `chat`, `agentic`, `coding`, `research`, `swarm`) in `ModeSelector.tsx:24-33`, with a separate pin toggle carrying `aria-pressed` (`ModeSelector.tsx:108-119`). The pin is **per channel** and **server-authoritative**: it writes `channel_settings.pinned_runtime` through `apiClient.updateChannelSettings` and is re-hydrated on channel entry via `hydrateChannelPin` (`crowdOsStore.ts:2045-2074`, `:2081-2111`, `:2902`).

The composer vocabulary and the server vocabulary are different sets. The client speaks composer modes; the server validates runtime names, so a translation layer is mandatory (`packages/client/types/crowdOs.ts:283-321`).

## Structural inventory

| Component | File:line | Role | Key state |
|---|---|---|---|
| Composer container | `MainChatArea.tsx:1364-1375` | Drag-and-drop target, focus ring host | `isDragging` |
| Attachment/mention chip row | `MainChatArea.tsx:1377-1492` | One-shot + sticky mention chips, attachment chips | `attachments`, `selectedMentions`, `stickyMentionsByChannel` |
| `StatusStrip` | `StatusStrip.tsx:50-126` | Single `role="status"` line above the textarea | props only (no store) |
| Composer textarea | `MainChatArea.tsx:1516-1530` | `rows=1`, `maxLength=4000`, auto-grow | `inputText` |
| Character counter | `MainChatArea.tsx:1531-1537` | Shows only above 3000 chars | `inputText.length` |
| Follow-up scope toggle | `MainChatArea.tsx:1542-1557` | "Applies to: current \| next" | `appliesTo[channelId]` |
| Attachment menu | `MainChatArea.tsx:1561-1593` | Opens the hidden file input | `showAttachmentMenu` |
| `EmojiPickerPopover` | `EmojiPickerPopover.tsx:18-45` | Fixed 24-emoji grid | `showEmojiPicker` |
| Hidden file input | `MainChatArea.tsx:1624-1630` | `multiple`, `type=file` | `fileInputRef` |
| `ModeSelector` | `ModeSelector.tsx:24-162` | 6 modes + pin toggle, listbox | `isOpen`, `mentionIndex`-free |
| Send button | `MainChatArea.tsx:1640-1653` | Dispatches `handleSend` | `canSend`, `isSending` |
| Mention popover | `MainChatArea.tsx:1339-1361` | `role="listbox"` of agents | `showMentions`, `mentionFilter`, `mentionIndex` |
| `handleMentionKeydown` | `MainChatArea.tsx:510-529` | Enter/Tab/Arrow/Escape routing | `showMentions`, `filteredAgents` |
| `handleSend` | `MainChatArea.tsx:549-629` | Full send pipeline | `confirmOverflowOpen` |
| `insertMention` | `MainChatArea.tsx:531-547` | Removes `@token`, adds a chip | `selectedMentions` |
| `handleInputChange` | `MainChatArea.tsx:483-504` | Caret token detection + truncation | `mentionFilter` |
| `addFilesToArray` | `MainChatArea.tsx:303-332` | 5 MB / 10-file caps, data-URL read | `attachments` |
| Auto-grow effect | `MainChatArea.tsx:275-280` | Clamps height to `COMPOSER_MAX_HEIGHT` | `composerRef` |
| Draft restore effect | `MainChatArea.tsx:243-257` | Loads text/chips/runtime on channel switch | `draftByChannel` |
| Draft save effect | `MainChatArea.tsx:258-269` | 500 ms debounced persist | `setDraft` |
| `composer-preflight-model.ts` | `composer-preflight-model.ts:10-70` | Pure overflow/short-path/cost helpers | — (no React, no store) |
| `COMPOSER_MODE_META` | `types/crowdOs.ts:258-265` | Per-mode qualitative latency/cost/scope copy | — (static) |
| `COMPOSER_MODE_TO_RUNTIME` | `types/crowdOs.ts:295-301` | Client→server vocabulary map | — (static) |
| `RUNTIME_TO_COMPOSER_MODE` | `types/crowdOs.ts:304-310` | Server→client vocabulary map | — (static) |
| `setMode` | `crowdOsStore.ts:2017-2037` | Sets mode; re-pins when pinned | `selectedMode`, `pinnedModeByChannel` |
| `togglePin` | `crowdOsStore.ts:2045-2074` | Writes `channel_settings.pinned_runtime` | `isPinned` |
| `hydrateChannelPin` | `crowdOsStore.ts:2081-2111` | Server row is authoritative in both directions | `pinnedModeByChannel` |
| `resetOnChannelChange` | `crowdOsStore.ts:2113-2132` | Arriving channel's own pin decides | `selectedMode` |
| `setDraft` / `clearDraft` | `crowdOsStore.ts:4027-4053` | Per-channel draft slice + mirror | `draftByChannel` |
| `queueSend` / `flushOutbox` | `crowdOsStore.ts:4061-4114` | Offline outbox, ordered flush | `outbox` |
| `setAppliesTo` | `crowdOsStore.ts:4126-4132` | Follow-up scope per channel | `appliesTo` |

## Implementation details

**Composer caps.** `MAX_MESSAGE_LEN = 4000`, `MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024`, `COMPOSER_MAX_HEIGHT = 160` (`MainChatArea.tsx:128-130`). The textarea enforces the cap while typing via `maxLength` and also truncates defensively in `handleInputChange` with a "Message Too Long" toast (`MainChatArea.tsx:485-489`). The auto-grow resets the height to `auto` and then clamps to `scrollHeight` vs 160 px (`MainChatArea.tsx:275-280`), matching the textarea's own `min-h-[52px] max-h-[160px]` bound (`MainChatArea.tsx:1529`).

**Overflow guard.** `projectedSendLength(draftText, mentionNames)` computes `prefix + ' ' + draft` length, where the prefix is the deduped `@name` list (`composer-preflight-model.ts:64-70`). `overflowState` returns `over` above the cap (`composer-preflight-model.ts:22-27`). Because the textarea caps typing, the mention prefix is the only path past the cap — the guard reads the projected length, not the raw draft (`MainChatArea.tsx:564-573`). The confirm dialog offers "Send truncated" (send anyway, truncated) or cancel (draft intact) (`MainChatArea.tsx:1027-1037`). The Send button deliberately stays clickable when over-limit so the guard is reachable (`MainChatArea.tsx:686-696`).

**Mention routing.** At send, one-shot and sticky mentions are merged, deduped by name, and re-serialised as `@a @b body` (`MainChatArea.tsx:577-589`). The `mentions` array also travels on the message payload (`MainChatArea.tsx:607`). The chip row is therefore the routing source of truth, not the visible text (`re-docs/Frontend Docs/Feature and Flow Spec/Mention autocomplete.md:14`).

**Keyboard routing in the composer.** `handleMentionKeydown` intercepts ArrowUp/ArrowDown (cyclical index), Enter/Tab (insert the highlighted agent) and Escape (close the popover) **only while the popover is open and the filtered list is non-empty**. Otherwise a plain Enter (no Shift) sends and Shift+Enter inserts a newline (`MainChatArea.tsx:510-529`).

**Mention popover.** `role="listbox"` with `aria-label="Agent mentions"`, `role="option"` rows carrying `aria-selected`, 46 px minimum row height, a presence indicator, the agent name and an `L{level}` tier badge (`MainChatArea.tsx:1339-1359`). Filtering is substring-only — there is no fuzzy match and no tier/status ordering (`MainChatArea.tsx:506-508`).

**Attachments.** The hidden input is `multiple`; `addFilesToArray` rejects files over 5 MB and stops at 10 attachments, then reads each file as a data URL via `FileReader.readAsDataURL` (`MainChatArea.tsx:303-332`, `:1624-1630`). Drag-and-drop onto the composer calls the same function (`MainChatArea.tsx:339-355`). Chips carry a remove button (`MainChatArea.tsx:1442-1448`). Attachments are **never** part of the persisted draft: the draft row holds text, mention ids, runtime and a display-only mount snapshot (`MainChatArea.tsx:261-266`, `crowdOsStore.ts:4030-4041`).

**Drafts.** On channel switch the draft is loaded from `draftByChannel` into the textarea, the one-shot mention chips are rehydrated from `draft.mentionIds`, and a stored runtime is re-applied (`MainChatArea.tsx:243-257`). A 500 ms debounce persists the draft on every change of text, mentions, mode or channel (`MainChatArea.tsx:258-269`). A successful send clears the persisted draft (`MainChatArea.tsx:619`).

**Offline outbox.** `queueSend` appends a row with a generated id and persists it synchronously so a restart cannot lose it; `flushOutbox` emits queued rows in `queuedAt` order on reconnect and marks a failed row `failed` rather than dropping it (`crowdOsStore.ts:4061-4114`). The flush runs after the gap replay so replayed history lands first (`crowdOsStore.ts:962-984`).

**Follow-up scope.** While a send is in flight, a two-button group appears with `aria-pressed` bound to `appliesTo[channelId] ?? 'next'` (`MainChatArea.tsx:1542-1557`). The store setter accepts only `'current' | 'next'` (`crowdOsStore.ts:4126-4132`).

**Runtime selection and pin.** `ModeSelector` renders six options from a static list and shows the qualitative `latency` / `cost - scope` copy from `COMPOSER_MODE_META`; the Auto slot can show a "Would route to …" hint, but it is hidden while `autoResolvedTo` is null (`ModeSelector.tsx:24-33`, `:133`, `:154`). The trigger supports ArrowUp/ArrowDown cycling and Escape to close (`ModeSelector.tsx:58-77`). The pin toggle writes the **runtime name**, never the composer mode, and `auto` clears the pin by sending `null` (`crowdOsStore.ts:2066-2070`). `hydrateChannelPin` treats the server row as authoritative in both directions: a pin it knows about is applied, and the absence of a pin clears the composer back to Auto (`crowdOsStore.ts:2095-2106`). `resetOnChannelChange` applies only the arriving channel's own pin — a pin from another channel must not leak in, and a temporary selection is discarded on leaving (`crowdOsStore.ts:2113-2132`).

**Vocabulary translation.**

| Composer mode | Server runtime | Notes |
|---|---|---|
| `auto` | `null` | Router path, not a runtime; `null` clears a server pin (`types/crowdOs.ts:313-315`) |
| `chat` | `conversational` | UI name ≠ server name (`types/crowdOs.ts:296`) |
| `agentic` | `agentic` | identity (`types/crowdOs.ts:297`) |
| `coding` | `coding` | identity (`types/crowdOs.ts:298`) |
| `research` | `research` | identity (`types/crowdOs.ts:299`) |
| `swarm` | `swarm` | identity (`types/crowdOs.ts:300`) |

`composerModeToRuntime` / `runtimeToComposerMode` are the only two functions allowed to cross that boundary (`types/crowdOs.ts:312-321`). The comment on the map records that sending the composer name straight to the pin endpoint was a real defect — pinning Chat produced a 400, and because the write is fire-and-forget the UI showed a pin the server had rejected (`types/crowdOs.ts:288-294`).

**Status strip.** `StatusStrip` is presentational and props-only — no store slice, no fetch — so the composer stays the single source for mode and mount (`StatusStrip.tsx:36-49`). It renders one `role="status"` line with a runtime/pin chip, a mount chip that opens the repo panel, a context meter that opens telemetry, a token/cost chip that opens telemetry, an elapsed segment that ticks locally at 1/s only when a start time is supplied, and degraded dots (`StatusStrip.tsx:74-124`). Unknown segments hide and the whole strip returns `null` when nothing is known (`StatusStrip.tsx:73`). Today `MainChatArea` passes `contextPct={null}`, `tokens={null}`, `runCost={null}`, `elapsedMs={null}`, `runStartedAt={null}` — so **only the runtime and mount segments render** (`MainChatArea.tsx:1499-1515`).

## Interaction model

| Trigger | Effect | Source |
|---|---|---|
| Type `@` before the caret | opens the mention listbox, resets the index to 0 | `MainChatArea.tsx:497-501` |
| ArrowUp / ArrowDown with the popover open | cycles the highlighted option | `MainChatArea.tsx:512-517` |
| Enter / Tab with the popover open | inserts the highlighted agent as a chip | `MainChatArea.tsx:518-520` |
| Escape with the popover open | closes the popover, does not send | `MainChatArea.tsx:521-524` |
| Enter with the popover closed | sends | `MainChatArea.tsx:525-528` |
| Shift+Enter | inserts a newline | `MainChatArea.tsx:525` |
| Click a mention row | inserts the chip and refocuses the textarea | `MainChatArea.tsx:1350`, `:546` |
| Click the chip pin button | moves the agent from one-shot to the channel's sticky pins | `MainChatArea.tsx:1397-1411` |
| Send while offline | queues the send and toasts "Will send on reconnect" | `MainChatArea.tsx:554-562` |
| Send projected over 4000 chars | opens the overflow confirm; cancel keeps the draft | `MainChatArea.tsx:568-573` |
| Click Send | clears the composer and the draft, re-pins the stream, refocuses | `MainChatArea.tsx:612-627` |
| Drag a file over the composer | marks the drop target and swaps the placeholder | `MainChatArea.tsx:339-342`, `:1524-1528` |
| Pick a mode | `setMode(mode, channelId)`; re-pins the channel when pinned | `ModeSelector.tsx:140-143`, `crowdOsStore.ts:2017-2037` |
| Toggle the pin | writes `channel_settings.pinned_runtime` for the active channel | `crowdOsStore.ts:2045-2074` |
| Enter a channel | the arriving channel's pin is applied, then reconciled against the server | `crowdOsStore.ts:2899-2902` |
| Change the mode while a run is active | choose "current run" vs "next turn" scope | `MainChatArea.tsx:1542-1556` |
| Click a status-strip segment | opens the source view (repo / telemetry / settings) | `StatusStrip.tsx:82`, `:89`, `:100` |

## Performance notes

- **No rich-text editor.** The input is a native `<textarea>`, so there is no Slate/Slate-like value model, no serialization on keystroke and no editor chunk to load (`MainChatArea.tsx:1516-1530`).
- **Draft writes are debounced at 500 ms**, not per keystroke (`MainChatArea.tsx:258-269`).
- **Mention filtering is an O(agents) substring scan per keystroke** — `agents.filter(ag => ag.name.toLowerCase().includes(mentionFilter))` (`MainChatArea.tsx:506-508`). No fuzzy index, no debounce, no worker.
- **`agents` is read from the store in three separate places** in this surface — the whole-store subscription in `MainChatArea`, plus `MentionParser`'s own `useCrowdOSStore((state) => state.agents)` subscription (`MentionParser.tsx:234`, `:243`).
- **Attachments are base64 data URLs held in memory** with no upload progress and no server persistence; the 5 MB / 10 caps are the only bound (`MainChatArea.tsx:303-332`).
- **The status strip's context, token and cost segments are never populated**, so the strip costs one render of a two-segment line but carries no telemetry load (`MainChatArea.tsx:1499-1515`).

## Evidence

| Claim | Pointer |
|---|---|
| Composer caps and auto-grow | `packages/client/components/workspace/MainChatArea.tsx:128-130`, `:275-280`, `:1516-1530` |
| Send pipeline, overflow guard, mention re-serialisation | `MainChatArea.tsx:549-629`, `:564-573`, `:585-589` |
| Confirm dialogs (clear + overflow) | `MainChatArea.tsx:1008-1037` |
| Composer keyboard routing | `MainChatArea.tsx:510-529` |
| Mention detection and substring filter | `MainChatArea.tsx:483-508` |
| `insertMention` removes the `@token` | `MainChatArea.tsx:531-547` |
| Mention popover listbox markup | `MainChatArea.tsx:1339-1361` |
| Attachments: caps, data URLs, drag-drop | `MainChatArea.tsx:303-332`, `:339-355`, `:1624-1630` |
| Drafts: load on switch, 500 ms save, no attachments | `MainChatArea.tsx:243-269`, `crowdOsStore.ts:4027-4044` |
| Offline outbox | `MainChatArea.tsx:554-562`, `crowdOsStore.ts:4061-4114` |
| Follow-up scope toggle | `MainChatArea.tsx:1542-1557`, `crowdOsStore.ts:4126-4132` |
| Six modes, pin `aria-pressed`, keyboard cycling | `packages/client/components/workspace/ModeSelector.tsx:24-33`, `:58-77`, `:108-119` |
| Per-channel pin, server authority, channel-entry reconcile | `packages/client/stores/crowdOsStore.ts:2017-2037`, `:2045-2074`, `:2081-2111`, `:2902` |
| Composer↔runtime vocabulary | `packages/client/types/crowdOs.ts:254`, `:283-321` |
| Status strip is props-only and hides unknown segments | `packages/client/components/workspace/StatusStrip.tsx:36-49`, `:73`; `MainChatArea.tsx:1499-1515` |
| Preflight helpers | `packages/client/components/workspace/composer-preflight-model.ts:10-70` |
| Emoji picker is a fixed 24-glyph grid | `packages/client/components/workspace/EmojiPickerPopover.tsx:5-9` |
| Canonical CrowdOS docs | `re-docs/Frontend Docs/Feature and Flow Spec/Mention autocomplete.md`; `re-docs/Frontend Docs/Feature and Flow Spec/Send-message flow.md` |

## Gaps

- **No slash-command surface in the composer.** The only verb surface is the command palette (`re-docs/Frontend Docs/Domain Spec/Workspace Shell.md`; `packages/client/components/workspace/modals/palette-verbs.ts:83-98`). There is no `/` trigger in `handleInputChange` (`MainChatArea.tsx:483-504`).
- **The emoji picker has no search and no categories** — a fixed 24-glyph grid with no query field (`EmojiPickerPopover.tsx:5-9`, `:32-45`).
- **Mentions are display-only beyond routing.** The chip row has a pin and a remove action but no hover card and no click-to-profile path, while an agent's name elsewhere is a profile button (`MainChatArea.tsx:1381-1422`; `AgentMessage.tsx:137-142`).
- **No "working on X" indicator.** Nothing renders which agent is currently working on which task inside the composer; the only signal is the agent bubble's own "Working" badge (`AgentMessage.tsx:175-180`).
- **The status strip carries no real numbers.** Context %, tokens, cost and elapsed are all passed as `null`, so the strip shows only runtime and mount (`MainChatArea.tsx:1508-1514`).
- **No Auto resolved-to hint.** `ModeSelector` accepts `autoResolvedTo` but `MainChatArea` never passes it, so the Auto entry shows only its static hint (`ModeSelector.tsx:13`, `:133`; `MainChatArea.tsx:1634-1639`).
- **Attachments are unbounded in memory and never persisted** — data URLs with no upload progress and no server copy (`MainChatArea.tsx:313-331`).
- **Drafts exclude attachments**, so a draft restored after a switch loses every staged file silently (`MainChatArea.tsx:261-266`).
- **Sticky mention pins are in-memory only** — they do not survive a reload and are not synced (`MainChatArea.tsx:236`, `:1399-1406`).
- **Mention filtering is substring-only with no fuzzy match and no ordering by tier or status** (`MainChatArea.tsx:506-508`).
- **The mention popover lacks `aria-activedescendant`**: the textarea keeps DOM focus and the active option is only marked by `aria-selected` on the option (`MainChatArea.tsx:1345-1358`).

## User Decision:

## Target Contract

> Status: Target. The composer is the spend commit (`UX_GUIDELINE.md:36`) and the mention chain is the routing contract (`UX_GUIDELINE.md:17`). The rules below are locked; a Discord-derived pattern may only be adopted where it fills one of the gaps above.

* **Caps stay 4000 characters, 5 MB per file and 10 files per message, and an over-limit send is confirmed, never silently truncated** (`UX_GUIDELINE.md:83`; `MainChatArea.tsx:568-573`).
* **The client must translate composer vocabulary into runtime names before writing to the server** — `chat` → `conversational`, `auto` → `null` (`types/crowdOs.ts:288-315`; `UX_GUIDELINE.md:66`).
* **The runtime pin is per channel and server-authoritative in both directions.** A pin that the server does not hold must not render as pinned (`crowdOsStore.ts:2095-2106`; `UX_GUIDELINE.md:66`).
* **Mention chips are the routing source of truth.** The send must prefix the deduped `@name` list to the body (`MainChatArea.tsx:585-589`; `re-docs/Frontend Docs/Feature and Flow Spec/Mention autocomplete.md:39`).
* **Mention detection is caret-based and keyboard-complete** — Arrow/Enter/Tab/Escape — with a listbox relationship exposed to assistive tech (`MainChatArea.tsx:483-529`, `:1339-1359`; `UX_GUIDELINE.md:86`).
* **Drafts are per channel, debounced, and survive a switch**; attachments stay local and their exclusion must be stated, never silent (`MainChatArea.tsx:243-269`; `UX_GUIDELINE.md:84`).
* **Offline sends queue with will-send copy and auto-send on reconnect.** No silent loss (`MainChatArea.tsx:554-562`; `UX_GUIDELINE.md:84`).
* **The composer never locks during a run.** The applies-to scope chooses the target turn instead (`MainChatArea.tsx:1542-1556`; `UX_GUIDELINE.md:85`).
* **There is exactly one status line above the textarea.** A second preflight row is forbidden; the strip is never modal (`StatusStrip.tsx:36-49`; `UX_GUIDELINE.md:89-90`).
* **Every value the status strip shows traces to a source; unknown segments hide.** Fabricated context %, cost or token counts are forbidden (`UX_GUIDELINE.md:34`, `:89`; `StatusStrip.tsx:73`).

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| Composer input | Slate `contenteditable` editor with a value registry | [Composer](../Discord%20Findings/Composer.md) | CrowdOS uses a native `<textarea rows=1>` with a 4000-char `maxLength` (`MainChatArea.tsx:1516-1530`); Discord uses a rich-text editor plus a 25-type `chatInputType` registry. |
| Composer accessory bar | Attach / Emoji / GIF / Sticker / Apps / Gift / Send | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has attach + emoji + runtime selector + send (`MainChatArea.tsx:1561-1654`); Discord adds GIF, sticker, apps and gift surfaces CrowdOS deliberately excludes. |
| Character cap | 2000 base / 4000 premium, enforced at submit with a modal | [Composer](../Discord%20Findings/Composer.md) | CrowdOS caps at 4000 and confirms the projected-length overflow through a `ConfirmDialog`, never a modal upsell (`MainChatArea.tsx:1027-1037`). |
| Send-time validation | Ordered pipeline with six failure reasons (empty, too long, slowmode, shout, rate limit) | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has three gates: offline, projected overflow, empty (`MainChatArea.tsx:554-575`). There is no slowmode, no rate limit and no shout warning. |
| Slash commands | `COMMANDS` / `LEGACY_COMMANDS` autocomplete with option cycling | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has no slash-command surface in the composer; the palette is the only verb surface (`modals/palette-verbs.ts:83-98`). |
| Mention autocomplete | 12-kind autocomplete engine with virtual focus and `aria-activedescendant` | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has one kind (agent mention), a substring-only filter, and insertion that **removes** the `@token` from the text and adds a chip (`MainChatArea.tsx:483-547`). |
| Emoji picker | Searchable, categorised, lazily loaded 1.2 MB chunk | [Composer](../Discord%20Findings/Composer.md) | CrowdOS ships a fixed 24-glyph grid with no search and no categories (`EmojiPickerPopover.tsx:5-9`). |
| Attachments | Server-driven size perks, 50 ms throttled progress, draft restore on cancel | [Composer](../Discord%20Findings/Composer.md) | CrowdOS reads base64 data URLs into memory with a 5 MB / 10 cap, no progress and no server persistence (`MainChatArea.tsx:303-332`). |
| Drafts | Persisted store keyed by user→channel→draft type, 500 ms throttle | [Composer](../Discord%20Findings/Composer.md) | CrowdOS is per channel with a 500 ms debounce and a single draft type; attachments are excluded (`MainChatArea.tsx:243-269`). |
| Typing indicator | `POST /channels/{id}/typing` plus a `TYPING_START` inbound store | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has no typing emission and no typing row. |
| Slowmode / rate limit | `SLOWMODE_COOLDOWN` / `RATE_LIMITED` failure reasons with modals | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has no throttle concept at all; the only blocked-send path is the overflow confirm (`MainChatArea.tsx:568-573`). |
| Runtime / mode selection | Composer type registry (surface kinds, not runtimes) | [Composer](../Discord%20Findings/Composer.md) | CrowdOS has a 6-mode runtime selector with a per-channel, server-persisted pin (`ModeSelector.tsx:24-33`, `crowdOsStore.ts:2045-2074`); Discord has no runtime concept. |
| Verb surface | Slash commands + context menu + hover toolbar | [Interaction Vocabulary](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS centralises verbs in the palette registry, each carrying shortcut, scope and risk (`modals/palette-verbs.ts:7-15`, `:83-98`). |
| Command palette / verb registry | Command palette with fuzzy search | [Keyboard and Accessibility](../Discord%20Findings/Keyboard%20and%20Accessibility.md) | CrowdOS's palette must reach verbs, not only search (`UX_GUIDELINE.md:33`, `:107`); Discord's palette is search-first (`Shell and Navigation` finding that `"Search, members, media, pins, threads, and more"` describes the palette). |

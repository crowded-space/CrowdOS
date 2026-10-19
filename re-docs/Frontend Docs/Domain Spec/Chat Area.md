# Chat Area

## Purpose

Channel message stream plus the send composer: history rendering per message type, live streaming/cancellation states, approvals and diff surfaces inline, mentions, attachments, mute, clear, paging, and mode-aware dispatch.

## Feature Scope

In-scope: channel header toolbar, virtualized-feel auto-scroll with missed-count badge, message router + all `messages/*.tsx` renderers, tool-call folding into agent bubbles, mention autocomplete + sticky/pinned mentions, attachment menu/upload/drag-drop, emoji insert, `ModeSelector` wiring, per-channel mute, clear-logs confirm, sandbox code popup, reconnect digest, empty-channel onboarding chips.
Non-goals: shell layout (see Workspace Shell), file explorer tree and folder mounts (see Filesystem Explorer), settings/search/profile/channel modals (see Modals), portal onboarding (see Portal), store/socket internals beyond what chat touches.

## Expect

- `[Observed]` Header shows `#name` + description, an `xl:hidden` workspace-menu trigger, search (Ctrl/⌘K), clear-logs (only when messages exist), Stop while swarm active or streams exist, mute bell (desktop), and roster/sandbox segmented toggle (`xl+`).
- `[Observed]` Header shows `#name` + description, an `xl:hidden` workspace-menu trigger, search (Ctrl/⌘K), clear-logs (only when messages exist), Stop while swarm active or streams exist, mute bell (desktop), and roster/sandbox segmented toggle (`xl+`). Channel buttons switch the active channel with distinct values (`ChannelButton.tsx` + `WorkspaceSidebar.tsx:40-46`); category collapse toggles per category; settings/search/database/theme controls open their real surfaces (`WorkspaceSidebar.tsx`, `WorkspaceDropdown.tsx`, `ThemeToggle.tsx`).
- `[Observed]` Mute, attach, emoji, and mode/pin controls have real behavior: mute persists per channel, the attach menu stages files (5 MB / 10 per message), the emoji grid inserts the chosen glyph, and the mode selector + pin drive dispatch (`MainChatArea.tsx:189-238,498-515,1165-1255`).
- `[Observed]` Stream auto-follows new messages; scrolled-up users get a "Jump to present" pill with missed count instead of yank.
- `[Observed]` Older history loads when scrolling near the top with viewport anchoring (no jump).
- `[Observed]` Agent bubbles order monologue → final message → collapsible tool calls; running tools auto-expand the container.
- `[Observed]` Human bubbles are amber-accented and editable (edit → resend); the `Human` label uses `text-amber-200` (`#92400e` in the light theme) so 10px normal text meets WCAG AA on the rendered tan surface. Agent bubbles expose hover regenerate and retry on failed/cancelled turns.
- `[Observed]` Pending approval cards render above messages in the active channel.
  - `[Observed]` Pending approval cards render above messages in the active channel.
  - `[Observed]` `StatusStrip` (presentational, props-only) is the single composer status line, rendering directly above the textarea: runtime/pin chip, mount chip (short path + source badge + why-tooltip, click opens the repo panel), context meter (click opens telemetry), tiered micro cost (click opens telemetry), elapsed (ticks locally at 1/s only with a start time), and degraded dots (click opens settings/telemetry). Unknown segments hide (honest empty); the strip returns null when nothing is known; it is never modal. No store `stripSnapshot` slice exists on purpose — `MainChatArea` already owns `mountScope`/mode and passes real values (or null) as props (`StatusStrip.tsx`, `MainChatArea.tsx`). It absorbed the former Phase B `ComposerPreflight` row, which rendered the same runtime + mount chips a second time; the over-limit guard is unchanged and still lives in `handleSend`.
  - `[Observed]` The jobs branch hosts `OperationsInbox` above `JobsView`: approvals carry inline Approve (via `decideApproval`) / Jump (via `setActiveChannel`) / Later (via `deferLater`, local-only) actions, failures carry Retry (via `retryRun`) / Jump, mentions carry Jump. Approval rows use an amber badge with icon+text (`ShieldAlert` + `approval`); mention rows use a rose badge with icon+text (`AtSign` + `mention`) — never color-only. Deep-links are channel-only jumps; run/inbox targets arrive via `deep-link.ts`, never invented ids.
- `[Observed]` Latest run's diff artifacts render inline above messages, with a `CheckpointRow` above the diff gated to Coding/Swarm runs: the gate reads `runRuntimeByRun[latestRunId]` (server `runtimeType` recorded at `run.status_changed` receipt — message metadata carries only the runId), shows the row for `coding`/`swarm`, and hides when the runtime is unknown instead of guessing (`MainChatArea.tsx`). The composer status line is untouched.
- `[Observed]` Bottom drawer file/log tabs live below the center chat: the file tab shows the pinned file when kept else the live preview (`preview-vs-pinned` toggle, per-workspace persistence); the log tab is a read-only channel log (last 100 messages, no actions). The drawer never moves the dock panel — drafts still survive min/dock/full switches (see Workspace Shell slot).
- `[Observed]` Clear-history confirm carries a retention notice: cleared history is not retained (neither local mirror nor server log) and cannot be undone (`MainChatArea.tsx`).
- `[Observed]` `@` typing opens an agent mention list navigable by Arrow/Tab/Enter/Escape; chosen mentions become chips that can be pinned per channel.
 `[Observed]` `@` typing opens an agent mention list navigable by Arrow/Tab/Enter/Escape; chosen mentions become chips that can be pinned per channel. The single `StatusStrip` line above the textarea carries the runtime chip, the mount chip with source badge + why-tooltip (click opens the repo panel), and the context/cost/elapsed/degraded segments (each hidden while no real source exists); the over-limit guard on the projected send length (draft + mention prefix) is enforced by `handleSend` via the existing `ConfirmDialog` (`StatusStrip.tsx`, `composer-preflight-model.ts`).
- `[Observed]` Composer blocks empty sends, caps text at 4000 chars and attachments at 5 MB / 10 per message.
- `[Observed]` Enter sends and Shift+Enter inserts a newline; the Send button is always available.
- `[Observed]` Attach menu offers file upload only (photos/files via native picker, drag-drop, 5 MB / 10 per message). There is no recent-files entry; mock demo recents were removed.
- `[Observed]` Sandbox editor opens docked; the chevron toggles only min ⇄ dock (half) — it never expands to full — on an explicit px-height tween, a maximize button jumps the extremes (min/dock ⇄ full) without passing through the half sheet (from full the chevron collapses back through dock), and X collapses the panel out via `AnimatePresence`. Files and fenced code blocks render with syntax coloring (highlight.js).
- `[Observed]` Chat prose is normalized only at render time: whitespace-delimited em dashes become ASCII punctuation in non-code display nodes, while stored message content and unrelated historical reasoning remain unchanged.
- `[Observed]` 2026-10-04 Phase E secret redaction (display-only): secret-pattern spans render through `messages/RedactedText.tsx` (shown-as-redacted + per-span click-reveal via `messages/secret-redaction.ts` `splitSecrets`/`countSecrets`) with raw values never logged. Wired in `MentionParser.tsx` code blocks + plain-text segments (`MentionParser.tsx:58-63,79-81,118-120,381,449,476`), `ToolExecutionMessage.tsx` input/output pres (`ToolExecutionMessage.tsx:136,160`), and the `ThreadDrawer` run branch parent prompt/steps/tool output (`ThreadDrawer.tsx:253,268,275,287`).
- `[Observed]` 2026-10-04 date dividers wired, unread deliberately omitted: `DateDivider` (`role=separator`, Today/Yesterday/localized date via `formatDayDivider`) inserts on honest day change from real `message.timestamp` (`MainChatArea.tsx:53,782,789`); orphan tool rows (fabricated client timestamp) never open a divider. `UnreadDivider` exists but is intentionally not rendered — the store keeps no honest unread anchor (`setActiveChannel` zeroes `unreadCount` with no last-read message id; `crowdOsStore.ts:2802-2822`), so rendering it would fabricate a marker (`MainChatArea.tsx:66-71` note).
- `[Observed]` 2026-10-04 empty-hero capture cards: 4 one-click deep-links to existing actions only (no new endpoints, no mock data) — Ask L0 drafts `@<l0>` in the composer (disabled with honest empty when no L0 agent), Run research switches the composer to research mode, Review diff / Mount folder open the repo panel (`MainChatArea.tsx:645-658` handlers, `MainChatArea.tsx:1135+` render, `role=group` "Suggested next actions").
- `[Observed]` 2026-10-05 Phase G quick-ask capture: floating `QuickAsk.tsx` panel defaults to the current channel scope + L0 agent when present (honest empty when no L0, never faked). The scope line names where the answer lands (`#channel` + runtime) plus what it can touch (draft-snapshot mount short path with source label/why-tooltip, honest dash when unknown). Enter asks in place through the same `addMessage`/`queueSend` transport as the main composer (offline reuses `queueSend` with will-send copy); Shift+Enter expands to the full window (best-effort `setDraft` backup + focus the channel composer). 4000-char honest truncation; global summon Ctrl/Cmd+Shift+K (palette keeps Ctrl/Cmd+K); static panel with 150ms fade only, reduced-motion static, focus trap via `use-overlay-focus`, Escape closes. Empty-hero 4-cards in `MainChatArea` are untouched — QuickAsk reuses their handlers, never duplicates them.
- `[Observed]` 2026-10-04 Phase E composer persistence: per-channel draft restore on channel switch + 500 ms debounced `setDraft` persist (text + mentionIds + runtime + display-only mount snapshot; attachments stay local, never mirrored) (`MainChatArea.tsx:239-271`); offline queue via `queueSend` with will-send copy when `navigator.onLine === false` (`MainChatArea.tsx:562-576`); follow-up scope toggle (`appliesTo` current/next, default next) visible only while a run is active (`MainChatArea.tsx:1551-1553`). Store is source; mirrors are `crowdos_drafts`/`crowdos_outbox` (see Stores).

## Flow

1. Resolve channel: `MainChatArea.tsx:276-289` finds active channel across top-level + categorized lists; messages filtered per channel `MainChatArea.tsx:291-295`.
2. Page history: `MainChatArea.tsx:307-319` `maybeLoadOlder` fires under 160px scroll-top via `loadOlderMessages()` with height anchoring; loader line `MainChatArea.tsx:789-793`.
3. Follow stream: `useStickToBottom` owns the scroll container — wheel/touch intent (never the `scroll` event, which also fires for programmatic pins) decides follow mode; new rows and token updates share one instant container pin while following, missed count accrues while scrolled up, and the `jump-latest` pill resumes with a smooth scroll; prepended pages never jump. Streaming bubbles memoize completed markdown blocks (`StreamingMention`/`splitStreamBlocks`) with a blinking caret end-indicator.
4. Fold tools: `MainChatArea.tsx:526-602` attaches `tool_execution` messages forward to the last same-author agent bubble or queues them for the next one; orphans render standalone.
5. Group chat bursts: `MainChatArea.tsx:604-656` merges same-author messages within 5 min (excluding system/delegation/tool/governance/attachments/streaming) into compact rows.
6. Mention: `MainChatArea.tsx:371-436` detects trailing `@word` at caret, filters agents, `insertMention` converts to chip; send prefixes `@names` (`MainChatArea.tsx:451-455`).
7. Send: `MainChatArea.tsx:438-486` builds content + mentions + attachments, reads live mode from store (`MainChatArea.tsx:463-464`), calls `addMessage` with the local-only operator profile (`workspace/operator-profile-model.ts`: name default `Local operator`, tag default `Human`, preference default null). The store `addMessage` emit carries channelId/content/mentions/mode plus advisory `authorName`/`authorTag`/`userPreference` (server derives `authorId` from the socket identity and treats the three as display-only). `QuickAsk.tsx` uses the same sourced identity; offline `flushOutbox` attaches the current profile at flush time.
8. Stop: header Stop `MainChatArea.tsx:703-714` or per-bubble STOP `AgentMessage.tsx:153-164` call `cancelRun(channelId[, agentId])`; `cancellingByAgent` disables to "Stopping...". The pinned `RunHeader` renders Stop only for live stoppable run states (`run-stoppability.ts`); parked resumable/orphaned runs have no controller behind the socket transport, so the header Stop does not render for them and they resume from Jobs via Retry (POST /api/runs/:id/resume).
9. Approve: `ApprovalCard.tsx:84-109` Grant / Deny / Grant-for-session call `decideApproval`; decided cards show terminal status `ApprovalCard.tsx:69-74`.
10. Edit human message: `HumanMessage.tsx:23-27` `editResend(id, draft)`; hover pencil `HumanMessage.tsx:72-82`.
11. Regenerate/retry agent turn: hover actions `AgentMessage.tsx:286-310`, inline Retry `AgentMessage.tsx:271-283` via `regenerate(id)` / `retryRun(runId)`.
12. Sandbox popup: file click sets `selectedSandboxFile` (from Filesystem Explorer); editor `SandboxCodeViewer.tsx` loads/saves via REST and highlights through `code-highlight.ts`; panel `MainChatArea.tsx:889-971` animates min/dock/full + exit (full = measured root minus siblings incl. margins; the stream tweens its padding to 0 alongside the panel so the column never overflows and the composer stays fully visible); the chevron toggles min ⇄ dock only (full is maximize-only; from full it collapses back to dock), maximize jumps min ⇄ full.
13. Mute/clear: `MainChatArea.tsx:495-515` toggles per-channel mute persisted to localStorage; clear arms a `ConfirmDialog` with a retention notice → `clearChannelMessages` (`MainChatArea.tsx`).
14. Checkpoint injection: the latest-run block reads the runId from message metadata, resolves the server runtime via `runRuntimeByRun`, renders `CheckpointRow` above `DiffViewer` for Coding/Swarm only, and leaves the composer status line alone (`MainChatArea.tsx`).

## Current Implementation

| Component | Role |
|---|---|
| `workspace/MainChatArea.tsx` | Header, stream, mention popup, composer, sandbox panel chrome (min/dock/full shell), approval + diff injection, scroll/paging/mute/clear orchestration |
| `workspace/SandboxCodeViewer.tsx` | Sandbox file editor body: REST load/save via `apiClient`, dirty/revert/save footer, highlight.js mirror behind the textarea |
| `workspace/CheckpointRow.tsx` (`CheckpointRow`, default export) | Checkpoint row above the inline diff: snapshot/files/count + Restore with file-list scope preview + audit render-back (owned by Filesystem Explorer, hosted here) |
| `workspace/messages/MessageRouter.tsx` | Router: human/agent/system/delegation/tool_execution/governance (+ strike, parliament, alert variants); failed/cancelled turns surface in the agent bubble with regenerate/retry (no separate provider card - deleted 2026-10-05 as unwired dead code); memoized |
| `workspace/messages/AgentMessage.tsx` | Agent bubble: level avatar, monologue collapse, streaming/cancelled/failed states, grouped tool container, regenerate/retry |
| `workspace/messages/HumanMessage.tsx` | Amber human bubble with inline edit-and-resend |
| `workspace/messages/SystemMessage.tsx` | Centered mono system line |
| `workspace/messages/ToolExecutionMessage.tsx` | Tool call card: category pill, duration/status, expandable input/output with copy; `inline` variant for grouped container |
| `workspace/messages/DelegationMessage.tsx` | Delegation dispatch card: from→to agents, task, tokens/cost, status; cost links to the telemetry view (`setRightPanelView('telemetry')`) when a real cost exists, honest dash otherwise; run costs in `RunCard.tsx`/`RunHeader.tsx` follow the same contract. The pinned `RunHeader`'s Stop renders only for live stoppable states (`run-stoppability.ts`); parked runs use Retry from Jobs |
| `workspace/messages/MentionParser.tsx` | Markdown-lite renderer: syntax-highlighted code blocks with copy + 20-line collapse, tables/lists/headers, `@mention` chips, strips tool-call leakage; `StreamingMention` memoizes completed blocks with a pending tail, `streaming-blocks.ts` holds the fence-aware splitter |
| `workspace/messages/use-stick-to-bottom.ts` | Follow-scroll hook: owns the scroll container ref + intent flag, instant pin while following, smooth resume on explicit jump |
| `workspace/messages/ApprovalCard.tsx` | Risk-badged approval with args preview and Grant/Deny/Grant-for-session |
| `workspace/messages/AttachmentsView.tsx` | Image/file cards with preview lightbox + download links |

## Props & Store

- `MainChatArea { onOpenSearch?; onOpenSidebar? }` — everything else from store: `workspaces, activeWorkspaceId/ChannelId, messages, agents, addMessage, clearChannelMessages, rightPanelView, setRightPanelView, selectedSandboxFile, setSelectedSandboxFile, openAgentProfileModal, selectedMode, isPinned, setMode, togglePin, reconnectDigest, clearReconnectDigest, cancelRun, cancellingByAgent, approvalRequests, artifactsByRun, runRuntimeByRun`, plus `channelCursors/isLoadingOlder/loadOlderMessages`. Ports equal exports: the checkpoint gate reads `runRuntimeByRun`, never message metadata, for the runtime.
  - `MainChatArea { onOpenSearch?; onOpenSidebar? }` — everything else from store: `workspaces, activeWorkspaceId/ChannelId, messages, agents, addMessage, clearChannelMessages, rightPanelView, setRightPanelView, selectedSandboxFile, setSelectedSandboxFile, openAgentProfileModal, selectedMode, isPinned, setMode, togglePin, reconnectDigest, clearReconnectDigest, cancelRun, cancellingByAgent, approvalRequests, artifactsByRun, runRuntimeByRun`, plus `channelCursors/isLoadingOlder/loadOlderMessages`. Ports equal exports: the checkpoint gate reads `runRuntimeByRun`, never message metadata, for the runtime; `StatusStrip { runtime; pinned; mount; contextPct; onContextOpen; tokens; runCost; onCostOpen; elapsedMs; runStartedAt; degradedDots; onDegradedOpen }` is props-only (mount strings precomputed via `composer-preflight-model`/`explorer-model`); `OperationsInbox` reads approvals/failures/mentions via the derived `inboxItems` projector plus `decideApproval`/`retryRun`/`setActiveChannel`/`deferLater`/`undeferInbox`.
- `MessageRouter { message; agentLevel?; toolExecutions? }`; `AgentMessage { id?, authorId, authorName, authorAvatar?, content, timestamp, metadata?, level?, attachments?, turnSteps?, turnStatus?, toolExecutions? }`; `HumanMessage { id?, authorName, content, timestamp, attachments?, mentions? }`; `SystemMessage { content, timestamp }`; `ToolExecutionMessage { toolExecution?, timestamp, inline? }`; `DelegationMessage { delegationInfo?, timestamp }`; `MentionParser { text }` (reads `agents` for mention names); `ApprovalCard { approval }`; `AttachmentsView { attachments? }`.
- Local: `inputText, isSending, mention UI state, attachments[], selectedMentions[], stickyMentionsByChannel{}, mutedChannels{} (localStorage), sandbox view min/dock/full + docked/full heights, emoji/attachment popovers, confirm-clear, scroll/missed refs`.
 - Local: `inputText, isSending, mention UI state, attachments[], selectedMentions[], stickyMentionsByChannel{}, mutedChannels{} (localStorage), sandbox view min/dock/full + docked/full heights, emoji/attachment popovers, confirm-clear, confirm-overflow + mountScope{path,source}, scroll/missed refs`. The composer's single status line is `StatusStrip` (props-only; mount strings precomputed via `composer-preflight-model`/`explorer-model`); `composer-preflight-model.ts` exports `COMPOSER_WARN_AT, shortPath, overflowState, projectedSendLength, contextTooltipText, writeScopeLabel, costHintText` (the overflow helpers feed `handleSend`'s guard, not a rendered row); `crowdOs.ts` adds `contextBreakdown, writeScope, preflightOverflow` + per-mode `latency/cost/scope` strings on `COMPOSER_MODE_META`.

## Relations

- Parent: `App.tsx` center panel inside `ErrorBoundary`; header drives `setRightPanelView` (Workspace Shell), `onOpenSearch` (Modals), and the responsive drawer via `onOpenSidebar` (Workspace Shell).
- Children: `MessageRouter` → per-type bubbles; bubbles → `MentionParser`, `AttachmentsView`, `ToolExecutionMessage`; composer → `ModeSelector`, `EmojiPickerPopover` (Workspace Shell), `ConfirmDialog` (Modals), lazy `DiffViewer` + lazy `CheckpointRow` (Filesystem Explorer, checkpoint above diff); drawer file/log tabs below the chat (Workspace Shell slot), sandbox panel → `SandboxCodeViewer` (own file, mounted once per open file so drafts survive min/dock/full switches). Panel-vs-drawer relation: the dock panel is the single editor mount; the drawer file tab is a second read/preview surface that hands paths back via `setSelectedSandboxFile`.
 - Children: `MessageRouter` → per-type bubbles; bubbles → `MentionParser`, `AttachmentsView`, `ToolExecutionMessage`; composer → `StatusStrip` (presentational; `role=status`, mount chip opens the repo panel via `setRightPanelView('repo')`), `ModeSelector`, `EmojiPickerPopover` (Workspace Shell), `ConfirmDialog` (Modals), lazy `DiffViewer` (Filesystem Explorer); sandbox panel → `SandboxCodeViewer` (own file, mounted once per open file so drafts survive min/dock/full switches).
- Store: message send/edit/regenerate/retry/cancel, paging cursors, approvals, artifacts, reconnect digest, mode/pin.
- REST: sandbox file content `GET/POST /api/workspace/files/content`; ledger-independent here; search is Modals scope.

## Emits-Listens

- Components call store actions; store emits `user:message` (send `stores/crowdOsStore.ts:2532`, edit-resend `:3437`, regenerate `:3462`) and `user:cancel` (`stores/crowdOsStore.ts:1556`).
- Stream state arrives via store socket handlers: `message:new`, `message:stream`, `tool:start/complete`, `agent:status/thinking`, `delegation:start/completed`, `approval.requested/decided`, `artifact.created/updated`, `diff.created`, `run.status_changed`, `escalation:created`, `strike:initiated` (`stores/crowdOsStore.ts:793-1477`).
- Approvals decided over REST `POST /api/approvals/:id/decision` via store; retry over `POST /api/runs/:id/resume`.

## Owns

- Composer drafts (2026-10-04 Phase E: per-channel `draftByChannel` via `setDraft`/`clearDraft`, `crowdos_drafts` debounced write-through mirror, restore on channel switch `MainChatArea.tsx:239-271`), staged attachments (data URLs in memory, never mirrored — quota hazard by design), mention chips + per-channel sticky pins, mute map (`crowdos_muted_channels` + legacy `crowdos_mute_*`), scroll position + missed counter, sandbox editor dirty buffer, tool/monologue/code collapse toggles (per-mount). Offline queue rows (`outbox`/`crowdos_outbox`) and follow-up scope (`appliesTo` in-memory, default next) live in Stores; composer wiring is `queueSend` on offline send + `appliesTo` toggle while a run is active.
- Cross-channel persistence: per-channel drafts + sticky mentions + mute map (attachments stay local; `appliesTo` is per-channel in-memory).

## Flags

- Constants: `MAX_MESSAGE_LEN 4000`, `MAX_ATTACHMENT_SIZE 5MB`, `COMPOSER_MAX_HEIGHT 160px`, paging threshold 160px / follow threshold 80px (`STREAM_NEAR_BOTTOM_PX`), group window 5 min, `BACKEND_URL = ''`.
- Responsive: below `xl` the chat uses the full viewport with a drawer trigger; mute and segmented controls stay desktop-only; author-name and reasoning controls maintain at least 24px hit areas without changing card height; composer padding/text scales at `sm:`; diff/code blocks scroll horizontally.
- `[Observed]` Empty state is flat (no glow layer), 20px balanced headline, 38ch pretty copy, squircle dispatch chips + square `tnum` level chips; mention header is sentence-case; shadows are tinted. Elevation is reserved: composer lifts on focus, send button carries the single accent shadow; agent bubbles carry state on border only.

## Decisions

- `[Observed]` Tool executions fold into the parent agent bubble (forward- or backward-attached) instead of interleaving as separate rows.
- `[Observed]` Send reads mode from the store at send-time to avoid stale closures after mode switches.
- `[Observed]` Streaming follows with one instant container pin for both new rows and token updates while the user is near the bottom (80px); wheel/touch intent — never the `scroll` event — cancels follow, and only the explicit jump-to-latest pill scrolls smoothly.
- `[Observed]` Prepended history pages never trigger jump-to-bottom or missed badges.
- `[Observed]` Mock "recent files" demo scaffolding was removed from the attach menu; no demo files ship in production paths.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Bubble taxonomy plus tool folding plus stream pinning stay; identity, attachments, governance actions, and editor safety are the gaps.
Tool executions stay folded into the parent agent bubble. Interleaved tool rows are forbidden.
Send MUST use server-resolved identity. Hardcoded user-01 and Juan Hamzah sender identity is forbidden in production paths.
Attachments MUST NOT live as unbounded in-memory data URLs. Large or many files need upload progress plus server persistence plus memory bounds. Silent memory growth is forbidden.
Governance cards are either display-only by explicit contract or carry vote and appeal actions. Action-looking cards with no actions are forbidden.
Sticky mentions plus mute maps MUST have an explicit scope contract: local-only with documented no-sync, or synced via settings. Silent scope ambiguity is forbidden.
Sandbox editor MUST have conflict handling plus a dirty-guard on channel switch. Silent overwrite on switch is forbidden.
Syntax highlighting is REQUIRED for the sandbox editor and fenced code blocks via `workspace/code-highlight.ts` (highlight.js common bundle); rendering code uncolored without a documented size/language fallback is forbidden.
Grouping heuristic MUST use stable ids across re-renders. Date-now and random orphan-tool fallback ids are forbidden.
Mock recent files MUST be removed or labeled demo behind a flag. Demo data in production paths is forbidden.
## Failure + Resume

- Empty channel: onboarding hero with quick-dispatch `@agent` chips + swarm-active pill (2026-10-04: capture cards added — Ask L0 / Run research / Review diff / Mount folder one-click deep-links to existing actions only, handlers `MainChatArea.tsx:645-658`, render `MainChatArea.tsx:1135+`; channel-switch reset of the run-thread drawer `setOpenRunThreadId(null)` at `MainChatArea.tsx:838-840`).
- File load failure: inline "Could not open this file" panel with path + error; save failures show inline in the editor footer (console-free).
- Oversize/over-count/long messages: toast errors + truncation, send disabled while `isSending`.
 - Oversize/over-count/long messages: toast errors + truncation, send disabled while `isSending`. Typing past the cap is impossible (`maxLength`); the over-limit path is the projected send length (draft + mention prefix): `handleSend` opens the overflow `ConfirmDialog` once (Send truncated / keep draft), and Send stays clickable so the guard is reachable.
- Failed/cancelled turns: inline Retry + hover retry; streaming + cancelled states visually distinct.
- Reconnect: digest banner with a named Dismiss control (`MainChatArea.tsx:789-799`); every digest change also fires a `Connection update` toast so the event survives dismissal (`MainChatArea.tsx:149-152`); Retry lives on the `OfflineBanner` degraded strip (`OfflineBanner.tsx`), and older-page loads anchor viewport.
- No chat-level error boundary of its own; relies on `App.tsx` panel boundary.

## Gaps

- Sender identity is local-only (`local-operator` + profile name from `workspace/operator-profile-model.ts`, default `Local operator`); no live session/me endpoint exists in scope, so there is still no server-resolved auth attribution and store `addMessage` ignores author fields (channelId/content/mentions/mode only).
- Attachment data URLs live in memory — large/many files risk memory growth; no upload progress or server persistence observed.
- Governance renderers (strike/parliament/alert) have no actions (no vote buttons, no appeal) — display-only.
- Sticky mentions and mute maps have no cross-device sync or settings UI.
- Sandbox editor still lacks conflict handling and a dirty-guard on channel switch (highlighting added 2026-09-27; drafts survive view switches but not channel switches).
- Grouping heuristic (5-min window, attachment/streaming exclusions) may split tool-heavy threads; orphan-tool fallback IDs use `Date.now()/random`, unstable across re-renders.
 - Grouping heuristic (5-min window, attachment/streaming exclusions) may split tool-heavy threads; orphan-tool fallback IDs use `Date.now()/random`, unstable across re-renders.
 - Status honesty gaps (no mocks): no real source yet for context % + breakdown, write-scope, cost hint, or Auto resolved-to — all render honest empty (segments hidden, `resolvedTo={null}`, `contextPct/scope/costHint={null}`). Mount chip reads the live effective root (`getWorkspaceRoot`, failures hide the chip).

# Message rendering

> Type: Feature · Status: aligned · Updated: 2026-10-04

## Intent

Render the channel stream as scannable cards: one visual language per message type, live agent turns that stay readable while streaming, and attachments users can preview without leaving the flow.

## Architectural decision

- [Observed] One router fans out to per-type bubbles; each type owns its card styling; failed/cancelled turns surface in the agent bubble with regenerate/retry (the separate provider error card was deleted 2026-10-05 as unwired dead code) (`MessageRouter.tsx:17-73`).
- [Observed] Tool calls fold into the parent agent bubble instead of interleaving as rows (`MainChatArea.tsx:526-602`, `AgentMessage.tsx:49-77`).
- [Observed] Agent reasoning (monologue) renders as a collapsible block above the final message; running tools auto-expand the container (`AgentMessage.tsx:63-77`).
- [Observed] Author-name and reasoning toggle buttons keep at least 24px hit areas while negative vertical margins preserve the surrounding message-card rhythm.
- [Inferred] Readability wins over raw log fidelity: tool-call leakage is stripped before render (`MentionParser.tsx:138` via `stripToolCalls`).

## How it works

Router switches on `message.type`: human, agent, system, delegation, tool_execution, governance (`MessageRouter.tsx:18-73`). Governance splits further by `metadata.subtype` into strike, parliament (vote bars + ballots), and generic alert (`MessageRouter.tsx:73-223`). Agent bubbles stack monologue collapse → final markdown → grouped tool container, with streaming (`stream-` id prefix) and cancelled/failed states styled distinctly (`AgentMessage.tsx:38-47,87-94`). Burst grouping merges same-author messages within 5 min, excluding system/delegation/tool/governance/attachment/streaming rows (`MainChatArea.tsx:604-656`). Body markdown is markdown-lite in `MentionParser`: fenced code blocks with syntax highlighting (highlight.js via `workspace/code-highlight.ts`), copy + 20-line collapse, tables, lists, headers, inline code/bold/italic/strike, and `@mention` chips (`MentionParser.tsx:43-137,192-344`). 2026-10-04 Phase E: secret-pattern spans render display-only through `RedactedText` (shown-as-redacted + per-span click-reveal; code-block badge shows `{secretCount} redacted`, `MentionParser.tsx:58-63,79-81,118-120,381,449,476`), tool input/output pres render through `RedactedText` (`ToolExecutionMessage.tsx:136,160`), and date dividers (`DateDivider`, Today/Yesterday/localized) insert on honest day change from real `message.timestamp` (`MainChatArea.tsx:53,782,789`) — orphan tool rows never open a divider and the unread divider stays deliberately unrendered (no honest anchor). While streaming, `StreamingMention` splits the text via `splitStreamBlocks` (`streaming-blocks.ts`) into memoized `CompletedStreamBlock` nodes plus one pending tail; an unclosed fence renders as a plain `pre` until the closing fence arrives, and the bubble ends with a layout-neutral blinking caret (`AgentMessage.tsx`). Attachments render below body text: image cards (aspect-video, hover preview/download, lightbox overlay) and generic file cards (icon, name, size, download) (`AttachmentsView.tsx:34-151`).

## Components involved

| Area doc | Role |
|---|---|
| <../Domain Spec/Chat Area.md> | Owns the stream, router, all `messages/*.tsx` renderers, folding/grouping, and attachment surfaces; this spec narrates only the rendering layer |

## Current state

Card taxonomy (human amber-accented editable, agent level-badged, centered mono system line, tool card with category pill + expandable I/O, delegation dispatch card, strike/parliament/alert governance cards, approval cards above messages) matches the area doc. Stream folding, 5-min monologue merge display, code-block collapse, and image lightbox all observed in code as described above.

## Alignment notes

- 2026-09-27 visual polish: message-layer status chips (Working/Cancelled/Turn failed/Stop), tool-run summary chips (Running/failed/done), approval status + arguments header, delegation header, safety-strike and governance banners, and code-collapse control all moved to sentence-case with square badges; per-tool colored pills made shape-consistent (`rounded`). Rendering flow and event wiring unchanged.
- 2026-09-30 presentation copy: `MentionParser` replaces whitespace-delimited em dashes with ASCII punctuation in non-code prose before rendering. This is display-only normalization; stored message content is not rewritten, and code blocks keep their literal text.
- 2026-09-27 syntax highlighting: fenced code blocks and the chat-area sandbox editor highlight through `workspace/code-highlight.ts` (highlight.js `lib/common`); unknown languages and inputs over 100k chars fall back to escaped plain text. Gutter and code share inherited line-height (single `<pre>`), so rows stay aligned.

## Alignment notes

- 2026-10-08 system author mapping: server rows with `authorType` 'system' now arrive in the store as type 'system' on both the socket path (`crowdOsStore` `message:new` handler) and the history path (`mapBackendMessage`), so `MessageRouter` renders them through the centered `SystemMessage` line instead of an agent bubble. Fixed a collapse where the read shape and both client mappings forced 'system' to 'agent'.
- 2026-09-30 hit targets: `testAgent`/`Ascend`/`System Warning` author buttons and Show/Hide reasoning measure at least 24px high; compensated margins keep message-card spacing unchanged.
- 2026-10-04 Phase E redaction + dividers: `RedactedText` shown-as-redacted + click-reveal in `MentionParser`/`ToolExecutionMessage`/`ThreadDrawer` run branch; `DateDivider` on honest day change; `UnreadDivider` deliberately unrendered (store keeps no last-read anchor — honest pending marker, never fabricated).
- 2026-10-04 ledger links: delegation cost (`DelegationMessage.tsx`) and run costs (`RunCard.tsx`, `RunHeader.tsx`) link to the existing telemetry view via `setRightPanelView('telemetry')` as icon+text buttons; with no real cost the UI renders an honest dash, never a fabricated link. No new endpoints; run sources stay `jobsByRun`/`artifactsByRun` from `run.status_changed`.
- 2026-10-10 streaming UX: completed markdown blocks are memoized (`CompletedStreamBlock`, keys index+length so the list only grows at the end) and only the pending tail re-renders per flush; the splitter is fence-aware so blank lines inside a closed code block never split it apart (`splitStreamBlocks`).

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* One router fans out to per-type bubbles with one visual language per type. Tool calls fold into the parent agent bubble, never interleaved rows.
* Monologue renders collapsible above the final message with running tools auto-expanding. Readability over raw log fidelity stays with tool-call leakage stripped.
* Grouping uses stable ids across re-renders. Date-now and random orphan-tool fallback ids are forbidden.
* Code blocks have an explicit contract: plain text with line numbers or syntax highlighting. Silent missing highlighting is forbidden.
* Governance cards are display-only by explicit contract or carry vote and appeal actions.
* Attachment staging caps live in the composer with bounded memory, upload progress, and server persistence. Unbounded in-memory data-URL growth is forbidden. Authority: Chat Area area doc.
* Message identity and reasoning controls maintain at least 24×24 hit areas without changing card height. Sub-24px interactive controls are forbidden.
## Open gaps

- Grouping edge cases unverified: tool-heavy threads may split; orphan-tool fallback IDs use `Date.now()/random` (area doc notes instability across re-renders).
- Code blocks are syntax-highlighted (highlight.js via `code-highlight.ts`) with line numbers; unknown languages / >100k-char inputs fall back to escaped plain text.
- Governance cards are display-only: no vote/appeal actions observed.
- Attachment staging caps (4000 chars, 5 MB / 10 per message) live in the composer, not the renderer; large in-memory data-URL growth and upload progress are composer-side gaps, not verified here.

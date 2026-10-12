# Omni-search

> Type: Feature · Status: aligned · Updated: 2026-10-04

## Intent

One finder for everything: jump to a channel, open an agent, or locate history without remembering which channel it happened in.

## Architectural decision

- [Observed] Local store results merge with debounced server results; server history first, then in-memory messages (`OmniSearchModal.tsx:99-169`).
- [Observed] Empty query shows top channels/agents/tools instead of a blank panel (`OmniSearchModal.tsx:100-135`).
- [Inferred] Recency vs persistence merge: server covers persisted history, memory covers live streaming state (per area doc decision).

## How it works

Opens on Cmd/Ctrl+K via `App.tsx:124-134`, focuses the search input, closes on Escape/backdrop/X, locks body scroll, and resets the query + Search tab + active verb on open (`OmniSearchModal.tsx:42-86`). Closing by any path restores focus to the `Search` trigger. Typing debounces 200 ms into `GET /api/search?q=&limit=20`, storing channel + message hits (`OmniSearchModal.tsx:87-118` — single search effect, deduped single search block). Channels merge local name matches with server hits, deduped by id, sliced to 10 (`OmniSearchModal.tsx:124-148`); agents filter by name/species, tools by name/id; messages merge server-first then in-memory content matches, sliced to 10 (`OmniSearchModal.tsx:150-188`). Channel hit → `setActiveChannel` + close (`OmniSearchModal.tsx:315-316`); agent hit → profile modal + close (`OmniSearchModal.tsx:345-346`); message hit → jump to its channel + close (`OmniSearchModal.tsx:393-394`). 2026-10-04 Phase E adds a Commands tab: the 16 palette verbs from `modals/palette-verbs.ts` (`buildVerbs` — 14 Phase E switch/admin verbs + 2 Phase G capture verbs `open-quick-ask`/`ask-l0-in-place`, each summoning QuickAsk via the existing `crowdos:quick-ask-open` event) with subsequence fuzzy scoring (`filterVerbs`) + recent-first ordering from the `crowdos_palette_recent` mirror (cap 10), commands empty state `No matching commands for "{query}"` (`OmniSearchModal.tsx:420-422`), tablist switching (`OmniSearchModal.tsx:279-300`), `role=listbox`/`role=option` rows (`OmniSearchModal.tsx:428-440`), and combobox Arrow/Home/End/Enter + `aria-activedescendant` on the Commands input (`OmniSearchModal.tsx:251-262`); `runVerb` records use then runs a real store action (`OmniSearchModal.tsx:214-218`).

## Components involved

| Area doc | Role |
|---|---|
| <../Domain Spec/Modals.md> | Owns the modal shell, search flow, and result routing; this spec narrates only the federated-search UX |

## Current state

Search tab: four grouped sections (Channels with counts, Agents with species/level + View Profile, Enabled Tools, Matching Messages) with 48px-min rows, plus a "No matching entities or logs found" empty state. Commands tab: 16 palette verbs (scope + risk badge) with recent-first fuzzy ordering and a dedicated commands empty state. Destructive verbs arm on first press and run on the second ("press again to confirm"); any other row, a new query, a tab switch, or close disarms. Two verb titles name their real landing (repo panel / jobs view) instead of overpromising a diff or inbox view. Behavior matches the area doc.

## Alignment notes

- 2026-09-27 visual polish: section headers are sentence-case 13px medium (no mono-uppercase), agent rows use a text link ("View profile →") instead of a filled badge, tool icons desaturated to zinc. Search flow, sections, and routing unchanged.
- 2026-10-04 Phase E palette verbs: dual-mode Search + Commands (`role=tablist`), verbs registry `modals/palette-verbs.ts`, deduped single search block, commands empty state. Search-tab routing unchanged.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Local store results merge with debounced 200ms server results from /api/search. Server history first, then in-memory messages.
* Empty query shows top channels, agents, tools, never a blank panel.
* Results have keyboard navigation with Arrow and Enter, not pointer-only. Message hits scroll to the message anchor, not just the channel.
* Tool hits have an explicit action or are labeled display-only. Matched-substring highlighting is explicit.
* Server failure shows a user-visible error state, never console-only. Relevance ranking plus large-workspace performance have documented bounds. Authority: Modals area doc.
## Open gaps

- Search tab: no keyboard navigation observed (no Arrow/Enter handling): pointer/touch only. Commands tab DOES have keyboard navigation (Arrow/Home/End + Enter on the combobox input, `OmniSearchModal.tsx:251-257`).
- Message hits jump to the channel, not to the message: no scroll-to-message anchor observed.
- Tool hits are display-only rows (no action), and matched-substring highlighting was not observed.
- Server failure path is console-only with no user-visible error state; relevance ranking and large-workspace performance unverified.

# Mention autocomplete

> Type: Feature · Status: aligned · Updated: 2026-10-04

## Intent

Direct a message at the right agent by typing `@`: pick from a keyboard-driven list, keep the pick visible as a chip, optionally pin it to the channel.

## Architectural decision

- [Observed] Detection keys off the trailing `@word` before the caret; the match becomes a chip object, not raw `@text` (`MainChatArea.tsx:371-436`).
- [Observed] Chips split into one-shot (`selectedMentions`) and per-channel sticky (`stickyMentionsByChannel`) with pin/unpin (`MainChatArea.tsx:160-161,1033-1115`).
- [Observed] Render path styles human-operator mentions (amber) differently from agent mentions (indigo) (`MentionParser.tsx:430-452`).
- [Inferred] Chips are the routing source of truth: send prefixes deduped `@names` ahead of the body (`MainChatArea.tsx:451-455`).

## How it works

`handleInputChange` takes the word before the caret, opens the listbox on leading `@`, and filters agents by substring (`MainChatArea.tsx:371-393`). ArrowUp/Down cycles, Enter/Tab inserts, Escape dismisses; desktop Enter sends, Shift+Enter newlines (`MainChatArea.tsx:399-418`). `insertMention` strips the `@word` at the caret and appends the agent to the chip row (`MainChatArea.tsx:420-436`). Send merges one-shot + sticky mentions, dedupes by name, and prefixes `@a @b body` (`MainChatArea.tsx:443-459`). Rendering matches `@names` longest-first against agent names plus role/user fallback lists, skipping code blocks (`MentionParser.tsx:29-42,140-165,421-454`). 2026-10-04 Phase E: non-mention prose segments inside `renderMentions` render through `RedactedText` (display-only secret masking; mention chips themselves are never masked) (`MentionParser.tsx:441-480`); draft restore rehydrates one-shot chips from `draftByChannel.mentionIds` on channel switch (`MainChatArea.tsx:239-271`).

## Components involved

| Area doc | Role |
|---|---|
| <../Domain Spec/Chat Area.md> | Owns composer detection, chip/sticky state, send prefixing, and `MentionParser` chip rendering; this spec narrates only the mention UX |

## Current state

Listbox with level badges and `aria-selected`, chip row with pin/remove, sticky pins per channel, `input.length/4000` counter, and onboarding `@agent` quick chips in empty channels all observed. Matches the area doc's mention expectations.

## Alignment notes

- 2026-10-04 Phase E: `renderMentions` masks secrets via `RedactedText` outside mention chips; draft restore rehydrates chips from the `crowdos_drafts`-backed slice. Detection/routing unchanged.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Detection keys off the trailing @word before the caret with chip objects, one-shot plus per-channel sticky pins.
* Chips are the routing source of truth: send prefixes deduped @names ahead of the body.
* Caret-trailing-only limits are explicit: earlier-word edits and multi-mention paste have a defined behavior or an explicit unsupported contract.
* Role-name versus agent-name collisions plus case folding have an explicit resolution rule beyond longest-first sort.
* Sticky pins have an explicit scope contract: local-only with documented no-sync or synced via settings. Server-side @prefix routing is verified, not display-only. Listbox has screen-reader announcements. Authority: Chat Area area doc.
## Open gaps

- Only the caret-trailing word triggers: editing an earlier `@word` or pasting multiple mentions in one motion is unverified.
- Role-name vs agent-name collisions (e.g. `L1` vs a named agent) and case-folding edge cases unverified beyond longest-first sort.
- Sticky pins and mute-style maps have no cross-device sync or settings UI (area doc gap).
- Server-side routing of the `@prefix` (vs display-only chips) unverified; listbox screen-reader announcements unverified.

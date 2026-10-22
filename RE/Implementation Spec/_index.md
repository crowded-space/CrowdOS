# Implementation Spec — index

> Type: Map — Status: draft — Updated: 2026-10-21

Map only. Truth lives in the individual documents in this folder.

**Status vocabulary:** `draft` — written, not yet reviewed · `agreed` — reviewed and accepted by the user · `implemented` — landed in the codebase · `superseded` — replaced by a later version of the same document · `planned` — named here, not yet written.

| Doc | Covers | Items | Status |
|---|---|---|---|
| [P0 Chat Core.md](P0%20Chat%20Core.md) | The channel transcript: scroll memory, the honest unread anchor, anchor-measured prepends, the history skeleton and error card, message-list virtualization, scoped store subscriptions, deterministic orphan tool rows | 8 | draft |
| [P1 Navigation and Panels.md](P1%20Navigation%20and%20Panels.md) | The shell: the workspace rail inside the nav column, the channel-scoped participant section, the resizable ops panel, narrow-width browser access, the run-thread drawer's focus contract, per-workspace right-panel persistence and `#view=` | 6 | draft |
| [P2 Rich Message Features.md](P2%20Rich%20Message%20Features.md) | The message affordances: reactions, the action toolbar, mark-unread, link previews and embeds, message-anchored threads, channel pins and bookmarks, mention matching, the composer command surface, copy id / copy link / forward | 9 | draft |
| [P3 Performance and Accessibility.md](P3%20Performance%20and%20Accessibility.md) | The §12 measurement harness, keyboard completeness, the landmark and live-region audit, the single-pulse motion arbiter, the status strip's real sources, stream reconciliation under load, focus-visible and contrast verification | 7 | draft |
| [P4 Settings, Threads and Authority.md](P4%20Settings,%20Threads%20and%20Authority.md) | The agent profile picture, per-workspace server-backed roles, the `roleId` round-trip, one permission vocabulary, the stored permission blob decision, channel participation, per-agent authority display, the Admin Console's unsaved-changes bar / effective-value preview / search, the run-thread graduation, the roster's role grouping, the desktop shell follow-ups | 11 | draft |
| [Traceability Matrix.md](Traceability%20Matrix.md) | The corpus-level map: every Discord mechanism → the CrowdOS surface, the spec item and the verdict (Adopted / Adapted / Rejected), plus the reverse index of all 41 items and the gap list | 0 (covers all 41) | draft |
| [Build Sequence.md](Build%20Sequence.md) | The execution order: 14 waves from the documentation correction to the deferred security decision, with the one-wave rule for breaking surfaces and the review gate between waves | 0 (schedules all 41) | draft |
| [Open Decisions.md](Open%20Decisions.md) | The 23 questions the programme cannot answer on its own, each with options, a recommendation, a blocking reason and the items it unblocks | 0 (decides 23) | draft |

**Item-ID scheme.** `RE-<band>-<nn>`, two digits, zero-padded, unique inside the band:

| Band | Meaning | Range | Count |
|---|---|---|---|
| `RE-P0-nn` | Chat Core | `RE-P0-01` … `RE-P0-08` | 8 |
| `RE-P1-nn` | Navigation and Panels | `RE-P1-01` … `RE-P1-06` | 6 |
| `RE-P2-nn` | Rich Message Features | `RE-P2-01` … `RE-P2-09` | 9 |
| `RE-P3-nn` | Performance and Accessibility | `RE-P3-01` … `RE-P3-07` | 7 |
| `RE-P4-nn` | Settings, Threads and Authority | `RE-P4-01` … `RE-P4-11` | 11 |

**Total item count: 41** (8 + 6 + 9 + 7 + 11). The five P-documents own all 41; the Traceability Matrix, the Build Sequence and the Open Decisions own none of them and exist to relate them.

**All eight documents in this folder are present as of 2026-10-21.** The `Status` column records that all of them are still `draft` — none has been reviewed and agreed by the user. A row states what a document *covers* and how many items it carries; the `Status` column is the only field that asserts how far it has got.

**Rule:** a document added to or removed from this folder → same task updates this table; a document's scope changed → same task updates its own `Covers` cell; a document's status changed → same task updates its `Status` cell; the item count for a band changes → same task updates the scheme table and the total.

## Target Contract

> Status: Target. This index is a map only. Truth lives in the documents it points at; each carries its own `## Target Contract` stating what CrowdOS may and may not do.

* **A row is a map entry, not a claim of existence.** The `Status` column is the only field that asserts whether a document exists and how far it has got.
* **Every document listed here carries a metadata line** — `> Type: Spec — Status: draft — Updated: 2026-10-21` for the five item documents, `> Type: Reference — Status: draft — Updated: 2026-10-21` for the three relating artifacts (`Traceability Matrix.md`, `Build Sequence.md`, `Open Decisions.md`), `> Type: Map — Status: draft — Updated: 2026-10-21` for this index — and each kind keeps one H2 order.
* **Every item id is unique across the corpus.** `RE-P4-07` and `RE-P1-02` would be different items; `RE-P4-07` twice would be a defect.
* **A new document or a new band extends the scheme, it never renumbers it.** Existing ids are frozen; a retired item keeps its id and is marked retired in its own document.
* **The item count is derived, never typed twice.** The scheme table above is the single source; the Traceability Matrix's reverse index and the Build Sequence's wave table both restate it and must agree with it.
* **Discord is a reference, never a normative source.** Every adopted mechanism is additive; where a Discord pattern conflicts with a locked CrowdOS rule, the CrowdOS rule wins and the conflict is recorded — in the item, in `## Risks and blockers`, and in the Traceability Matrix's `Adopted / Rejected / Adapted` column.

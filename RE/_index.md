# RE Docs index

> Type: Map — Status: observed — Updated: 2026-10-21

Map only. Truth lives in the linked documents. This root is a **comparative analysis corpus**, not canonical CrowdOS documentation — `re-docs/` remains the canonical record of as-built behaviour, `UX_GUIDELINE.md` the normative design contract, `CrowdOS.md` the product spec.

Origin: a reverse-engineering pass over the installed Discord desktop client (1.0.9264, Electron 42) to raise CrowdOS's frontend UI/UX quality to Discord's. CrowdOS's existing UI and features are **canon** — nothing in this corpus removes or replaces them. Every Discord mechanism was either adopted (fills a CrowdOS gap), adapted (adopted in CrowdOS's own shape), rejected (a locked CrowdOS rule resists it), or deferred (needs a user decision).

Status vocabulary: `observed` (verified against an artifact) · `inferred` (reasoned from an artifact) · `draft` (spec written, not implemented) · `open` (decision pending).

| Corpus | Folder | Doc | Status |
|---|---|---|---|
| Discord RE | `Discord Findings/` | [Discord Findings/_index.md](Discord%20Findings/_index.md) | observed |
| Discord RE | `Discord Findings/` | [Shell and Navigation.md](Discord%20Findings/Shell%20and%20Navigation.md) | observed |
| Discord RE | `Discord Findings/` | [Right Panel and Members.md](Discord%20Findings/Right%20Panel%20and%20Members.md) | observed |
| Discord RE | `Discord Findings/` | [Message List.md](Discord%20Findings/Message%20List.md) | observed |
| Discord RE | `Discord Findings/` | [Scroll Model.md](Discord%20Findings/Scroll%20Model.md) | observed |
| Discord RE | `Discord Findings/` | [Composer.md](Discord%20Findings/Composer.md) | observed |
| Discord RE | `Discord Findings/` | [Threads.md](Discord%20Findings/Threads.md) | observed |
| Discord RE | `Discord Findings/` | [Interaction Vocabulary.md](Discord%20Findings/Interaction%20Vocabulary.md) | observed |
| Discord RE | `Discord Findings/` | [Roles and Authority.md](Discord%20Findings/Roles%20and%20Authority.md) | observed |
| Discord RE | `Discord Findings/` | [Settings Surface.md](Discord%20Findings/Settings%20Surface.md) | observed |
| Discord RE | `Discord Findings/` | [Keyboard and Accessibility.md](Discord%20Findings/Keyboard%20and%20Accessibility.md) | observed |
| Discord RE | `Discord Findings/` | [Performance Model.md](Discord%20Findings/Performance%20Model.md) | observed |
| Discord RE | `Discord Findings/` | [Desktop Shell Delta.md](Discord%20Findings/Desktop%20Shell%20Delta.md) | observed |
| Discord RE | `Discord Findings/` | [Evidence Index.md](Discord%20Findings/Evidence%20Index.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [CrowdOS Understanding/_index.md](CrowdOS%20Understanding/_index.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Shell and Layout.md](CrowdOS%20Understanding/Shell%20and%20Layout.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Chat Area and Scroll.md](CrowdOS%20Understanding/Chat%20Area%20and%20Scroll.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Composer, Mentions, Runtime.md](CrowdOS%20Understanding/Composer,%20Mentions,%20Runtime.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Panels, Drawers, Overlays.md](CrowdOS%20Understanding/Panels,%20Drawers,%20Overlays.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Settings and Authority.md](CrowdOS%20Understanding/Settings%20and%20Authority.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Storage and Media Model.md](CrowdOS%20Understanding/Storage%20and%20Media%20Model.md) | observed |
| CrowdOS as-built | `CrowdOS Understanding/` | [Canon and Locked Rules.md](CrowdOS%20Understanding/Canon%20and%20Locked%20Rules.md) | observed |
| Implementation spec | `Implementation Spec/` | [Implementation Spec/_index.md](Implementation%20Spec/_index.md) | draft |
| Implementation spec | `Implementation Spec/` | [P0 Chat Core.md](Implementation%20Spec/P0%20Chat%20Core.md) | draft |
| Implementation spec | `Implementation Spec/` | [P1 Navigation and Panels.md](Implementation%20Spec/P1%20Navigation%20and%20Panels.md) | draft |
| Implementation spec | `Implementation Spec/` | [P2 Rich Message Features.md](Implementation%20Spec/P2%20Rich%20Message%20Features.md) | draft |
| Implementation spec | `Implementation Spec/` | [P3 Performance and Accessibility.md](Implementation%20Spec/P3%20Performance%20and%20Accessibility.md) | draft |
| Implementation spec | `Implementation Spec/` | [P4 Settings, Threads and Authority.md](Implementation%20Spec/P4%20Settings,%20Threads%20and%20Authority.md) | draft |
| Implementation spec | `Implementation Spec/` | [Traceability Matrix.md](Implementation%20Spec/Traceability%20Matrix.md) | draft |
| Implementation spec | `Implementation Spec/` | [Build Sequence.md](Implementation%20Spec/Build%20Sequence.md) | draft |
| Implementation spec | `Implementation Spec/` | [Open Decisions.md](Implementation%20Spec/Open%20Decisions.md) | open |

Rule: a new spec item → same task adds its row to `Implementation Spec/Traceability Matrix.md`; a new finding → same task adds its row to the owning `_index.md`. Spec item IDs are `RE-P<band>-<nn>` and are stable once published.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the linked documents. `RE/` is analysis: a CrowdOS behaviour claim is proven by `file:line` in product code, never by a doc in this root, and `re-docs/` stays canonical.
* Additive only — a spec item states what it preserves; nothing in this corpus removes or replaces an existing CrowdOS feature, slot, view or behaviour.
* Every Discord claim carries an evidence pointer (a Discord Findings doc plus the mechanism it describes); every CrowdOS claim carries a `file:line`.
* Where a Discord mechanism conflicts with a locked `UX_GUIDELINE.md` rule, the CrowdOS rule wins and the conflict is recorded, never silently applied.
* A spec item that needs a new dependency, socket event, shared type, DB migration or REST route is a breaking-change surface and needs explicit sign-off — see `Implementation Spec/Open Decisions.md`.
* `file:line` anchors are pinned to the commit the corpus was written against (`e3fe5f5`); re-verify them at the start of each implementing task.
* Implementing a spec item updates the owning `re-docs/` doc in the same task, per `AGENTS.md` §6.
* A bare `:NN` continues the most recent file mention in the same paragraph or table row. Ambiguous by design; the file name is given wherever a reference could be misread.

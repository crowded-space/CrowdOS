# Discord Findings index

> Type: Map — Status: observed — Updated: 2026-10-21

Map only. Truth lives in the individual finding documents in this folder.

Status vocabulary: `observed` — evidenced in an artifact, with a pointer · `inferred` — reasoned from an artifact, with the reasoning stated · `draft` — written, not yet fully evidenced · `planned` — named here, not yet written.

| Doc | Covers | Status |
|---|---|---|
| <Shell and Navigation.md> | Desktop renderer shell: chrome bar, guild rail, channel sidebar, channel header, chat column, user area; URL / deep-link scheme; app-route allowlist | observed |
| <Right Panel and Members.md> | Everything right of the chat column: member list grouping rule, ordering, role colouring, per-member indicators, pinned messages, threads surface, toggleability and width | observed |
| <Message List.md> | Message-list container, row anatomy, grouping rules, separators, affordances, rich content, reaction rendering | observed |
| <Scroll Model.md> | Scroll box identity, stuck-to-bottom rule, new-message behaviour while scrolled up, history paging, viewport stability on prepend | observed |
| <Composer.md> | Composer input widget, accessory bar, send and validation semantics, autocomplete engines, expression pickers, attachments, typing indicator, draft persistence | observed |
| <Interaction Vocabulary.md> | Per-message action vocabulary: hover toolbar, right-click context menu, keyboard map, permission gating in the UI, notification-capable subset | observed |
| <Keyboard and Accessibility.md> | Global shortcut registry, focus-management model, ARIA landmark and widget inventory, live regions, reduced-motion and focus-visibility handling | observed |
| <Threads.md> | Thread creation path, where a thread appears on screen and in the URL, thread view shape, channel-list thread state, notifications, reply vs thread boundary | observed |
| <Roles and Authority.md> | Owner / administrator / role hierarchy / permission bits / per-channel overrides; every UI surface that shows authority | observed |
| <Settings Surface.md> | User-settings and server-settings surfaces: navigation architecture, control vocabulary, search, unsaved-change model, route scheme, structure-to-structure comparison with CrowdOS's modal | observed |
| <Desktop Shell Delta.md> | Electron main-process shell: splash window, protocol registration, IPC channels, updater, crash reporter, external-URL guard, Electron fuses; explicit 1.0.9262 vs 1.0.9264 version delta | observed |
| <Performance Model.md> | Message-list data volume strategy, code-splitting topology, render-cost control, realtime transport, hard-coded timing constants | observed |
| <Evidence Index.md> | Provenance for the whole corpus: sources, REA evidence identifiers, asset digests and sizes, read-only discipline, recorded tool failure, gaps | observed |

Rule: a new Discord finding is added to this table in the same task that writes the finding document.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the finding documents in this folder; each carries its own `Target Contract` section stating what CrowdOS may and may not copy from it.

* A finding document added or removed in this folder → same task updates this table.
* A finding document's scope changed → same task updates its own `Covers` cell here.
* A finding's status changes → same task updates its `Status` cell here; status is never inferred from the existence of the file.
* Discord is a **reference**, never a normative source. CrowdOS's own contract (`CrowdOS.md`, `UX_GUIDELINE.md`) takes precedence wherever the two disagree, and a finding document MUST say so where the disagreement is material.
* Every finding document MUST cite its evidence (see `Evidence Index.md`), and every claim in it MUST carry an `[Observed]` or `[Inferred]` label.
* A bare `:NN` continues the most recent file mention in the same paragraph or table row. Ambiguous by design; the file name is given wherever a reference could be misread.
* New findings MUST NOT restate the corpus without a new evidence pointer.
* No third-party source is vendored into this repository; artifacts are referenced by name, size and digest.

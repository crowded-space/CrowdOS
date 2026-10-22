# CrowdOS Understanding index

> Type: Map — Status: observed — Updated: 2026-10-21

Map only. Truth lives in the individual understanding documents in this folder.

Status vocabulary: `observed` — read directly from the code as it stands · `inferred` — reasoned from the code, with the reasoning stated · `draft` — written, not yet fully evidenced · `planned` — named here, not yet written.

| Doc | Covers | Status |
|---|---|---|
| <Shell and Layout.md> | The desktop shell: window chrome, workspace rail, channel sidebar, chat column, right panel, and how the panels are laid out and resized | observed |
| <Panels, Drawers, Overlays.md> | Every overlay and panel above the shell: modals, drawers, popovers, toasts, confirm dialogs, and their stacking / focus rules | observed |
| <Chat Area and Scroll.md> | The conversation column: message row anatomy, grouping, separators, scroll box, stuck-to-bottom rule, history paging, viewport stability | observed |
| <Composer, Mentions, Runtime.md> | The composer widget, mention and agent autocomplete, runtime selection and pinning, attachments, drafts, send and validation semantics | observed |
| <Settings and Authority.md> | The Admin Console modal (13 tabs, what each is authoritative for) and CrowdOS's two authority layers: the enforced tier and the unenforced permission / role blobs | observed |
| <Storage and Media Model.md> | Local-first storage: the filesystem tier, the optional database tier, sync and conflict resolution, attachments, artifacts and retention | observed |
| <Canon and Locked Rules.md> | The locked product canon — §5 invariants, §25 Router rules, §31 tier model, §34 implemented-vs-planned — and where each rule is enforced in code | observed |

Rule: an understanding document added, renamed or removed in this folder → same task updates this table.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the understanding documents in this folder; each carries its own `Target Contract` section stating what is as-built, what is a gap, and what must not change.

* A row is a **map entry, not a claim of existence** — a document listed as `planned` may not be written yet. Status is the only field that asserts whether the document exists.
* A document added or removed in this folder → same task updates this table.
* A document's scope changed → same task updates its own `Covers` cell here.
* A document's status changed → same task updates its `Status` cell here; status is never inferred from the existence of the file.
* Every understanding document MUST cite product code by `file:line` for every behavioural claim. A claim without a pointer is a defect.
* Understanding documents describe **as-built** behaviour. Where the code and `CrowdOS.md` disagree, the document records the drift explicitly rather than resolving it silently.
* Understanding documents describe CrowdOS only. Discord material belongs in `../Discord Findings/` and is referenced from a document's `## Comparison hooks` section, never copied in.
* A bare `:NN` continues the most recent file mention in the same paragraph or table row. Ambiguous by design; the file name is given wherever a reference could be misread.
* A change to product code that alters an as-built behaviour → same task updates the affected understanding document.
* The locked canon (`CrowdOS.md` §5 invariants, `UX_GUIDELINE.md`) is never restated loosely. Where a document repeats a rule, it quotes the rule's location.

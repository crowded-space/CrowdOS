# Build Sequence

> Type: Reference — Status: draft — Updated: 2026-10-21

## Purpose

This is the execution order for the whole Discord-derived programme: five spec documents, **41** items, one sequence. It answers the question a reviewer asks last and most often — *in what order do we build this, and what has to be true before the next thing may start?*

The sequence is built around four constraints, in this priority order:

1. **The ground truth must be true before any code lands.** The `UX_GUIDELINE.md` drift items are corrected in the same task as the specs that cite them. A wave that implements against a guideline known to be wrong implements against a contradiction, and the contradiction becomes a defect.
2. **Nothing is claimed that cannot be measured.** The measurement harness lands in **Wave 1**, before every other implementation wave, so that every later performance claim in the §12 budget is checkable rather than asserted.
3. **A breaking-change surface lands in exactly one wave, together with its consumers.** A new socket event, a new shared type, a new migration or a new REST route is introduced in the same wave that introduces the code that uses it, and never split across two waves.
4. **A human reviews between waves.** `AGENTS.md` §7 puts a review gate between every wave: finish → checks → stop → the user reviews and tests → the user is asked `commit?` → the next wave starts only after a commit or an explicit "continue without commit". No wave is started on the agent's own judgement.

The sequence is a **plan, not a contract**. Waves 0 through 4 and 8 through 12 are the work; Wave 13 is the one security decision that is held back deliberately.

## How it works

**What kind of document this is.** This is a **reference artifact of the Spec kind**: it schedules the items the five P-documents own and states no new behaviour of its own. It therefore carries the reference H2 order, not the Spec H2 order — `../_index.md:41` requires "the same H2 order within its kind", and this is a reference kind. The P-documents carry the Spec kind and the Spec H2 order.

**The numbering.** Waves are numbered globally, `0` through `13`, and are executed in order. Wave 0 is documentation-only. There is no "Wave 0.5".

**The tracks.** The five bands are three tracks that meet at named join points:

| Track | Bands | Character | Join points |
|---|---|---|---|
| **Enabling** | P3 (Performance and Accessibility) | The harness and the verification every other band is measured against. | Wave 1 (RE-P3-01, RE-P3-07) gates every implementation wave. |
| **Product** | P0 (Chat Core), P1 (Navigation and Panels), P2 (Rich Message Features) | The transcript, the shell and the message affordances. | Wave 5 (P0) → Wave 7 (P1) → Wave 10 (P2). Each band follows the surface it addresses. |
| **This band** | P4 (Settings, Threads and Authority) | Settings, authority, the run thread, the avatar, the shell. | Wave 2 (avatar) and Wave 3 (roles) are independent of the product track; Wave 13 (enforcement) needs the harness **and** the windowing. |

**The two-surface rule.** Two surfaces are touched by more than one document: the **run-thread drawer** (RE-P1-05, RE-P2-05, RE-P4-09) and the **roster** (RE-P1-02, RE-P4-06, RE-P4-10). Where two items touch the same surface, the **lower item id owns the behaviour** and the higher one may only **extend** it. The sequence places each pair in different waves so they are never in flight at once: the drawer in Waves 7, 10 and 11; the roster in Waves 7 and 8.

**What "depends on" means in the table.** A dependency means: the item's **acceptance criteria cannot be checked** until the dependency has landed. It does not mean the work cannot be *started*. The plan assumes the team is smaller than the plan, so the sequence is the safe order, not the fastest one.

**The review gate.** It is stated once, here, and applies to every wave boundary:

> After each wave: run the checks in `AGENTS.md` §2 (`npm run typecheck`, `npm run lint`, `npm test`, and `npm run lint:gates` on the server), stop, hand the result to the user for a live review, ask `commit?`, and only then start the next wave. `npm run check:docs` does not exist yet (`AGENTS.md` §2 lists it as "TO BUILD"), so the docs-sync obligation is discharged by editing the owning Domain Spec in the same task as the code, and by keeping the drift table in `../CrowdOS Understanding/Canon and Locked Rules.md` current.

**The two items that are not in the sequence.** RE-P4-05's *decision* must be answered before Wave 13 can be planned — but its *implementation* is Wave 13. RE-P4-11's Electron fuse configuration and crash reporting are not in the sequence at all: they are a packaging concern routed to `../Open Decisions.md` #13, and a packaging task is not a client wave.

## Structural inventory

| Wave | Items | Theme | Gate | Depends on |
|---|---|---|---|---|
| **0** | Docs-only: `UX_GUIDELINE.md` drift items 1–9, 11, 12; the `Send-message flow.md:13` operator-name correction; the `Workspace Shell.md` mode-count contradiction; the stale `[pending]` markers | Make the ground truth true before any code lands | — (documentation only) | NONE |
| **1** | RE-P3-01, RE-P3-07 | The measurement harness and the contrast/focus verifiers — every later claim becomes checkable, and drift 13 closes | Diagnostics | Wave 0 |
| **2** | RE-P4-01 | Agent profile picture: content-addressed media store, upload leg, binary-serving leg, `<AgentAvatar>`, the three renderers | Agents (`agentGate`) | Wave 1 |
| **3** | RE-P4-04, RE-P4-02 | One permission vocabulary, then per-workspace server-backed roles — migration `0033_workspace_roles.sql`, `roleGate`, five routes, the tenant-scoped `roles` slice | Workspace (new `role-gate.ts`) | Wave 1 |
| **4** | RE-P4-03, RE-P4-07 | The `roleId` round-trip — migration `0034_agents_role_id.sql` — plus the widened client projection, the role chip and the Agents Board Role column | Agents (`agentGate`) | Wave 3 |
| **5** | RE-P0-01 … RE-P0-08 | Chat core: scroll memory, the honest unread anchor, anchor-measured prepends, the history skeleton, the error card, virtualization, scoped subscriptions, deterministic orphan tool rows | Chat Area | Wave 1 |
| **6** | RE-P3-02, RE-P3-03, RE-P3-04, RE-P3-05, RE-P3-06 | Keyboard completeness, the landmark and live-region audit, the single-pulse motion arbiter, the status strip's real sources, stream reconciliation under load | Chat Area | Wave 5 |
| **7** | RE-P1-01 … RE-P1-06 | Navigation and panels: the workspace rail, the channel-scoped participant section, the resizable ops panel, narrow-width browser access, the drawer's focus contract, per-workspace view persistence and `#view=` | Workspace Shell | Wave 6 |
| **8** | RE-P4-06, RE-P4-10 | The channel participation model (a server port and an honest label), then the nested role grouping inside the tier bands — both extending RE-P1-02 | Channels / Messages (gates) | Waves 4, 7 |
| **9** | RE-P4-08 | The Admin Console: unsaved-changes bar, guarded discard, effective-value preview, settings search — inside the existing 13-tab modal | Workspace Shell | Wave 3 |
| **10** | RE-P2-01 … RE-P2-09 | Rich message features: reactions, the action toolbar, mark-unread, link previews, message-anchored threads, channel pins, mention matching, the composer command surface, copy/forward | Chat Area | Waves 5, 7 |
| **11** | RE-P4-09 | The run-thread graduation: a server-derived branch, provenance on the also-send, and the removal of `UX_GUIDELINE.md:76`'s `[pending]` marker | Threads / Runs (gates) | Waves 7, 10 |
| **12** | RE-P4-11 | The desktop shell: pre-ready `crowdos://` registration, the origin check, `will-navigate`, the `disableUpdater` kill switch, the security-policy assertions | Desktop (`desktopGate.ts`) | Wave 1 |
| **13** | RE-P4-05 — **option (A) only**, and only after `../Open Decisions.md` #4 is answered | Permission-blob enforcement: the Router as a narrowing filter, the tool executor's refusal path, the back-fill migration | Runtime / Agents | Waves 1, 5 |

**Wave count: 14** (0 through 13). Wave 0 is documentation. Wave 1 is measurement. Waves 2–4 and 8–12 are the P4 band and its immediate neighbours. Waves 5–7 and 10 are the P0–P3 track. Wave 13 is the deferred security decision.

## Implementation details

### Wave 0 — Documentation truth (no code)

**Why first.** `../CrowdOS Understanding/Canon and Locked Rules.md:165-181` records **thirteen** drifts between `UX_GUIDELINE.md`, the `re-docs` specs and the code. Nine are `[pending]` markers on features that are **already built** (Restore run, Jobs, Operations Inbox, Capture tier, Status strip) and four are stale statements (the `rightSidebarOpen` boolean at `UX_GUIDELINE.md:96`, four right-panel views at `:32`, the non-existent 56 px rail at `:59`, the "Preflight line above Send" proposal at `:82`).

**What lands.** The thirteen corrections, each in the file that is wrong, plus the `Send-message flow.md:13` operator-name correction (the code uses `local-operator` — `MainChatArea.tsx:604`, `crowdOsStore.ts:2974-2979`), plus the `Workspace Shell.md` mode-count contradiction (the code has six modes — `ModeSelector.tsx:24-33`).

**Drift 3 is now a build item, not only a documentation one.** RE-P1-01 adds a 56 px workspace rail **inside** the existing nav column, which is what `UX_GUIDELINE.md:59` describes. The guideline's slot map therefore becomes true by construction rather than by deletion — but the *wording* still has to be corrected to say the rail is inside the nav column, not a column of its own.

**Drift 9 is a removal, not a correction.** `UX_GUIDELINE.md:82` proposes a preflight line above Send; the code folds the preflight into the single status line (`MainChatArea.tsx:1499-1515`). Re-introducing a second row would break `UX_GUIDELINE.md:89`. The correction is to delete the `[pending]` marker **and** the proposal, and to point at where the preflight actually lives.

**Drifts 10 and 13 are not Wave 0.** Drift 10 (the virtualization budget is locked but unmet) is resolved by implementation — RE-P0-06 in Wave 5. Drift 13 (light-theme WCAG AA asserted in prose, not verified by a sampler) is resolved by **RE-P3-07** in Wave 1.

**Exit condition.** `UX_GUIDELINE.md` and the `re-docs` specs agree with the code, and the drift table is updated to two remaining items with their owning waves.

### Wave 1 — The measurement harness and the verifiers

**Why second, and why before every implementation wave.** The §12 budget table (`UX_GUIDELINE.md:158-171`) has **seven rows and not one is currently measured**: cold start, channel switch, tree expand and palette latency are all recorded as "Unverified — no measured harness in the repo" (`../CrowdOS Understanding/Canon and Locked Rules.md:212-218`). `UX_GUIDELINE.md:171` says "Violations surface in Diagnostics, not silent jank" — and today there is no place for a violation to surface. RE-P3-01 is the **enabling** item of the whole programme.

**What lands.** RE-P3-01 (the harness, and the Diagnostics surface that reports against the §12 rows) and RE-P3-07 (the WCAG contrast sampler and the focus-ring check — the verifiers that close drift 13). Nothing else in this wave is new behaviour.

**Why no breaking surface.** Both items add counters, ratios and checks to existing surfaces (`settings/DiagnosticsTab.tsx`, `src/index.css`, `src/light-theme.css`). Neither adds a socket event, a shared type or a migration. Instrumentation stays within `UX_GUIDELINE.md:144` — counts and latencies only, never message content, file contents, secrets or memory writes.

**Exit condition.** A cold start, a channel switch, a tree expand and a palette keystroke each produce a number in Diagnostics, compared against the §12 rows; and the contrast sampler runs over the real CSS files.

### Wave 2 — The agent profile picture (RE-P4-01)

**Why here.** It is the headline feature the user asked for, it is self-contained, and it introduces the product's **first binary response path**. The harness must exist first, because the new `<img>` appears in up to 200 roster rows at once (`RightSidebar.tsx:178-182`) and the render cost is the thing that must be measured rather than guessed.

**The one-wave rule, in force.** Wave 2 introduces **three** breaking-change surfaces — migration `0032_agents_avatar_path.sql`, `PUT /api/agents/:id/avatar` and `GET /api/agents/:id/avatar` — and **every consumer of all three lands in the same wave**: the media repository, the `agentGate.setAvatar` port, the two routes, the widened client `Agent` type, both hydration mappers, the new `<AgentAvatar>` component, the three renderers and the Agents Board control. Nothing is staged: there is no wave in which the column exists and no route writes it.

**Ordering inside the wave.** Migration and schema first, then the repository and the gate port, then the routes, then the client. The route cannot be written before the gate port exists, and the client cannot be written before the route answers.

**Exit condition.** The acceptance criteria of RE-P4-01, including the two that matter most: uploading the same image for two agents creates **one** blob, and a foreign-workspace agent id returns 404 rather than bytes.

### Wave 3 — One vocabulary, then per-workspace roles (RE-P4-04, RE-P4-02)

**Why the vocabulary comes first.** RE-P4-02 persists the role list. Persisting a list whose permission ids are drawn from two vocabularies that do not intersect (`WorkspaceSettingsModal.tsx:25-36` against `initialData.ts:14-19`) would persist a set of records that render wrong forever. The vocabulary is the smaller change and it must land first so that the persisted rows are truthful from the moment they exist.

**Why the two are one wave.** They are one story: "roles are a per-workspace, server-owned list of display labels with one permission vocabulary". Splitting them would produce a persisted list whose rendering is still broken, and a rendered list that is still unpersisted.

**Sequence inside the wave: RE-P4-04, then RE-P4-02.** RE-P4-04 owns the permission registry and **adds its own line beneath** `WorkspaceSettingsModal.tsx:1728`; RE-P4-02 owns the final string at `:1728` and rewrites **only** that line, leaving RE-P4-04's line in place. Neither item rewrites the other's string.

**The one-wave rule, in force.** Wave 3 introduces migration `0033_workspace_roles.sql`, the new `workspace_roles` table, the new `role-gate.ts` and five new routes. The `roleGate` port, the local `roles.json` writer, the tenant-scoped `roles` slice, the `clearTenantSlices` change, the seeded-role bootstrap and the two honesty strings at `WorkspaceSettingsModal.tsx:1723`/`:1728` all land in the same wave.

**The two honesty strings are the risky part.** "Roles · local only" and "no server enforcement behind them" become false after this wave. They are replaced by copy that says roles are per-workspace display labels that carry no authority. This is a visible change to a shipped surface and is flagged as **R7** in the P4 spec — the review gate has to actually look at it.

**Exit condition.** A role created in workspace A survives a reload, is absent from workspace B, and the seeded roles render their true switch state.

### Wave 4 — The role round-trip and the authority display (RE-P4-03, RE-P4-07)

**Why after Wave 3.** RE-P4-07 displays a role. A role that cannot survive a reload cannot be displayed truthfully. The chain RE-P4-03 → RE-P4-07 has no slack.

**Why one wave.** RE-P4-03 introduces migration `0034_agents_role_id.sql` and the server's role-id column and validator; RE-P4-07 consumes the same field in the client, in the roster and in the Agents Board. Splitting them would put a stored role id in the database with nothing displaying it — exactly the "settable but not readable" defect the Agents Domain Spec calls out.

**The load-bearing constraint.** The `L{n}` chip is unconditional and first in DOM order, and the role chip is subordinate to it. A role may never be read as authority (`AGENTS.md` §5.3). The acceptance criteria test that by removing the role and asserting the tier chip survives.

**Exit condition.** An agent's role survives a reload; the roster row still shows the tier chip; an agent with no role renders byte-identically to today.

### Wave 5 — Chat core (RE-P0-01 … RE-P0-08)

**Why here.** The transcript is the product's centre, and three later waves address it: RE-P3-06 (stream reconciliation) extends the fold pass RE-P0-07 extracts; RE-P2-02 (the action toolbar) renders inside the row types RE-P0-08 stabilises; and the virtualization RE-P0-06 brings is the precondition for RE-P4-01's roster measurement to be meaningful at 10k messages.

**The lock.** RE-P0-06 implements the §12 budget row **as written** — "virtualize past 500 channels / 2,000 messages" (`UX_GUIDELINE.md:167`). If the row cannot be met, the **budget is amended explicitly**; `UX_GUIDELINE.md:171` forbids a silent breach. Adding a windowing dependency is a breaking-change surface of its own and is named in `../Open Decisions.md` #1.

**The drift item that closes here.** Drift 10 — the virtualization budget is locked but unmet — is resolved by RE-P0-06.

**Exit condition.** Every RE-P0 acceptance criterion, and the §12 virtualization row met or the budget amended in the same task.

### Wave 6 — Performance and accessibility core (RE-P3-02 … RE-P3-06)

**Why after Wave 5.** RE-P3-06 extends the `transcript-fold.ts` module that RE-P0-07 extracts, and RE-P3-05's status strip depends on the strip's real sources existing. Splitting them would have two documents editing one module.

**What lands.** RE-P3-02 (one shortcut registry, roving tabindex, `aria-activedescendant`), RE-P3-03 (the landmark set and the polite/assertive live regions), RE-P3-04 (the single-pulse motion arbiter — this is the `[pending]` item at `UX_GUIDELINE.md:49`), RE-P3-05 (the status strip's real sources — the empty segments at `MainChatArea.tsx:1508-1514`), RE-P3-06 (stream reconciliation under load).

**Exit condition.** The keyboard contract holds, the landmark set is complete and unique, the motion budget has exactly one pulse, every status-strip segment has a source or renders empty, and a streaming flush touches only the tail.

### Wave 7 — Navigation and panels (RE-P1-01 … RE-P1-06)

**Why after Wave 6.** The panels address the transcript and the keyboard surface, both of which Wave 6 settles.

**What lands.** RE-P1-01 (the 56 px workspace rail inside the nav column — this is what closes drift 3), RE-P1-02 (the channel-scoped participant section inside the existing roster view), RE-P1-03 (the resizable ops panel), RE-P1-04 (narrow-width access to the `browser` view, which is currently unreachable below `xl`), RE-P1-05 (the run-thread drawer's focus contract), RE-P1-06 (per-workspace right-panel view persistence and `#view=`).

**RE-P1-02 owns the roster's participant section.** RE-P4-06 and RE-P4-10 extend it in Wave 8 and may not re-implement it. The client already derives a channel participant set at `RightSidebar.tsx:139` (`channelParticipantIds`) for the telemetry view; RE-P1-02 gives it a place in the roster, RE-P4-06 gives it a server port and an honest label, and RE-P4-10 adds the optional role grouping inside it.

**Exit condition.** The rail exists inside the nav column; the roster shows a channel-scoped participant section; the ops panel resizes; the browser view is reachable at every width; the drawer traps focus and restores it; the panel view survives a channel switch.

### Wave 8 — Channel participation and the roster grouping (RE-P4-06, RE-P4-10)

**Why here.** Both items extend RE-P1-02, and extending it is only safe once the section exists and is owned.

**What lands.** RE-P4-06 (a workspace-scoped server read port for the participant set, and the honest label — "Participants seen in this channel", never "Members") and RE-P4-10 (the nested role grouping inside the tier bands, the lower-cased-name ordering, and the disabled-with-reason row actions).

**The conditional part.** RE-P4-06 option (B) — a real `channel_members` table plus an "add agent to channel" verb — is **not** in this wave unless `../Open Decisions.md` #7 is answered first. Option (B) adds a migration (`0035_channel_members.sql`), a set of routes and a **new user-facing verb**, and `AGENTS.md` §5.13 forbids building a planned product feature without sign-off. If it is approved, its migration and its consumers land **in this wave**, not in a later one.

**Exit condition.** The channel-scoped section says what it actually knows; the tier order holds; the `L{n}` chip holds inside a role group; the ordering fixture holds; a row action the operator cannot take is disabled **with a tier-based reason**.

### Wave 9 — The Admin Console (RE-P4-08)

**Why after Wave 3.** The unsaved-changes bar counts pending edits. A count over two vocabularies is a count over nothing.

**Why the modal survives.** This wave does **not** replace the modal with a routed page. The 13 tabs keep their ids, their order, their labels and their bodies; the `tabs` array stays the single registry and the header title still derives from it (`WorkspaceSettingsModal.tsx:959-973`, `:1072`). A routed settings page is `../Open Decisions.md` #10 and is not built here.

**The risky part.** The wave adds the product's **first blocking dialog inside the modal** — the guarded discard — which changes the `Escape` and backdrop behaviour of a surface that has none today. That is **R8** in the P4 spec.

**Exit condition.** A role edit is staged, not written; `Save` writes once; `Discard` reverts; the guard appears on backdrop, `X` and `Escape` with **Keep Editing** as the default; the search filters the 13 tabs and never adds one.

### Wave 10 — Rich message features (RE-P2-01 … RE-P2-09)

**Why after Waves 5 and 7.** The action toolbar renders inside the row types RE-P0-08 stabilises; the mark-unread action extends the anchor RE-P0-02 creates; the composer command surface reuses the verb registry the palette already owns.

**The one-wave rule, in force.** Wave 10 introduces migration `0030_message_reactions.sql` and a new socket event, and **every consumer of both lands in this wave**: the reaction service, the message gate port, the route, the event-type entry, the client store slice and the picker. A schema wave followed by an event wave would leave the surface half-built, and `packages/server/scripts/check-events.mjs` would fail the phantom-handler check in between.

**The gate is `../Open Decisions.md` #3, and #3 requires decision #1 only.** It does **not** require #4: #4's item (RE-P4-05) is Wave 13, after this wave, so requiring #4 here would gate an earlier wave on a later one. The choice is recorded in #3's row and is not changed by this sequence.

**The dependency on Wave 2.** RE-P2-04's server-owned link-preview fetch and RE-P2-01's reaction payloads are the first places after the avatar where CrowdOS moves user-supplied bytes or third-party content over the wire. Wave 2's binary leg and its path-containment review must exist first. The sequence therefore holds Wave 2 before Wave 10.

**Exit condition.** Every RE-P2 acceptance criterion, and `npm run lint:gates` green with the new event in the broker contract.

### Wave 11 — The run-thread graduation (RE-P4-09)

**Why last of the P4 work.** It touches the run-thread drawer, which Waves 7 (RE-P1-05, the focus contract) and 10 (RE-P2-05, the message-anchored thread model) also touch. Running it last means the drawer's focus contract and its thread model are settled before the graduation lands on top of them.

**The one-wave rule, in force.** Wave 11 introduces `GET /api/runs/:id/branch` and every consumer of it in the same wave: the route, the Runs gate port it reads through, the drawer's fetch, the server-derived branch with the client-memory derivation as a fallback, the provenance link on the also-send, **and** the removal of the `[pending]` marker at `UX_GUIDELINE.md:76` plus the Frontend Domain Spec entry. The marker is removed in the same task as the code, never before.

**Exit condition.** The branch shows a run with more steps than the 200-message client mirror holds; only the final answer posts; the posted answer links back to the run; `UX_GUIDELINE.md:76` no longer says `[pending]`.

### Wave 12 — The desktop shell (RE-P4-11)

**Why independent and late.** It touches `packages/desktop` only, adds no socket event, no shared type, no migration and no route, and has the lowest user-visible urgency of the band.

**What is not in it.** The Electron fuse configuration and crash reporting are a **packaging** concern, not an app-source concern, and they are routed to `../Open Decisions.md` #13. Bundling a build-pipeline change into a client wave would make the wave unreviewable.

**Exit condition.** `crowdos://` is registered before `app.whenReady()`; the origin check refuses a host or protocol mismatch; `will-navigate` is cancelled; `sandbox` stays `true`; the IPC allowlist stays a zod enum; `window.crowdos` stays the only renderer-visible bridge.

### Wave 13 — Permission enforcement (RE-P4-05, option A only)

**Why last.** This is the **highest blast radius** change in the entire programme: it touches the Router (the `CrowdOS.md` §25 path), the tool executor and the `agents.permissions` semantics, for **every** agent in every workspace. It lands last because (a) the harness exists to measure it, (b) the windowing (RE-P0-06) exists so the Router's extra work is measurable, and (c) it is a **security decision** that `../Open Decisions.md` #4 must answer first.

**The non-negotiable precondition.** The stored blob is deny-by-default (`agent-service.ts:39-43`). A back-fill migration must set the blob to today's **effective** behaviour **before** enforcement is enabled, or the wave denies everything product-wide and breaks swarm orchestration and runtime patching for every existing agent.

**The non-negotiable constraint.** Enforcement may only **narrow**. It may never raise authority, never widen a channel set, never bypass a tier rule, and never invert the Router's L0–L3 mapping (`AGENTS.md` §5.3). If the implementation cannot state that in one sentence, it is wrong.

**Under option (B), this wave does not exist.** Option (B) removes the hard-coded all-true grant at `crowdOsStore.ts:3019` and labels the blob advisory; that is a small change that can be folded into Wave 3 or shipped on its own.

## Interaction model

**The user's experience of the sequence.** Each wave ends with a human reviewing something they can see. That is a design constraint, not a convenience.

| After wave | The user can see | The user can check |
|---|---|---|
| 0 | The guideline agrees with the product | The `[pending]` markers are gone; the four-view sentence and the operator name are corrected |
| 1 | Diagnostics reports real numbers, and the theme's contrast is measured | A cold start, a channel switch, a tree expand and a palette keystroke all have measurements; the sampler runs over the real CSS |
| 2 | An agent has a picture, shared across the workspace | One upload, two agents, one file on disk; another workspace sees nothing |
| 3 | Roles survive a reload and belong to a workspace | A role in workspace A is absent from workspace B; the seeded roles render their true state |
| 4 | An agent shows its role — beside its tier, never instead of it | The `L{n}` chip is still there with the role removed |
| 5 | The transcript scrolls smoothly past 2,000 messages and keeps its place | The §12 virtualization row has a number; a prepend does not move the viewport |
| 6 | The keyboard reaches everything; the shell announces itself; only one thing pulses | Every verb is reachable without a pointer; the landmark set is complete |
| 7 | The workspace rail is there; the roster shows who took part in this channel; the panel resizes | The rail is inside the nav column; the ops panel resizes within 260–320 px |
| 8 | The roster can group by role inside each tier band, and says what it knows about participation | The tier order is unchanged; the header says "Participants seen in this channel" |
| 9 | The Admin Console stages edits and can be searched | A role edit does not stick until `Save`; the discard guard offers Keep Editing |
| 10 | Reactions, pins, previews, threads and a unified action toolbar work | `npm run lint:gates` is green with the new event in the broker contract |
| 11 | A run thread shows its whole branch | A run with 300 steps shows all 300; only the final answer posts, with a link back |
| 12 | The shell refuses an off-origin link and loses no deep link | The origin check refuses a host mismatch; `crowdos://` survives a cold start |
| 13 | The permission blob either restricts or is labelled | An L2 agent with `spawnAgents: false` cannot spawn, and no pre-existing agent broke |

**The review gate is not optional between these.** `AGENTS.md` §7: finish → checks → stop → the user reviews → `commit?` → the next wave. The user-facing surface of a wave is what the user reviews, so no wave may be started on the agent's judgement alone.

## Performance notes

**The §12 budget rows this sequence touches, and where each is measured.**

| Budget row (`UX_GUIDELINE.md:158-171`) | Measured in | Gate |
|---|---|---|
| Cold start → interactive shell | Wave 1 (harness), Wave 12 (shell) | Wave 1 |
| Channel switch | Wave 1 (harness), Wave 5 (scroll memory) | Wave 1 |
| Streaming: instant pin, missed-count pill, rAF throttle | Already met — Wave 1 adds the regression assertion; Wave 6 (RE-P3-06) keeps it met under load | Wave 1 |
| Tree expand | Wave 1 | Wave 1 |
| Palette per keystroke | Wave 1 | Wave 1 |
| Lists: virtualize past 500 channels / 2,000 messages | Wave 5 (RE-P0-06) | Wave 1 |
| Renderer memory < 600 MB with 10k messages | Wave 5 | Wave 1 |
| Ledger poll 30 s, strip ticks ≤ 1/s | Wave 1, Wave 6 (RE-P3-05) | Wave 1 |

**The performance costs this sequence adds, and where they are bounded.**

| Wave | Added cost | Bound | Measured by |
|---|---|---|---|
| 2 | A binary response path; an `<img>` in up to 200 roster rows | The blob is content-addressed, so a second reference costs no extra bytes; the read is local-file, no database round-trip | Wave 1, before Wave 2 lands |
| 3 | A role list read on every workspace load | The list is small and workspace-scoped; the read replaces a full-roster replace on every agent mutation (`crowdOsStore.ts:3028` → `:1573`) | Wave 1 |
| 4 | A wider client projection (seven more fields on every agent) | The fields are scalars already in the server response; no extra request | Wave 1 |
| 5 | Windowing overhead | The §12 budget row is the acceptance criterion | Wave 1 |
| 10 | Reactions, pins and previews move server-owned payloads | Each is a bounded record with an explicit size story | Wave 1 |
| 11 | A server-derived branch | It replaces a client-memory derivation that was already O(n) over the loaded window (`ThreadDrawer.tsx:61-69`) | Wave 1 |
| 13 | A permission check on every routing decision | The check is a narrowing filter over three booleans; the back-fill keeps the decision identical for existing agents | Wave 1 and Wave 5 |

**The one thing that is deliberately not measured in this sequence.** The avatar upload is not a performance-critical path, but the **roster render** with images is: the roster renders up to one row per visible agent in a scrolling panel (`RightSidebar.tsx:375`). The harness must be able to compare the roster's render cost with and without `<img>` elements before Wave 2 lands. That is the specific reason Wave 1 precedes Wave 2.

## Evidence

| Source | What it establishes |
|---|---|
| `AGENTS.md` §1 (protocol), §2 (definition of done), §3 (gate discipline), §5 (invariants and breaking-change surfaces), §6 (docs sync), §7 (review gate), §9 (report) | The rules this sequence encodes: the one-wave rule for breaking surfaces, the docs-sync rule, and the review gate between waves. |
| `UX_GUIDELINE.md:4`, `:32`, `:49`, `:59`, `:76`, `:82`, `:88`, `:96`, `:100`, `:109`, `:111`, `:122`, `:158-171`, `:167` | The normative statements Wave 0 corrects, the two markers Waves 0 and 11 remove, and the §12 budget table. |
| `../CrowdOS Understanding/Canon and Locked Rules.md:132-145`, `:151-163`, `:165-181`, `:206-220` | The budget table, the nine `[pending]` items, the thirteen drifts, and the measured status of every budget row. |
| `../CrowdOS Understanding/Storage and Media Model.md:71-80`, `:98-117`, `:214-227` | The local-first tiers, the media gap, the `vfs/agents/media/<sha256>.<ext>` landing zone, and the twelve storage gaps that motivate Wave 2. |
| `../CrowdOS Understanding/Settings and Authority.md:44-73`, `:97-115`, `:163-168`, `:200-207`, `:249-261` | The role model, the two vocabularies, the broken link, the avatar situation, and the twelve gaps that motivate Waves 3, 4 and 9. |
| `re-docs/Backend Docs/Domain Spec/Agents.md:131`, `:147`, `:149`, `:161`, `:163` | The deny-by-default merge; the enforcement rule; the `agentGate.update` write rule; the `0027` journal failure mode; the no-enforcement observation. |
| `re-docs/Frontend Docs/Domain Spec/*.md`, `Feature and Flow Spec/*.md` | The canonical surfaces each wave updates in the same task. |
| `P0 Chat Core.md`, `P1 Navigation and Panels.md`, `P2 Rich Message Features.md`, `P3 Performance and Accessibility.md`, `P4 Settings, Threads and Authority.md` | The **41** item ids this sequence schedules, their areas and their acceptance criteria. |
| `packages/server/scripts/check-gates.mjs`, `check-events.mjs` | The two automated guards every wave must keep green: gate discipline and the broker-event contract. |
| `packages/server/package.json` (`"test": "vitest run"`), `packages/client/package.json` (`"test": "vitest run --passWithNoTests"`) | The test commands every wave runs before its review gate. |
| CrowdOS source at HEAD `e3fe5f5` | Every `file:line` cited above, re-read during authoring. |

**Wave-to-wave dependency verification.** The one-wave rule was checked against each breaking-change surface in the corpus:

| Breaking surface | Introduced in | Its consumers land in | Same wave? |
|---|---|---|---|
| `agents.avatar_path` (migration `0032`), `PUT` + `GET /api/agents/:id/avatar` | Wave 2 | Wave 2 | Yes |
| `workspace_roles` (migration `0033`), 5 routes, `roleGate` | Wave 3 | Wave 3 | Yes |
| `agents.role_id` (migration `0034`) | Wave 4 | Wave 4 | Yes |
| `channel_members` (migration `0035`) — **only if option (B) is approved** | Wave 8 | Wave 8 | Yes, conditionally |
| `GET /api/runs/:id/branch` | Wave 11 | Wave 11 | Yes |
| `agents.permissions` blob semantics | Wave 13 | Wave 13 | Yes |
| `message_reactions` (migration `0030`) + a new socket event | Wave 10 | Wave 10 | Yes |
| A windowing dependency | Wave 5 | Wave 5 | Yes |

## Gaps

- **The migration numbers are provisional against the P2 band.** The P2 document claims `0030_message_reactions.sql` and `0031_channel_pins.sql`; the P4 band therefore claims `0032`–`0035` — `0032_agents_avatar_path.sql`, `0033_workspace_roles.sql`, `0034_agents_role_id.sql` and `0035_channel_members.sql`. The folder ends at `0029_model_module_endpoint_thinking.sql`, so `0030`–`0035` is contiguous with no collision. If P2 renumbers, P4 renumbers with it. The allocation itself is `../Open Decisions.md` #14.
- **No wave exists for the `file:line` anchors.** The concurrent commit `e3fe5f5` touched the client. Every anchor in the P-documents was re-read against that HEAD and is correct as written, but a further commit to `WorkspaceSettingsModal.tsx`, `crowdOsStore.ts`, `crowdOs.ts` or `schema.ts` will move them. `../Open Decisions.md` #12 asks whether the anchors are re-verified before Wave 2.
- **The wave timings are not sized.** This sequence names waves, not durations. A wave's size is bounded by `AGENTS.md` §1.4 (about 800 changed lines, 500 for complex logic) and by the review gate's own cost — a wave that is too big to review in one sitting is the wrong size, whatever its estimate.
- **The Electron fuse configuration has no wave.** It is a packaging task, not a client wave, and it is routed to `../Open Decisions.md` #13. If it is approved, it gets its own wave **outside** this sequence, because it touches the build pipeline and not `packages/desktop`.
- **Crash reporting has no wave.** Discord's local minidump collection is a reference, not a plan. CrowdOS has no crash reporting today, and adding it is a new capability with its own privacy and upload decisions (`../Open Decisions.md` #13).
- **Option (B) of RE-P4-06 has no wave** unless `../Open Decisions.md` #7 is answered, because it needs a new user-facing verb (`AGENTS.md` §5.13).
- **The wave sizes are uneven.** Waves 5, 7 and 10 each carry seven to nine items and will need to be reviewed in more than one sitting or split by the operator. The sequence says what the order is; the split is the operator's call at the review gate.
- **`npm run check:docs` does not exist.** `AGENTS.md` §2 lists it as "TO BUILD". The docs-sync obligation is therefore discharged by editing the owning Domain Spec in the same task as the code, and the drift table in `../CrowdOS Understanding/Canon and Locked Rules.md` is the manual substitute. Once the script exists, it becomes the gate for every wave.

## User Decision:

## Target Contract

> Status: Target. This is the order of work. It is not a promise about dates, and it is not a place where a locked rule may be traded away.

* **The ground truth is fixed first.** Wave 0 corrects the documented drifts in the same task as the specs that cite them. No implementation wave starts against a guideline known to be wrong.
* **The measurement harness lands in Wave 1**, before every implementation wave, so that every later §12 claim is a measurement and not an assertion.
* **A breaking-change surface lands in exactly one wave, with its consumers.** A new socket event, a new shared type, a new migration, a new REST route and a new dependency are introduced in the same wave that introduces the code that uses them. No wave is half a story.
* **Two documents may touch one surface; the lower item id owns the behaviour.** The run-thread drawer and the roster each have two owners, and the sequence places them in different waves so they are never in flight at once.
* **A human reviews between every wave.** `AGENTS.md` §7: finish → checks → stop → the user reviews and tests → `commit?` → the next wave. No wave begins on the agent's judgement alone.
* **The security decision is last.** Permission-blob enforcement (Wave 13) touches the Router and the tool executor for every agent in every workspace, and it lands only after the harness, only after the windowing, and only after `../Open Decisions.md` #4 is answered. Its back-fill migration is a precondition, not a nicety.
* **Nothing is planned-and-pending without sign-off.** A new user-facing verb (the channel-membership write path), the Electron fuse configuration and crash reporting are all routed to `../Open Decisions.md` and none of them is built on inference (`AGENTS.md` §5.13).
* **The wave order may be changed only with a recorded reason.** The order is not sacred; it is the order in which each wave's acceptance criteria are checkable. If a wave is reordered, the `## Risks and blockers` table in the P4 spec is updated in the same task, with the new reason.
* **Each wave ends green.** `npm run typecheck`, `npm run lint`, `npm test` and the server's `npm run lint:gates` must pass before the review gate, and the owning Domain Spec must be updated in the same task (`AGENTS.md` §2, §6).

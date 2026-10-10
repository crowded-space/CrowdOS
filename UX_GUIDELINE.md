# CrowdOS UI/UX Guideline

> Normative design contract for the CrowdOS desktop client. Derived from UX_REPORT.md (deep dive) and CrowdOS.md (product model).
> Rules here are **locked** unless marked **[pending]**. When this doc conflicts with code, code wins — then this doc gets fixed in the same task.

---

## 1. Product model the UI must reflect

The UI is a control surface for these product facts. Never contradict them:

| Fact | UI consequence |
|---|---|
| Workspace = isolation boundary (like a Discord server) | No state leaks across workspaces; portal-first boot; one-click switching |
| Category groups Channels; Channel = session boundary | Sidebar mirrors Workspace → Category → Channel; never present Categories as folders |
| **History belongs to the Session; Memory belongs to the Agent** | Never blur the two in any memory/history UI |
| Mention routing: explicit `@Agent` wins → Active/pinned agent → default resolution Channel → Category → Workspace → `L0 + Default` | Composer mention chips and default-agent UI follow this chain |
| Multiple mention = same message fanned out to each agent, **serial** execution in shared context; not a Swarm | Multi-agent answers render as independent responses, comparable side-by-side |
| `lock_in` / `lock_out` = agent's private vs shared context view, channel stays shared | Show shared/private context indicator on agent surfaces |
| Runtimes: Conversational, Agentic, Coding, Research, Swarm + `Auto` (Router path, not a 6th runtime) | ModeSelector shows 6 entries; Auto shows resolved-to hint |
| Authority tiers L0–L3; Labels Raven (L0–L1, reasoning) / Crow (L2–L3, execution); Name (e.g. Owl) carries no authority | Roster grouped by tier; level chip on agents; authority never implied by name |
| Librarian/Owl = heartbeat indexing service, **not conversational** | Never offered as a chat target or default agent |
| Mounts: Workspace → Category → Channel override; override = **replace**, not merge; **NO VFS** | Effective-mount badge + source + why-tooltip everywhere a mount is visible |
| Local-first persistence (JSON + Markdown = truth); Postgres/pgvector optional, degrades gracefully | DB-offline is an amber degraded state, never a broken app |
| Theme (Crow/Crowd, Murder/Conspiracy) must never obscure what a component does | Thematic naming allowed only with plain-language function alongside |
| Murder/Conspiracy = prestige, non-priority, **L0-activated only** | Stay hidden until the L0 system completes; no dead buttons |

---

## 2. Design principles (all surfaces, no exceptions)

1. **One shell, stable slots.** Slots never reorder or swap meaning. A panel is addressed by a **named view enum** (`rightPanelView: roster | repo | jobs | telemetry`), never a boolean that flips meaning. No mode moves furniture.
2. **Command palette is the expert and accessibility path.** Ctrl/Cmd+K must reach verbs, not only search (see §7).
3. **Tri-state honesty.** Every panel renders skeleton / empty-with-next-action / error-with-cause-and-retry. Never blank, never fake, never eternal spinner. **No mock data anywhere, ever.**
4. **Ambient vs interruptive split.** Ambient = glanceable status (strip, badges, presence), zero interruption. Interruptive = inbox rows, toasts. Modal **only** for destructive/irreversible. Decision-relevant numbers (cost, context %) must be ambient during composition, not buried in a drawer.
5. **Scope before spend, reversibility after spend.** The composer is the spend commit — it must show the commit (preflight). Every Coding/Swarm run must be one-click undoable (checkpoint + Restore).
6. **Progressive disclosure.** Routine turns read in seconds: collapsed summary by default. Failure, approval, or explicit click expands. Full tool inputs/file contents behind a details affordance. Add stable **run headers** that survive scroll.
7. **Native citizenship.** Native file dialogs, tray, OS notifications with deep-links, global summon hotkey, staged updater that never loses drafts, complete keyboard access, offline as explicit mode with queued work.

---

## 3. Visual language — locked tokens

**Type:** Outfit (display) · Inter (UI) · JetBrains Mono (code/metadata).
**Colors:** canvas `#0B0B0C` · surface `#101012` · raised `#151517` · ink `#f4f4f5` · muted `#a1a1aa` · hairline `#232329` · accent indigo `#465EDB`.
**Light theme:** warm canvas `#FAF8F4` · white surface `#FFFFFF` · raised `#F3EFE7` · ink `#1A1917` · muted `#57534E` · faint `#6B665F` · hairline `#D7D1C5` · the same indigo accent.
**Shape:** circles only for status dots/knobs/glows. Radii: 2–4px badges/inputs/buttons · 6px cards · 8px modals (max). No rounded-full except dots.
**Motion:** 200ms settle · 150ms dialog fade · 1px composer lift · mention chip springs once · scrollbars invisible until hover (6px, 4px thin) · skeleton shimmer · grain overlay 0.05 · `prefers-reduced-motion` collapses all pulse/spring/shimmer to static.
**Motion budget [pending]:** one pulsing surface at a time during swarm; roster rows tick elapsed without pulse; mention pulses once on arrival; toasts max 3 stacked; approval pulses until decided.
**Density:** chat text 14–15px relaxed leading · metadata 11–12px mono (tokens/cost/hashes) · tree rows 22px / indent 12px · status strip 12px tabular numerals.
**Badge semantics (icon + text, never color-only):** indigo = runtime/active · emerald = success/L3 · rose = L1/destructive/mention · amber = degraded/pending approval/cancelled · cyan = L0 · violet = coding · fuchsia = research · sky = chat.
**Posture:** Claude-grade calm. Delegation confidence is the brand; visual noise reads as loss of control.

---

## 4. Shell layout — locked slot map

```
[Workspace rail 56px] [Channel nav 240–280px] [Center chat, fluid] [Right ops 260–320px]
                                             [Bottom artifact drawer]
                                             [Thin status strip]
```

- **Workspace rail:** icons, unread pills, mention badges, Add, Portal home. Selected = indigo rail.
- **Channel nav:** workspace header dropdown (Settings / Create Category / Copy ID / Leave-behind-confirm) · filter input · shared top-level + categorized channels with collapse + per-category create · personal favorites/recents section on top (never mutates shared tree) · rows with active rail, unread badge (cap 99+), **distinct approval-waiting badge**, draft italic preview, live-run affordance · bottom **live** operator identity (name, role chip, presence, lock, settings — never hardcoded).
- **Center chat:** header (hash name, topic, search, clear, Stop, mute, segmented control bound to `rightPanelView` enum) · stream · composer · status strip.
- **Right ops:** four named views (§6). Header tabs bind to the same enum so palette verbs, notifications, deep-links, and tests all name the view.
- **Below xl:** off-canvas nav (backdrop + Escape + selection-dismiss) and an **ops bottom sheet** (Jobs / Approvals / Repo) — ops are never fully hidden.

---

## 5. Center surfaces

### 5.1 Transcript (layered)
- Default simple: human bubbles amber editable · agent bubbles with level avatar, name, runtime chip, duration, tokens, cost in header · monologue collapsed · tool container collapsed with count+elapsed · code blocks collapse past 20 lines with copy · delegation cards compact, cost linked to ledger row · provider errors as cards with Retry + model switch + details.
- **Run cards:** each run renders as a compact index card (status, cost, Open thread/diff). Opened run = thread branch (parent prompt pinned, steps/tools/diffs/approvals in branch), final answer posts back to channel via explicit also-send; intermediate tool lines never post back. `[pending: ThreadDrawer graduation]`
- **Run header (active runs):** pinned, survives scroll/channel switch — step x of y, elapsed ticking, cost-so-far, Stop, logs tail.
- Streaming contract (locked): smooth follow when pinned near bottom · instant pin during tokens · Jump-to-present pill with missed count · anchored paging near top · rAF-throttled passive scroll · date/unread dividers.
- Disclosure tiers: collapsed summary (routine) → expanded (failure/approval/click) → full inputs behind details with copy. Never plain-render tool inputs where linkify could leak paths/secrets.

### 5.2 Composer (the spend commit)
- **Preflight line above Send** `[pending]`: runtime chip with Auto resolved-to hint · removable pinned-agent chips (with tier + tool scope) · mount short-path chip with source badge, click → Mounts inspector · context meter % with breakdown tooltip (history/files/memory) · write-scope chip (read/write/command + allowlist state) · cost hint · overflow warning that blocks/confirms before Send.
- Caps: 4000 chars (honest truncation warning) · 5MB/file · 10 files/message. Enter sends, Shift+Enter newlines, auto-grow to 160px. Attach menu + drag-drop + emoji + ModeSelector (6 modes, each with latency/cost/scope hint, keyboard cycling, cross-channel pin toggle with `aria-pressed`).
- **Drafts:** per-channel (text + attachments + mentions + runtime + mount snapshot), survive switch and restart, italic preview in sidebar. Offline sends queue with will-send copy, auto-send on reconnect. Never silent loss.
- **Queue, don't lock:** during a run the composer accepts follow-ups with applies-to scope (current run vs next turn).
- Mentions: at-word caret detection, Arrow/Tab/Enter/Escape nav, chips pinnable per channel.

### 5.3 Status strip `[pending]`
Thin strip adjacent to composer: runtime · pinned agent · mount short path · context % · tokens this channel · cost this run · degraded dots (ledger-offline / DB-degraded / provider-error). Every segment clickable to its source view. Never modal.
Cost visibility is tiered: micro in strip (ambient) · per-run in run header (after) · full ledger in Telemetry drawer (on demand).

---

## 6. Right ops panel — named views

Addressed by `rightPanelView` enum. **The current `rightSidebarOpen` boolean inversion (false=repo, true=roster) is a P0 defect to remove via codemod-only rename, before any feature builds on it.**

- **Roster:** L0–L3 tier groups (h2 + h3 headings) · per-row avatar, presence, level chip, OMNI tag · duration + cost + Stop at the presence site (agent presence is durational and costly, not a Discord dot) · shared/private context indicator for lock_in · click → profile modal + memory inspector (agent memory, kept separate from channel history).
- **Repo:** FileExplorer — locked metrics: **22px rows, 12px indent, 16px chevron gutter, 14px muted icons, flat full-width selection**, full ARIA tree (roving tabindex, Down/Up/Right/Left/Home/End/Enter/Space) · one effective root per channel from a single request · source badge (Channel/Category/Workspace mount, sandbox, not-mounted) with why-it-won tooltip · OPEN FOLDER native-dialog primary, manual path secondary · Clear only while a mount is set (returns to inheritance) · lazy cached tree, Refresh re-reads · amber notice for configured-but-unusable mounts, jail denial names allowed roots + Browse fix — never silent fallback · Zone A (L0 workspace local) read-only root, openable with L0 badge + no-save guard `[pending: root discriminator]`.
- **Jobs** `[pending]`: runs across channels — channel, agents, runtime, step, elapsed, tokens, cost, status, Stop/Pause/Resume/Retry, Jump to channel, Open diff, Open logs · filterable by status/channel/agent · resumable across restart · OS notification on completion/failure/approval when unfocused.
- **Telemetry:** Channel vs Global tabs (tab/tabpanel) · ledger-backed totals with honest offline note + local sums fallback · per-run cost rows linked from delegation cards · storage summary entry.

---

## 7. Palette, inbox, notifications, settings

**Palette (Ctrl/Cmd+K):** dual Search + Commands. Verb registry: switch channel/workspace, set/pin runtime, pin mention, mute, clear, mount folder, open diff, approve/deny, retry, cancel, open storage/diagnostics, lock screen, open inbox. Each verb shows shortcut, scope, and risk. Recent verbs first, context-scoped to active channel. Full ARIA listbox. Fuzzy match, 200ms debounce on server results.

**Operations Inbox** `[pending]`: cross-channel queue of approvals, failures, mentions (user/L0), provider errors, degraded flags. Rows deep-link to channel + run with inline Approve/Retry/Jump and Later defer. Approval badge is distinct from mention badge (sidebar, rail, tray, status strip). OS notifications with deep-links for approval/failure/mention; DND schedule; tray badge count. Toasts: max 3 stacked, quiet info vs assertive error, persisted for need-me events.

**Capture tier** `[pending]`: global summon hotkey → floating quick-ask defaulting to current channel scope + L0, scope line showing where the answer lands and what it can touch, Enter asks in place, Shift+Enter expands to full window. Per-channel empty states teach with 4 one-click suggestion cards (Ask L0 / Run research / Review diff / Mount folder).

**Settings modal:** left nav — Overview, Channels, Agents, Models, Mounts, Safety, Storage, Diagnostics, Audit. Explicit unsaved-changes bar (Save/Reset) · effective-value preview per scope · **Mounts inspector: Workspace vs Category vs Channel values side by side with winner highlighted, Clear + Browse per level** · retention/DLP banners where relevant · published shortcut list · Copy diagnostics bundle. Storage tab: per-workspace bytes (history/artifacts/embeddings/cache) + Clear cache + Vacuum + Reindex + Verify + Export. Audit tab: filterable events (approvals, mount changes, model changes, restores) with actor/time/scope + export.

**Offline center:** lists works-now vs waits, queued sends with will-send copy, Retry + Go-offline toggle.

---

## 8. Files, diffs, checkpoints — the reversibility loop

- Open = **preview vs pinned** (peek vs keep) distinction for files and tabs.
- Every Coding and Swarm run opens with a **checkpoint row**: snapshot time, files-touched list, diff count, **Restore run** button `[pending]`, single busy lock shared with DiffViewer, restore audited.
- DiffViewer: unified + side-by-side · per-hunk explanation · per-file Apply/Revert + Apply all · single busy lock.
- Sandbox editor: docked min/dock/full measured from live DOM, dirty-revert-save footer; bottom drawer (file/diff/log tabs, resizable, remembered per workspace) is the multi-file home — dock stays default.
- Artifact versions backlinked to the producing run, with Copy/Download.
- Destructive paths always confirm with scope preview: Clear mount (shows resulting effective change) · Restore run (lists files) · Clear history (explicit confirm + retention notice) · Leave workspace.

---

## 9. Message provenance rules

- **Edit = new turn** with edited-from link. Never silent rewrite.
- **Regenerate (same context) vs Retry (fresh run)** labeled explicitly.
- Secret-pattern redaction in message rendering and tool execution views, with shown-as-redacted notice and reveal behind click.
- Delegation cost links to its ledger row.

---

## 10. Honesty rules (trust is a feature)

1. **No mock data.** Mock recents, fake totals, hardcoded identity (e.g. placeholder operator block) are P0/P1 defects. Every value traces to a source or the surface says so.
2. Degraded states are explicit and specific: DB offline card with Retry + Edit settings · ledger offline note with local totals · provider error card with Retry + model switch · amber mount notices. App stays operational (local-first).
3. Approval cards must show: risk badge, command echo, cwd, file list, tool scope, allowlist state. Grant / Deny / Grant-for-session.
4. Instrumentation: counts and latencies only — never message content, file contents, secrets, or memory writes. If no surface shows a metric, drop it.

---

## 11. Accessibility & OS citizenship gates

- **Keyboard complete:** every verb, switch, mount, diff, approve, cancel reachable without pointer. Visible focus rings, skip-to-chat link.
- **Screen reader:** landmarks (nav/main/ops/status) · tree/listbox/tabs ARIA as specced · live regions for streaming, approval arrival, job completion · never color-only badges.
- **Reduced motion:** collapses everything to static; swarm shows one static progress header.
- **Contrast:** AA on all rendered surfaces, verified by sampler.
- **Native:** OS open-folder dialog primary · tray (Show/Pause/Lock/Recent) · summon works unfocused · notifications deep-link · updater never loses drafts.

---

## 12. Performance budgets (locked numbers)

| Metric | Budget |
|---|---|
| Cold start → interactive shell | < 2.5s warm disk / < 4s cold (mid Windows laptop); overlay modals stay lazy, out of initial bundle |
| Channel switch | < 150ms rail + cached history / < 600ms full + tree root; never loses either channel's draft |
| Streaming | instant pin during tokens; missed-count pill within one frame; rAF-throttled passive scroll |
| Tree expand | < 200ms cached / < 800ms first fetch with spinner |
| Palette | < 50ms per keystroke local; 200ms debounce server |
| Lists | virtualize past 500 channels / 2,000 messages; token append updates tail only |
| Renderer memory | < 600MB with 10k messages + 1k cached files |
| Ledger poll | 30s, workspace-scoped, never blocks send; status strip ticks ≤ 1/s |

Violations surface in Diagnostics, not silent jank.

---

## 13. Priorities and build order

**Locked strengths — extend, never churn:** slot-stable three-panel shell with portal gate · VSCode-grade tree · chat liveness scroll contract · mention routing · safety seeds (ApprovalCard, DiffViewer, ToolExecutionMessage, mount warnings, ledger honesty) · design tokens.

| Phase | Content | Closes |
|---|---|---|
| **A (P0, first, smallest review)** | Codemod rename `rightSidebarOpen` → `rightPanelView` enum (roster/repo, behavior-identical) + **delete mock recents** (real recents query or remove with honest empty copy) | G4.2.1, G4.2.5 |
| **B (P0)** | Composer preflight + context meter + ModeSelector hints + Mounts inspector entry | G4.2.2 |
| **C (P0)** | Checkpoint + Restore, per-hunk review, bottom drawer tabs | G4.2.3 |
| **D (P0/P1)** | Operations Inbox + Jobs view + ambient status strip + OS notifications | G4.2.4, G4.3.1, G4.3.5 |
| **E (P1)** | Run Threads + drafts persistence + palette verbs | G4.3.2–4 |
| **F (P1)** | Live operator identity, Zone A openable, Mounts inspector, provenance (edit/retry/redaction/retention) | G4.3.6–8 |
| **G (P2)** | Personal nav, Storage/Diagnostics/Audit, notification center, capture tier, motion budget, narrow ops sheet | all P2 |

Ground rules: renames ship alone (codemod-only, no features hidden inside) · code + docs sync in the same task · each phase ends with checks, live review, explicit commit question.

**What NOT to build:** VSCode-style extension marketplace (tools stay agent-executed with approvals/audit) · Discord gifts/stickers/game activity · Slack canvas proliferation · ChatGPT flat-billing cost invisibility · Claude global-memory blur · Steam store/community tabs. Multi-mention fan-out, cost attribution, offline queue, and side-by-side comparison stay.

---

## 14. Open decisions (need user sign-off before the related phase)

1. Single-user local shell vs multi-operator roadmap (shapes identity/audit/personal-nav design).
2. Tier + tool-scope visibility on agent chips; L0 distinct summon/badge — confirm copy.
3. Murder/Conspiracy: hidden until L0 completes (assumed) vs disabled prestige entries.
4. Write-scope default: assumed read-allow under mount, per-run Grant for writes, allowlist for commands.
5. Budget caps: warn + confirm (no hard block) until Phase G; thresholds TBD.
6. Retention/redaction/export defaults; whether memory writes share channel retention.
7. Narrow-width target: desktop + half-screen (no phone layout).
8. Updater: silent staged vs release-notes-gated for enterprise IT.
9. Phase order A–G approval before any code task.

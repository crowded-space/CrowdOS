# Canon and Locked Rules

> Type: Reference — Status: observed — Updated: 2026-10-21

CrowdOS as-built understanding, written as the corpus guardrail: what is already built and locked in CrowdOS, and therefore what a Discord-derived proposal may and may not change. Canonical CrowdOS documentation remains `re-docs/Frontend Docs/`; the normative contract is `UX_GUIDELINE.md`.

## Purpose

CrowdOS is canon. Every Discord-derived proposal is **additive**: it may fill a CrowdOS gap, but it never removes or replaces a CrowdOS surface, and where the two conflict the CrowdOS locked rule wins and the conflict is recorded rather than silently applied.

This file is the checklist a reviewer applies to any proposed change to the CrowdOS desktop client. It names each existing behaviour, where it is implemented, which canonical document owns it, and the "must-not-do" that a change must not break. It is deliberately exhaustive: the cost of a missing row is a silent regression in a product that treats its UI contract as a feature.

## How it works

The rule is a three-part test applied to any proposal:

1. **Does CrowdOS already have this?** If yes, the Discord pattern is a re-skin, not an addition — it is rejected or reduced to a detail that fills a gap.
2. **Does the Discord pattern fill a CrowdOS gap?** If yes, it is adopted additively, inside the existing slot and using CrowdOS's own vocabulary and data model.
3. **Does the Discord pattern conflict with a locked CrowdOS rule?** If yes, CrowdOS wins, and the conflict is written down in the `## Gaps` section of this file (or in the relevant flow doc) instead of being applied.

The locked rules live in two places. `UX_GUIDELINE.md` is the normative contract ("Rules here are **locked** unless marked **[pending]**", `UX_GUIDELINE.md:4`), and the `re-docs/Frontend Docs/` Domain and Flow specs record how each rule was actually implemented. Where the guideline and the code disagree, the code wins and the guideline is fixed in the same task (`UX_GUIDELINE.md:4`). This file records both the rule and whether it is currently met.

## Structural inventory

| # | Existing CrowdOS behaviour | Where implemented (file:line) | Doc reference | Must-not-do |
|---|---|---|---|---|
| 1 | Slot-stable three-panel shell: nav / center chat / right ops | `packages/client/src/App.tsx:205`, `:216`, `:244` | `UX_GUIDELINE.md:32`, `:56-68` | Never reorder or swap the meaning of a slot |
| 2 | Two named center-column slots: `bottom-drawer`, `ops-sheet` | `packages/client/src/App.tsx:225`, `:235` | `re-docs/Frontend Docs/Domain Spec/Workspace Shell.md:32-33` | Never move a slot out of the center column |
| 3 | Workspace→Category→Channel nav; categories are groups, not folders | `packages/client/components/workspace/WorkspaceSidebar.tsx:24`, `:136-156` | `UX_GUIDELINE.md:15` | Never present Categories as folders |
| 4 | Personal favorites / recents overlay that never mutates the shared tree | `WorkspaceSidebar.tsx:65-89`, `:136-156` | `UX_GUIDELINE.md:65` | Never write favorites into the shared channel tree |
| 5 | `rightPanelView` is a 5-value enum (`roster\|repo\|jobs\|telemetry\|browser`) | `packages/client/types/crowdOs.ts:323`; `MainChatArea.tsx:942-1003` | `UX_GUIDELINE.md:32` | Never replace the enum with a boolean |
| 6 | Header tab strip is bound to that enum with `aria-selected` / `aria-controls` | `MainChatArea.tsx:942-1003`; `RightSidebar.tsx:270`, `:348` | `UX_GUIDELINE.md:67` | Never add a header control that addresses a panel by a second mechanism |
| 7 | Ops bottom sheet below `xl`; the `Ops` trigger always renders | `packages/client/src/App.tsx:235`; `workspace/OperationsSheet.tsx` | `UX_GUIDELINE.md:68` | Never fully hide operations |
| 8 | Bottom artifact drawer with file/diff/log tabs, remembered per workspace | `App.tsx:225`; `workspace/BottomDrawer.tsx` | `UX_GUIDELINE.md:60`, `:124` | Never dock the drawer outside the center column |
| 9 | Channel header owns name, topic, search, clear, Stop, bell, panel tabs | `MainChatArea.tsx:860-1005` | `UX_GUIDELINE.md:66` | Never move a header action into the composer |
| 10 | Six message types behind one router | `workspace/messages/MessageRouter.tsx:17-233`; `types/crowdOs.ts:27` | `UX_GUIDELINE.md:75` | Never add a seventh type without a canonical spec row |
| 11 | Tool executions fold into the parent agent bubble (forward and backward) | `MainChatArea.tsx:706-729` | `UX_GUIDELINE.md:76` | Never interleave tool rows as separate transcript entries |
| 12 | Burst grouping: same author, under 300 s, with a fixed exclusion list | `MainChatArea.tsx:799-817` | `re-docs/.../Message rendering.md:19` | Never group across a day change or across excluded types |
| 13 | Day divider from the real message timestamp | `MainChatArea.tsx:35-53`, `:787-795` | `UX_GUIDELINE.md:78` | Never open a divider on a fabricated timestamp |
| 14 | Unread divider deliberately unrendered (no honest last-read anchor) | `MainChatArea.tsx:68-84`; `stores/crowdOsStore.ts:2860-2879` | `re-docs/.../Chat Area.md:36` | Never fabricate an unread marker |
| 15 | Streaming caret plus memoized completed blocks, one pending tail | `workspace/messages/MentionParser.tsx:233-268`; `messages/streaming-blocks.ts:39-57` | `UX_GUIDELINE.md:78` | Never re-render settled blocks per flush |
| 16 | Follow/pin contract: wheel/touch intent, instant pin, smooth resume | `workspace/messages/use-stick-to-bottom.ts:5`, `:30-49` | `UX_GUIDELINE.md:78` | Never yank a scrolled-up reader |
| 17 | Prepended history never jumps and never increments the missed count | `MainChatArea.tsx:464-480` | `UX_GUIDELINE.md:78` | Never jump on a prepend |
| 18 | Approval cards keep their risk badge and terminal status after a decision; pending approvals render above the transcript | `workspace/messages/ApprovalCard.tsx:31`, `:55-56`, `:70-71`, `:112`; `MainChatArea.tsx:1074-1076` | `UX_GUIDELINE.md:143` | Never make a decided card disappear; never bury a pending approval below the messages |
| 19 | Run cards are compact index entries; delegation cost links to the telemetry view | `MainChatArea.tsx:1109-1127`; `workspace/messages/DelegationMessage.tsx:17-19`, `:78-90` | `UX_GUIDELINE.md:76`, `:135` | Never render a cost number without a ledger source |
| 20 | Pinned run header for the active run, surviving scroll | `MainChatArea.tsx:1053-1057`; `workspace/RunHeader.tsx` | `UX_GUIDELINE.md:77` | Never let the run header scroll away |
| 21 | Checkpoint row with Restore, a file-scope preview and an audit line | `workspace/CheckpointRow.tsx:20-32`, `:59-66` | `UX_GUIDELINE.md:122`, `:126` | Never restore without showing the file scope |
| 22 | One shared busy lock across checkpoint restore, diff apply and the drawer | `workspace/DiffViewer.tsx:189-193`, `:214`; `CheckpointRow.tsx:31`, `:60` | `UX_GUIDELINE.md:122-123` | Never allow two mutators at once |
| 23 | Operations inbox: approval badge and mention badge are distinct and icon+text | `workspace/OperationsInbox.tsx:2`, `:48-64` | `UX_GUIDELINE.md:109`, `:51` | Never distinguish by colour alone |
| 24 | Jobs view has Stop and Retry; no Pause | `workspace/JobsView.tsx:8-11`, `:46-49` | `UX_GUIDELINE.md:100` | Never add Pause without a server endpoint |
| 25 | Roster grouped by tier L0→L3; Owl/librarian excluded from the roster | `workspace/RightSidebar.tsx:21-23`, `:177-182`, `:359-374` | `UX_GUIDELINE.md:21`, `:98` | Never imply authority from a name or species label |
| 26 | Telemetry is honest: unknown sources render empty, never fabricated | `workspace/StatusStrip.tsx:73`; `composer-preflight-model.ts:30-57` | `UX_GUIDELINE.md:141`, `:89` | Never invent a metric to fill a segment |
| 27 | File explorer: locked row metrics and a full ARIA tree with roving tabindex | `workspace/FileExplorer.tsx:124-130`, `:324` | `UX_GUIDELINE.md:99` | Never ship a tree without the ARIA contract |
| 28 | Browser panel: credentials are entered by the operator, never by the agent | `workspace/BrowserPanel.tsx:133` | `UX_GUIDELINE.md:10` | Never route credentials to an agent |
| 29 | Run threads live in the Threads surface, not in ad-hoc per-message threads | `workspace/ThreadDrawer.tsx`; `MainChatArea.tsx:1667-1674` | `UX_GUIDELINE.md:76` | Never add a second thread model |
| 30 | Composer caps: 4000 chars, 5 MB per file, 10 files per message | `MainChatArea.tsx:128-130`, `:303-332` | `UX_GUIDELINE.md:83` | Never exceed a cap silently |
| 31 | Over-limit sends are confirmed, never silently truncated | `MainChatArea.tsx:568-573`, `:1027-1037` | `UX_GUIDELINE.md:83` | Never hard-block without an explicit reason |
| 32 | Per-channel drafts, 500 ms debounce, attachments excluded | `MainChatArea.tsx:243-269`; `crowdOsStore.ts:4027-4044` | `UX_GUIDELINE.md:84` | Never lose a draft on a channel switch |
| 33 | Offline outbox: queued sends with will-send copy, ordered flush on reconnect | `MainChatArea.tsx:554-562`; `crowdOsStore.ts:4061-4114` | `UX_GUIDELINE.md:38`, `:84` | Never drop a queued send |
| 34 | Mention chips are the routing source of truth; send prefixes `@name` | `MainChatArea.tsx:577-589` | `UX_GUIDELINE.md:17` | Never route from the visible prose alone |
| 35 | Six composer modes with a per-channel, server-persisted pin | `workspace/ModeSelector.tsx:24-33`; `crowdOsStore.ts:2045-2074`, `:2081-2111` | `UX_GUIDELINE.md:20`, `:83` | Never send the composer mode name to the runtime endpoint |
| 36 | Follow-up scope toggle (current run / next turn) instead of locking the composer | `MainChatArea.tsx:1542-1557`; `crowdOsStore.ts:4126-4132` | `UX_GUIDELINE.md:85` | Never disable the composer during a run |
| 37 | Exactly one status line above the textarea; props-only, never modal | `workspace/StatusStrip.tsx:36-49`, `:73-75`; `MainChatArea.tsx:1499-1515` | `UX_GUIDELINE.md:89-90` | Never add a second preflight row |
| 38 | Notification centre with a DND schedule that gates the badge only | `components/ui/NotificationCenter.tsx:11-12`, `:106-107` | `UX_GUIDELINE.md:109` | Never drop history while DND is active |
| 39 | Command palette reaches verbs, each with shortcut, scope and risk | `workspace/modals/palette-verbs.ts:7-15`, `:83-98` | `UX_GUIDELINE.md:33`, `:107` | Never ship a search-only palette |
| 40 | Screen lock is non-dismissible: Escape is ignored, only a PIN exits | `components/lockscreen/LockScreen.tsx:7`, `:38-39` | `UX_GUIDELINE.md:154` | Never let Escape dismiss the lock |
| 41 | Portal-first boot: the workspace portal is the entry surface | `components/portal/WorkspacePortal.tsx:54`, `:156`, `:294`; `App.tsx:169-171` | `UX_GUIDELINE.md:14` | Never boot straight into a channel |
| 42 | Deep links jump to a channel; run/inbox targets are never invented | `crowdOsStore.ts:117`; `src/config/deep-link.ts:14-21` | `UX_GUIDELINE.md:117` | Never fabricate a deep-link target |
| 43 | ARIA affordances already present: tree, listbox, tabs, live regions, badge text | `FileExplorer.tsx:324`; `ModeSelector.tsx:120-125`; `MainChatArea.tsx:1340-1358`; `ui/ToastProvider.tsx:98-99` | `UX_GUIDELINE.md:151` | Never regress an existing ARIA contract |
| 44 | Per-panel error boundaries around every mounted panel | `App.tsx:169`, `:209`, `:216`, `:226`, `:236`, `:244` | `re-docs/.../Workspace Shell.md` | Never let one panel failure blank the shell |
| 45 | Offline banner: works-now vs waits, queued sends with will-send copy | `components/ui/OfflineBanner.tsx:15-44` | `UX_GUIDELINE.md:115` | Never render a blank offline state |
| 46 | Reconnect digest names what happened while away | `crowdOsStore.ts:946-958`; `MainChatArea.tsx:1058-1068` | `UX_GUIDELINE.md:109` | Never silently swallow a gap |
| 47 | Theme cycle with plain-language names and no hidden control | `components/ui/ThemeToggle.tsx:33-38` | `UX_GUIDELINE.md:25` | Never obscure what a component does |
| 48 | Design tokens are the only source of visual constants | `UX_GUIDELINE.md:42-52` | `UX_GUIDELINE.md:42-52` | Never introduce an off-token value |
| 49 | Local-first: a degraded backend is an amber state, not a broken app | `UX_GUIDELINE.md:24`, `:142` | `UX_GUIDELINE.md:24` | Never make the app unusable when Postgres is down |
| 50 | Workspace is the isolation boundary for state | `crowdOsStore.ts:1114`, `:1196` (`isForeignWorkspacePayload`) | `UX_GUIDELINE.md:14` | Never leak state across workspaces |

## Implementation details

### Locked rules — shell slot map

- "One shell, stable slots. Slots never reorder or swap meaning. A panel is addressed by a **named view enum** (`rightPanelView: roster | repo | jobs | telemetry`), never a boolean that flips meaning." (`UX_GUIDELINE.md:32`) · "Center chat: header (hash name, topic, search, clear, Stop, mute, segmented control bound to `rightPanelView` enum) · stream · composer · status strip." (`UX_GUIDELINE.md:66`)
- "Below xl: off-canvas nav (backdrop + Escape + selection-dismiss) and an **ops bottom sheet** (Jobs / Approvals / Repo) — ops are never fully hidden." (`UX_GUIDELINE.md:68`)

### Locked rules — transcript

- "Streaming contract (locked): smooth follow when pinned near bottom · instant pin during tokens · Jump-to-present pill with missed count · anchored paging near top · rAF-throttled passive scroll · date/unread dividers." (`UX_GUIDELINE.md:78`)
- "**Run cards:** each run renders as a compact index card (status, cost, Open thread/diff)." (`UX_GUIDELINE.md:76`) · "**Run header (active runs):** pinned, survives scroll/channel switch — step x of y, elapsed ticking, cost-so-far, Stop, logs tail." (`UX_GUIDELINE.md:77`)
- "Disclosure tiers: collapsed summary (routine) → expanded (failure/approval/click) → full inputs behind details with copy. Never plain-render tool inputs where linkify could leak paths/secrets." (`UX_GUIDELINE.md:79`)

### Locked rules — composer

- "Caps: 4000 chars (honest truncation warning) · 5MB/file · 10 files/message. Enter sends, Shift+Enter newlines, auto-grow to 160px." (`UX_GUIDELINE.md:83`)
- "**Drafts:** per-channel (text + attachments + mentions + runtime + mount snapshot), survive switch and restart, italic preview in sidebar." (`UX_GUIDELINE.md:84`) · "**Queue, don't lock:** during a run the composer accepts follow-ups with applies-to scope (current run vs next turn)." (`UX_GUIDELINE.md:85`)
- "Mentions: at-word caret detection, Arrow/Tab/Enter/Escape nav, chips pinnable per channel." (`UX_GUIDELINE.md:86`)

### Locked rules — right panel

- "**Roster:** L0–L3 tier groups (h2 + h3 headings) … duration + cost + Stop at the presence site (agent presence is durational and costly, not a Discord dot)." (`UX_GUIDELINE.md:98`) · "**Telemetry:** Channel vs Global tabs (tab/tabpanel) · ledger-backed totals with honest offline note + local sums fallback." (`UX_GUIDELINE.md:101`)
- "**Repo:** FileExplorer — locked metrics … full ARIA tree (roving tabindex, Down/Up/Right/Left/Home/End/Enter/Space) · one effective root per channel from a single request." (`UX_GUIDELINE.md:99`)

### Locked rules — palette, inbox, settings

- "**Palette (Ctrl/Cmd+K):** dual Search + Commands … Each verb shows shortcut, scope, and risk." (`UX_GUIDELINE.md:107`) · "**Operations Inbox:** cross-channel queue of approvals, failures, mentions (user/L0), provider errors, degraded flags." (`UX_GUIDELINE.md:109`)
- "Toasts: max 3 stacked, quiet info vs assertive error, persisted for need-me events." (`UX_GUIDELINE.md:109`)

### Locked rules — files, diffs, checkpoints

- "Every Coding and Swarm run opens with a **checkpoint row**: snapshot time, files-touched list, diff count, **Restore run** button, single busy lock shared with DiffViewer, restore audited." (`UX_GUIDELINE.md:122`) · "DiffViewer: unified + side-by-side · per-hunk explanation · per-file Apply/Revert + Apply all · single busy lock." (`UX_GUIDELINE.md:123`)
- "Destructive paths always confirm with scope preview: Clear mount (shows resulting effective change) · Restore run (lists files) · Clear history (explicit confirm + retention notice) · Leave workspace." (`UX_GUIDELINE.md:126`)

### Locked rules — provenance

- "**Edit = new turn** with edited-from link. Never silent rewrite." (`UX_GUIDELINE.md:132`) · "**Regenerate (same context) vs Retry (fresh run)** labeled explicitly." (`UX_GUIDELINE.md:133`)
- "Secret-pattern redaction in message rendering and tool execution views, with shown-as-redacted notice and reveal behind click." (`UX_GUIDELINE.md:134`)

### Locked rules — honesty

- "**No mock data.** Mock recents, fake totals, hardcoded identity … are P0/P1 defects." (`UX_GUIDELINE.md:141`) · "Approval cards must show: risk badge, command echo, cwd, file list, tool scope, allowlist state." (`UX_GUIDELINE.md:143`)
- "Instrumentation: counts and latencies only — never message content, file contents, secrets, or memory writes." (`UX_GUIDELINE.md:144`)

### Locked rules — a11y and OS citizenship

- "**Keyboard complete:** every verb, switch, mount, diff, approve, cancel reachable without pointer." (`UX_GUIDELINE.md:150`) · "**Screen reader:** landmarks (nav/main/ops/status) · tree/listbox/tabs ARIA as specced · live regions for streaming, approval arrival, job completion · never color-only badges." (`UX_GUIDELINE.md:151`)
- "**Native:** OS open-folder dialog primary · tray · summon works unfocused · notifications deep-link · updater never loses drafts." (`UX_GUIDELINE.md:154`)

### Locked rules — motion and visual tokens

- "Type: Outfit (display) · Inter (UI) · JetBrains Mono (code/metadata)." · "Motion: 200ms settle · 150ms dialog fade · 1px composer lift … `prefers-reduced-motion` collapses all pulse/spring/shimmer to static." (`UX_GUIDELINE.md:44`, `:48`)
- "**Badge semantics (icon + text, never color-only).**" · "**Posture:** Claude-grade calm. Delegation confidence is the brand; visual noise reads as loss of control." (`UX_GUIDELINE.md:51`, `:52`)

### Locked performance budget (`UX_GUIDELINE.md:158-171`, verbatim)

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

"Violations surface in Diagnostics, not silent jank." (`UX_GUIDELINE.md:171`)

### Locked strengths (`UX_GUIDELINE.md:177`, verbatim)

"Locked strengths — extend, never churn: slot-stable three-panel shell with portal gate · VSCode-grade tree · chat liveness scroll contract · mention routing · safety seeds (ApprovalCard, DiffViewer, ToolExecutionMessage, mount warnings, ledger honesty) · design tokens."

### The nine `[pending]` items in `UX_GUIDELINE.md` and what each would cost

| Line | Item | Current state | Cost to adopt |
|---|---|---|---|
| `:49` | Motion budget | Not enforced; pulse sites are per-component | A shared pulse-arbiter across swarm, roster, mentions, toasts and approvals |
| `:76` | ThreadDrawer graduation | ThreadDrawer exists with parent prompt + steps (`workspace/ThreadDrawer.tsx`) | Promoting it to the canonical run-thread surface, incl. `also-send` back to the channel |
| `:82` | Preflight line above Send | Absorbed into `StatusStrip` (`MainChatArea.tsx:1499-1515`) | Re-introducing a second row would break the single-status-line rule |
| `:88` | Status strip | Built (`workspace/StatusStrip.tsx`) | Wiring real context %, token and cost sources to fill its empty segments |
| `:99` | Zone A root discriminator | The FileExplorer shows a source badge but no Zone A / L0 root discriminator | A real root-type signal from the server plus a read-only guard |
| `:100` | Jobs view | Built (`workspace/JobsView.tsx`) | Cross-restart resumability and OS notifications on completion/failure/approval |
| `:109` | Operations Inbox | Built (`workspace/OperationsInbox.tsx`) | Server-side deferral (Today is local-only) and OS notifications with deep links |
| `:111` | Capture tier | Quick-ask panel built (`workspace/QuickAsk.tsx`) | Global hotkey registration and the floating-window scope contract |
| `:122` | Restore run button | Built (`workspace/CheckpointRow.tsx`) | Server-side restore with an audited ledger row |

### Thirteen known doc-drift items

| # | Drift | Where | Correction needed |
|---|---|---|---|
| 1 | `UX_GUIDELINE.md:96` still describes a `rightSidebarOpen` boolean inversion as a live P0 defect | `UX_GUIDELINE.md:96` | The boolean is gone; the enum replaced it (`types/crowdOs.ts:323`) |
| 2 | `UX_GUIDELINE.md:32` lists 4 right-panel views | `UX_GUIDELINE.md:32` | The code has 5 — `browser` was added (`types/crowdOs.ts:323`, `RightSidebar.tsx:260`) |
| 3 | `UX_GUIDELINE.md:59` shows a "[Workspace rail 56px]" slot | `UX_GUIDELINE.md:59` | No 56 px rail exists; the left panel is `clamp(240px,20vw,280px)` at `xl+` and a drawer below (`App.tsx:205`) |
| 4 | "Restore run button `[pending]`" | `UX_GUIDELINE.md:122` | Built with a scope preview (`CheckpointRow.tsx:59-66`) |
| 5 | "**Jobs** `[pending]`" | `UX_GUIDELINE.md:100` | Built (`JobsView.tsx`) |
| 6 | "**Operations Inbox** `[pending]`" | `UX_GUIDELINE.md:109` | Built (`OperationsInbox.tsx`) |
| 7 | "**Capture tier** `[pending]`" | `UX_GUIDELINE.md:111` | Quick-ask built (`QuickAsk.tsx`) |
| 8 | "### 5.3 Status strip `[pending]`" | `UX_GUIDELINE.md:88` | Built (`StatusStrip.tsx`) |
| 9 | The "Preflight line above Send `[pending]`" | `UX_GUIDELINE.md:82` | Folded into `StatusStrip`; a second row would contradict the single-line rule |
| 10 | The list virtualization budget is locked but unmet | `UX_GUIDELINE.md:167` vs `packages/client/package.json:15-26` | Add windowing, or amend the budget — one of the two must change |
| 11 | `Send-message flow.md:13` claims the send records `user-01` / `Juan Hamzah` | `re-docs/Frontend Docs/Feature and Flow Spec/Send-message flow.md:13` | The code uses `local-operator` + `loadOperatorProfile()` (`MainChatArea.tsx:604`, `crowdOsStore.ts:2974-2979`); the name survives only as a render-side alias (`MentionParser.tsx:25-27`) |
| 12 | `Workspace Shell.md` contradicts itself on the mode count | `re-docs/Frontend Docs/Domain Spec/Workspace Shell.md:26-27` vs `:29-30` | Lines 26-27 list 5 modes, lines 29-30 list 6; the code has 6 (`ModeSelector.tsx:24-33`) |
| 13 | Light-theme WCAG AA claims are asserted in prose, not verified by a sampler | `re-docs/Frontend Docs/Domain Spec/Chat Area.md:20` vs `UX_GUIDELINE.md:153` | "AA on all rendered surfaces, verified by sampler" needs an actual sampler run |

## Interaction model

Sixteen Discord patterns most likely to be proposed for CrowdOS, each checked against the code and the guideline. Every row states what CrowdOS does instead.

| # | Discord pattern | CrowdOS locked rule that resists it | Rule file:line | What "additive" means here |
|---|---|---|---|---|
| 1 | Guild rail as the primary navigation | Slot-stable three-panel shell; slots never reorder | `UX_GUIDELINE.md:32`, `:56-62` | A rail may only be a workspace switcher inside the existing nav slot; it may not replace the channel nav |
| 2 | Member list as the right panel | `rightPanelView` is a named 5-value enum; the roster is grouped by tier | `UX_GUIDELINE.md:32`, `:98` | A new right surface is a 6th enum value, never a re-skin of the roster |
| 3 | Presence dot as a cheap presence signal | Agent presence is durational and costly, not a Discord dot | `UX_GUIDELINE.md:98` | Any presence affordance must carry duration/cost, or reuse the existing roster rows |
| 4 | Per-message hover timestamps | Provenance contract: edited-from link, regenerate vs retry, redaction reveal | `UX_GUIDELINE.md:132-134` | Timestamps may become hover-reveal; the provenance links must survive the change |
| 5 | Per-message threads | Run threads live in the Threads surface with a pinned parent prompt | `UX_GUIDELINE.md:76` | A thread affordance must reuse `ThreadDrawer`/the Threads domain, not create a second thread model |
| 6 | Dense chrome on every row | Progressive disclosure: collapsed summary by default | `UX_GUIDELINE.md:37`, `:79` | New affordances mount hidden and reveal on hover/focus, as the current hover toolbar does |
| 7 | Red unread dot | Icon+text badge semantics; approval-waiting must stay a distinct badge | `UX_GUIDELINE.md:51`, `:109` | Unread becomes an icon+count badge; the amber approval badge may not be merged into it |
| 8 | Always-visible per-row action buttons | Progressive disclosure plus the hover/focus toolbar | `UX_GUIDELINE.md:37`; `HumanMessage.tsx:107-118` | New row actions follow the hover-reveal pattern, never permanently occupying the row |
| 9 | Emoji-only reactions | Mention chips are the routing source of truth | `UX_GUIDELINE.md:17`; `MainChatArea.tsx:585-589` | Reactions may be display-only; they may not become a routing mechanism |
| 10 | Per-server mute toggles | `crowdos_muted_channels` map plus a DND schedule | `MainChatArea.tsx:203-221`, `:666-684`; `NotificationCenter.tsx:11-12` | A mute scope change is additive only if it reuses the local map and the DND schedule |
| 11 | Pinned messages | Sticky mention state and the favorites overlay | `MainChatArea.tsx:236`; `WorkspaceSidebar.tsx:65-89` | A new pin surface may not reuse sticky mentions or favorites as its backing store |
| 12 | Slow mode as a silent hard block | Confirmed-overflow path; budget caps warn and confirm | `UX_GUIDELINE.md:83`, `:201` | Any throttle must be an explicit, announced confirm — never a silent block |
| 13 | Channel categories as folders | "never present Categories as folders" | `UX_GUIDELINE.md:15` | No folder nesting in the channel tree, ever |
| 14 | Palette split into search and commands | Verb registry with shortcut, scope and risk; the palette must reach verbs | `UX_GUIDELINE.md:33`, `:107`; `palette-verbs.ts:83-98` | New verbs register in the registry; the palette is not split |
| 15 | Infinite scroll | Locked follow/pin contract plus the virtualization budget | `UX_GUIDELINE.md:78`, `:167` | Any infinite-scroll behaviour must not yank a scrolled-up reader and must respect the list budget |
| 16 | A channel pins bar and a per-channel right panel | The 5-value `rightPanelView` enum with the header tab strip bound to it | `UX_GUIDELINE.md:32`, `:67`; `types/crowdOs.ts:323` | Pins and per-channel panels are enum values or existing surfaces, never a second addressing scheme |

## Performance notes

The locked budget table is reproduced verbatim in `## Implementation details`. Status against it as built today:

| Budget row | Status | Evidence |
|---|---|---|
| Cold start → interactive shell · tree expand < 200 ms cached / < 800 ms first fetch | Unverified — no measured harness in the repo | `UX_GUIDELINE.md:162`, `:165` |
| Channel switch < 150 ms rail / < 600 ms full | Partially met — drafts survive (`MainChatArea.tsx:243-257`), but the channel switch also refetches the full message page (`crowdOsStore.ts:2906-2918`) and resets the viewport to the latest message | `UX_GUIDELINE.md:163` |
| Streaming: instant pin, pill within one frame, rAF-throttled passive scroll | **Met** — instant pin (`use-stick-to-bottom.ts:30-32`), rAF throttle (`MainChatArea.tsx:452-459`), 32 ms coalescer (`crowdOsStore.ts:1092-1103`) | `UX_GUIDELINE.md:164` |
| Palette < 50 ms per keystroke local | Unverified — the palette is lazily imported but its per-keystroke cost is not measured | `UX_GUIDELINE.md:166` |
| Lists: virtualize past 500 channels / 2,000 messages | **Unmet** — no windowing dependency and the whole channel is rendered | `packages/client/package.json:15-26`; `MainChatArea.tsx:701-847` |
| Renderer memory < 600 MB with 10k messages | Bounded in practice by the 200-message-per-channel local mirror, not by virtualization | `messagePagination.ts:15`, `:36-56` |
| Ledger poll 30 s, workspace-scoped, status strip ticks ≤ 1/s | Partially met — the strip ticks at 1/s but only when a start time is supplied; no ledger poll exists yet | `StatusStrip.tsx:65-70` |

Two further measured facts matter for any proposed change: the root chat component subscribes to the whole store with no selector (`MainChatArea.tsx:92-123`), and `renderedMessages` re-memoises on every streaming flush because `currentMessages` changes identity each time (`MainChatArea.tsx:847`).

## Evidence

| Source | What it establishes |
|---|---|
| `UX_GUIDELINE.md` | The normative contract; every "locked" rule and the §12 budget table |
| `packages/client/src/App.tsx`, `packages/client/src/config/deep-link.ts` | Shell composition, named slots, per-panel error boundaries, channel-only deep links |
| `packages/client/components/workspace/MainChatArea.tsx` and `workspace/messages/*` (incl. `use-stick-to-bottom.ts`, `streaming-blocks.ts`) | Header, stream container, follow effect, paging, folding, grouping, composer, router, per-type renderers |
| `packages/client/stores/crowdOsStore.ts`, `stores/messagePagination.ts` | Pin authority, paging cursors, streaming coalescer, drafts, outbox, applies-to, mirror cap |
| `packages/client/types/crowdOs.ts` | `ComposerMode` ↔ `RuntimeType`, `rightPanelView` enum, message taxonomy |
| `packages/client/components/workspace/{ModeSelector,StatusStrip,RunCard,RunHeader,CheckpointRow,DiffViewer,JobsView,OperationsInbox,OperationsSheet,BottomDrawer,RightSidebar,FileExplorer,BrowserPanel,ThreadDrawer,QuickAsk}.tsx` and `workspace/modals/palette-verbs.ts` | The surfaces named in the inventory and the verb registry |
| `packages/client/components/ui/{NotificationCenter,OfflineBanner,ToastProvider,ThemeToggle}.tsx`, `components/lockscreen/LockScreen.tsx`, `components/portal/WorkspacePortal.tsx` | Notification/DND, offline centre, toasts, theme cycle, non-dismissible lock, portal-first boot |
| `re-docs/Frontend Docs/Domain Spec/*.md` and `Feature and Flow Spec/*.md` | Canonical CrowdOS per-surface contracts and flows |

## Gaps

Weaknesses a Discord-derived spec may legitimately target — each is a place where CrowdOS is behind, not a place where CrowdOS is wrong.

- **No virtualization**, against the locked budget (`packages/client/package.json:15-26`).
- **No honest unread anchor and no per-channel scroll position,** so no unread marker can be drawn and returning to a channel loses the reading position (`MainChatArea.tsx:68-84`, `:849-854`).
- **Orphan tool rows fabricate a timestamp and a random id** (`MainChatArea.tsx:741-748`, `:763-770`).
- **Sender identity is still local-only** (`local-operator` + a local profile); no server-resolved auth attribution (`MainChatArea.tsx:604`; `crowdOsStore.ts:2974-2979`).
- **Governance cards are display-only** — strike and parliament render with no vote or appeal action (`MessageRouter.tsx:78-228`).
- **Sticky mentions, the mute map and drafts have no cross-device sync** and no settings UI (`MainChatArea.tsx:203-221`, `:236`), and **attachments live as unbounded data URLs** with no upload progress or server persistence (`MainChatArea.tsx:303-332`).
- **The status strip's context %, tokens, cost and elapsed segments are never populated** (`MainChatArea.tsx:1508-1514`).
- **No slash-command surface in the composer** — the palette is the only verb surface (`palette-verbs.ts:83-98`) — and the emoji picker has no search and no categories (`EmojiPickerPopover.tsx:5-9`).
- **No keyboard navigation over the transcript**, no list semantics on the stream, no typing indicator and no reactions** (`MessageRouter.tsx`; `types/crowdOs.ts:27`).
- **The sandbox editor lacks conflict handling and a dirty-guard on channel switch** (`re-docs/Frontend Docs/Domain Spec/Chat Area.md:146`).
- **Thirteen documented drifts** between `UX_GUIDELINE.md`, the `re-docs` specs and the code, listed above.

## User Decision:

## Target Contract

> Status: Target. CrowdOS's UI and features are never removed or replaced by a Discord-derived pattern. A Discord pattern is adopted only where it fills a CrowdOS gap, and where it conflicts, CrowdOS's locked rule wins and the conflict is recorded rather than silently applied. This is the checklist any proposed change must pass.

* **Nothing existing is removed, renamed or re-skinned.** Slots keep their meaning; panels keep their enum; features keep their place in the slot map.
* **A new right-hand surface is a new enum value of `rightPanelView`,** never a boolean and never a mode that changes the furniture (`UX_GUIDELINE.md:32`).
* **Categories are groups, never folders,** and the shared channel tree is never mutated by a personal overlay (`UX_GUIDELINE.md:15`, `:65`).
* **Operations are never fully hidden** at any viewport width (`UX_GUIDELINE.md:68`).
* **The transcript keeps its six types, its folded tool calls and its 300 s grouping rule.** Interleaved tool rows are forbidden (`UX_GUIDELINE.md:76`; `MainChatArea.tsx:706-729`, `:799-817`).
* **A divider or an unread marker may only be drawn from a real source.** No fabricated timestamps, no fabricated unread anchors (`MainChatArea.tsx:68-84`, `:787-795`).
* **The follow/pin contract is inviolable:** wheel/touch intent only, instant pin, smooth resume, no jump on prepend, no yank of a scrolled-up reader (`use-stick-to-bottom.ts:13-49`).
* **A decided approval card keeps its risk badge and terminal status** and never vanishes, and a pending approval stays above the transcript (`ApprovalCard.tsx:55-56`, `:112`; `MainChatArea.tsx:1074-1076`).
* **A restore or a diff apply runs under the one shared busy lock,** with a file-scope preview (`CheckpointRow.tsx:59-66`; `DiffViewer.tsx:191-193`).
* **Cost, context and token values always link to a ledger source or render empty.** A fabricated number is forbidden (`UX_GUIDELINE.md:141`; `DelegationMessage.tsx:17-19`).
* **Authority comes from the level, never from the name, the species label or the presence dot** (`UX_GUIDELINE.md:21`, `:98`).
* **Approval-waiting and mention remain distinct badges,** each icon+text, never colour-only (`UX_GUIDELINE.md:51`, `:109`).
* **The Jobs view gains no control the server cannot honour** (`JobsView.tsx:46-49`).
* **Composer caps stay 4000 / 5 MB / 10,** and an over-limit send is confirmed rather than blocked or silently truncated (`MainChatArea.tsx:128-130`, `:568-573`).
* **Mention chips remain the routing source of truth,** and the client keeps translating composer vocabulary into runtime names before writing (`MainChatArea.tsx:585-589`; `types/crowdOs.ts:288-315`).
* **There is exactly one status line above the textarea, and it is never modal** (`StatusStrip.tsx:36-49`; `UX_GUIDELINE.md:89`).
* **No new blocking affordance without an explicit, announced reason** — including any throttle modelled on slow mode (`UX_GUIDELINE.md:83`, `:201`).
* **Keyboard completeness and the existing ARIA contracts are not regressions:** every verb stays reachable without a pointer, and no surface loses its listbox/tree/tab semantics (`UX_GUIDELINE.md:150-151`).
* **Every proposal states which gap it fills and which locked rule it touches,** and records the conflict in `## Gaps` here and in the owning flow doc before code changes. The §12 budget numbers are load-bearing: a proposal that would breach one must either meet it or amend the budget explicitly — never silently.

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| Three-panel shell + named slots | Four landmark columns + chrome bar | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS has a slot-stable shell with two named center-column slots and a portal gate; Discord has four independent columns and an in-app title bar. |
| Workspace→Category→Channel nav | Guild rail + channel sidebar + guild folders | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS categories are groups, never folders; Discord folders are a real tree level. |
| `rightPanelView` 5-value enum | No right-pane tab strip — one column plus header popovers | [Right Panel and Members](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS addresses panels by a named enum bound to a header tab strip; Discord opens popovers from the header. |
| Tier-grouped roster | Member list grouped role-first, status-second | [Right Panel and Members](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS groups by authority tier L0–L3; Discord groups by hoist role, then online/offline. |
| Presence as durational presence | Presence dot | [Right Panel and Members](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS's roster row carries duration and cost; the guideline explicitly refuses the Discord dot. |
| Message provenance contract | Hover timestamp + `(edited)` flag | [Interaction Vocabulary](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS links edited-from, regenerated-from and redaction reveal; Discord shows an edited flag only. |
| Run threads | Per-message threads and a reply spine | [Threads](../Discord%20Findings/Threads.md) | CrowdOS's thread is a run branch with a pinned parent prompt; Discord's is a reply chain with a jump-to-reply affordance. |
| Progressive disclosure | Dense always-on chrome | [Interaction Vocabulary](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS collapses by default and reveals on hover/focus; Discord renders the row group inline. |
| Icon+text badge semantics | Red unread dot + count pill | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS encodes every state in icon+text; the approval-waiting badge stays distinct from unread. |
| Hover/focus row toolbar | Always-mounted "Message Actions" group | [Interaction Vocabulary](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS mounts the toolbar hidden and reveals it on hover/focus. |
| Mention-chip routing | Emoji-only reactions | [Message List](../Discord%20Findings/Message%20List.md) | CrowdOS's chips decide who is addressed; Discord's reactions carry no routing meaning. |
| `crowdos_muted_channels` + DND schedule | Per-server mute toggle | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS mutes per channel in a local map with a DND schedule; Discord mutes per server. |
| Sticky mentions + favorites overlay | Pinned messages popover | [Right Panel and Members](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS has no pinned-message surface; sticky mentions and favorites are separate and may not be reused as one. |
| Confirmed-overflow send | Slowmode cooldown + rate limit | [Composer](../Discord%20Findings/Composer.md) | CrowdOS confirms an over-cap send; Discord blocks with a modal failure reason. |
| Categories as groups | Category folders | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS forbids presenting a category as a folder (`UX_GUIDELINE.md:15`). |
| Palette verb registry | Search-first command palette | [Shell and Navigation](../Discord%20Findings/Shell%20and%20Navigation.md) | CrowdOS's palette must reach verbs with shortcut, scope and risk; Discord's palette description is search-first. |
| Follow/pin contract + list budget | `pinned` flag + unvirtualized list | [Scroll Model](../Discord%20Findings/Scroll%20Model.md) | CrowdOS decides follow from wheel/touch intent with an 80 px threshold and has a virtualization budget it does not yet meet; Discord persists a per-channel `pinned` flag and is also unvirtualized. |
| `rightPanelView` addressing | Channel pins bar + per-channel right panel | [Right Panel and Members](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS addresses every right-hand surface through one enum; a Discord-style pins bar must become an enum value, not a second scheme. |
| Role / authority surface | Role chips, permission matrix, per-channel overrides | [Roles and Authority](../Discord%20Findings/Roles%20and%20Authority.md) | CrowdOS's authority is the level L0–L3 and never a name; the Discord role model is the reference, not the target. |
| Workspace-scoped, local-first state | Single authoritative server | [Desktop Shell Delta](../Discord%20Findings/Desktop%20Shell%20Delta.md) | CrowdOS isolates by workspace and degrades to local files; Discord assumes one server boundary. |

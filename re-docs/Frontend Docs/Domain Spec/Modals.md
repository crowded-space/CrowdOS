# Modals

## Purpose

Overlay surfaces: the workspace admin console, global omni-search, agent profile with runtime hot-patching, quick channel creation, and the shared destructive-action confirm dialog.

## Feature Scope

In-scope: `WorkspaceSettingsModal` 12 tabs (overview, agents, roles, tools, model_cards, skills_manager, channels, mounts, diagnostics, audit, safety, screen_lock), `OmniSearchModal` federated search, `AgentProfileModal` identity/modules/overrides/DM composer, `InlineChannelModal` validation + creation, `ConfirmDialog` focus/role/keyboard contract, `QuickAsk` floating capture panel, and how `App.tsx` mounts them.
Non-goals: sidebar chrome (see Workspace Shell), message rendering (see Chat Area), file tree/mounts/diffs (see Filesystem Explorer), portal onboarding (see Portal), Agent Studio internals (separate surface, only its launch points noted).

## Expect

- `[Observed]` Settings opens to a caller-chosen tab (`workspaceSettingsTab`) with 12-item nav; Escape/backdrop closes; body scroll locks; focus moves into the dialog and returns to the opening control on close.
- `[Observed]` Settings destructive actions (workspace delete, agent/role/channel deletes) arm a styled confirm before executing.
- `[Observed]` Agent/channel/category names validate live: 2–40 chars, uniqueness within workspace, channel slug formatting with preview. Agent name charset (create/edit/import) is `[A-Za-z0-9_-]` since 2026-09-23 — hyphens allowed so seeded names like `default-assistant` pass their own form rule (spaces stay excluded, the @mention parser matches `@[A-Za-z0-9_-]+`).
- `[Observed]` Omni-search merges local store hits with debounced (200ms) server results from `/api/search`; empty query shows top channels/agents/tools. 2026-10-04 Phase E adds a dual-mode palette: Search tab (existing entity/message results untouched, deduped single search block) + Commands tab listing the 14 palette verbs from `modals/palette-verbs.ts` (`OmniSearchModal.tsx:196-216`). Commands empty state reads `No matching commands for "{query}"` (`OmniSearchModal.tsx:420-422`); Search/Commands switch via `role=tablist` (`OmniSearchModal.tsx:279-300`), verbs render in `role=listbox` with `role=option` rows (`OmniSearchModal.tsx:428-440`), and the Commands input is a `combobox` with Arrow/Home/End/Enter + `aria-activedescendant` (`OmniSearchModal.tsx:251-262`). Verbs use subsequence fuzzy scoring (`filterVerbs`) with recent-first ordering from the `crowdos_palette_recent` mirror (cap 10, `palette-verbs.ts:40-70`); every verb `run()` calls a real store action (switch channel/workspace, cycle/pin runtime, mute toggle via the `crowdos_muted_channels` map, clear history, repo/jobs panels, approve/deny first pending, retry latest run, cancel active run, lock screen) and records use via `recordVerbUse` (`palette-verbs.ts:77+`, `OmniSearchModal.tsx:214-218`).
- `[Observed]` Omni-search merges local store hits with debounced (200ms) server results from `/api/search`; empty query shows top channels/agents/tools. 2026-10-04 Phase E adds a dual-mode palette: Search tab (existing entity/message results untouched, deduped single search block) + Commands tab listing the palette verbs from `modals/palette-verbs.ts` (14 at Phase E, 16 from 2026-10-05 Phase G with capture verbs `open-quick-ask` / `ask-l0-in-place`; `OmniSearchModal.tsx:196-216`). Commands empty state reads `No matching commands for "{query}"` (`OmniSearchModal.tsx:420-422`); Search/Commands switch via `role=tablist` (`OmniSearchModal.tsx:279-300`), verbs render in `role=listbox` with `role=option` rows (`OmniSearchModal.tsx:428-440`), and the Commands input is a `combobox` with Arrow/Home/End/Enter + `aria-activedescendant` (`OmniSearchModal.tsx:251-262`). Verbs use subsequence fuzzy scoring (`filterVerbs`) with recent-first ordering from the `crowdos_palette_recent` mirror (cap 10, `palette-verbs.ts:40-70`); every verb `run()` calls a real store action (switch channel/workspace, cycle/pin runtime, mute toggle via the `crowdos_muted_channels` map, clear history, repo/jobs panels, approve/deny first pending, retry latest run, cancel active run, lock screen; capture verbs summon QuickAsk via `crowdos:quick-ask-open`) and records use via `recordVerbUse` (`palette-verbs.ts:77+`, `OmniSearchModal.tsx:214-218`).
- `[Observed]` 2026-10-05 Phase G quick-ask capture: floating `QuickAsk.tsx` panel (global summon Ctrl/Cmd+Shift+K, palette keeps Ctrl/Cmd+K) defaults to the current channel scope + L0 agent when present with honest empty otherwise; scope line names where the answer lands (`#channel` + runtime) plus the draft-snapshot mount short path (honest dash when unknown); Enter asks in place via `addMessage`/`queueSend`, Shift+Enter expands to the full composer; 4000-char cap, 150ms fade only, reduced-motion static, `use-overlay-focus` trap, Escape closes; mounted lazy in `App.tsx` `Suspense`.
- `[Observed]` Agent profile shows level-styled identity, module assembly cards, live hot-patch roster with toggle/revert, patch composer (instruction/model/toolkit + audit reason), hierarchy chain, and a DM input that posts `@agent text` to the active channel. Opening moves focus to `Close agent profile`; close/Escape returns it to the originating roster/message trigger. Its Open studio and DM command controls both have at least 24×24 hit areas.
- `[Observed]` Agent profile shows level-styled identity, module assembly cards, live hot-patch roster with toggle/revert, patch composer (instruction/model/toolkit + audit reason), hierarchy chain, and a DM input that posts `@agent text` to the active channel. Opening moves focus to `Close agent profile`; close/Escape returns it to the originating roster/message trigger. Its Open studio and DM command controls both have at least 24×24 hit areas. The model-patch temperature/max-tokens boxes keep raw input so clearing never stores NaN; apply falls back to the last good value (`AgentProfileModal.tsx`).
`[Observed]` Agent profile shows level-styled identity, module assembly cards, live hot-patch roster with toggle/revert, patch composer (instruction/model/toolkit + audit reason), hierarchy chain, and a DM input that posts `@agent text` to the active channel. Opening moves focus to `Close agent profile`; close/Escape returns it to the originating roster/message trigger. Its Open studio and DM command controls both have at least 24×24 hit areas. The model-patch temperature/max-tokens boxes keep raw input so clearing never stores NaN; apply falls back to the last good value (`AgentProfileModal.tsx`). A Context cap (tokens) override sits between the assembly cards and the overrides roster: raw-string input bound to `contextTokenCap`, empty (placeholder `Workspace default`) saves explicit null to inherit the workspace default, valid positive ints save via `updateAgent`, invalid entries block save with an inline message, and NaN is never stored or sent.
- `[Observed]` Model-cards tab keeps temperature/max-tokens as raw input for the same reason: clearing a box leaves it empty (omitted from the update payload on edit, defaulted on create), the connection-test banner reserves `Model not found` for genuine HTTP 404s and reports down/unreachable custom endpoints as still-registered-but-unreachable (`ModelCardsTab.tsx`).
- `[Observed]` Inline channel creation requires a target category and blocks duplicates/short/long/empty-after-slug names with inline messages; its close control is a 24×24 hit target.
- `[Observed]` `ConfirmDialog` uses `alertdialog` role for danger, autofocuses Cancel on danger (Confirm otherwise), traps Tab between two buttons, closes on Escape/backdrop.
- `[Observed]` Mounts tab (2026-10-04) hosts `MountsInspector` (`WorkspaceSettingsModal.tsx:951,3059-3060`): Workspace vs Category vs Channel cards, Winner badge on the `effective.source` level with the effective `sourceHint` why-line, per-level Browse via `FolderMountPicker`, Clear confirm-guarded only while a path is set, and honest loading/error/empty states; readers are `getCategoryMount` / `getWorkspaceMount` / `getEffectiveMount` / `getAllowedRoots` (`api/client.ts:516-545`); override replaces, never merges, with no virtual filesystem.
- `[Observed]` Diagnostics tab (2026-10-04) hosts `DiagnosticsTab` (`WorkspaceSettingsModal.tsx:953,3065-3066`; `settings/DiagnosticsTab.tsx`): perf budget rows from real measured marks only (`performance.measure('fetchWorkspaces')` at `crowdOsStore.ts:2432-2433` plus navigation timing), honest no-data states for unmeasured S12 rows, motion-budget plus a11y gates (single-pulse target, reduced-motion static, toast live-region policy), and a Copy diagnostics bundle of real workspace/budget/perf/motion/client state only (no message content, files, secrets, keys, or PINs).
- `[Observed]` Diagnostics tab (2026-10-04) hosts `DiagnosticsTab` (`WorkspaceSettingsModal.tsx:954,3067-3069`; `settings/DiagnosticsTab.tsx`): perf budget rows from real measured marks only (`performance.measure('fetchWorkspaces')` at `crowdOsStore.ts:2432-2433` plus navigation timing), honest no-data states for unmeasured S12 rows, motion-budget plus a11y gates (single-pulse target, reduced-motion static, toast live-region policy), and a Copy diagnostics bundle of real workspace/budget/perf/motion/client state only (no message content, files, secrets, keys, or PINs).
- `[Observed]` Audit tab (2026-10-04) hosts `AuditTab` (`WorkspaceSettingsModal.tsx:955,3071-3073`; `settings/AuditTab.tsx`): kind filter plus text search over live store projections only (approvals from `approvalRequests`, mounts from composer-observed `draftByChannel` mount snapshots, models from `modelProfiles`/`modelModules`, restores from `restoreAuditByRun`) with honest dashes for unrecorded fields, plus an Export button that downloads the filtered real events as JSON only (arg values, message content, file contents, secrets, keys, PINs excluded).
- `[Inferred]` Budget/role/skill/tool editors persist through store actions with toast/alert error paths; server failure modes not fully verified per tab.

## Flow

1. Open settings: any `setWorkspaceSettingsTab(tab)` + `setSettingsModalOpen(true)` (dropdown, sidebar gear — see Workspace Shell); modal shell `WorkspaceSettingsModal.tsx:948-968`; tab nav `WorkspaceSettingsModal.tsx:978-997`.
2. Delete workspace: two styled confirms — delete intent, then Flush tables vs Keep DB intact → `deleteWorkspace(id, {flush?})` → close + toast. No native dialog (`WorkspaceSettingsModal.tsx:1018-1050`).
3. Manage agents: presets auto-fill `WorkspaceSettingsModal.tsx:1154-1176`; create `WorkspaceSettingsModal.tsx:604-667`, edit `WorkspaceSettingsModal.tsx:668-707`, duplicate/export/import `WorkspaceSettingsModal.tsx:709-780`.
4. Manage roles: create `WorkspaceSettingsModal.tsx:498-504`, drag-reorder `WorkspaceSettingsModal.tsx:508-552`, permission toggles `WorkspaceSettingsModal.tsx:554-561` (tab body `WorkspaceSettingsModal.tsx:1671`).
5. Manage channels/categories: create forms with live validation `WorkspaceSettingsModal.tsx:1864-1974`; list actions via `deleteCategory/createCategory/createChannel/deleteChannel/archiveChannel/reorderCategory/reorderChannel` (tab body from `WorkspaceSettingsModal.tsx:1976`).
6. Safety/budgets: usage bar + cap edit + provider caps via `fetchBudget/updateBudget/resetBudget` (`WorkspaceSettingsModal.tsx:2741-3011`); mounts tab at `WorkspaceSettingsModal.tsx:3063-3065` hosts `MountsInspector` (per-level cards, Winner plus why, per-level `FolderMountPicker` browse, confirm-guarded Clear-only-while-set); audit tab at `WorkspaceSettingsModal.tsx:3071-3073` hosts `AuditTab` (kind filter + search over live projections, Export downloads filtered real events as JSON); screen-lock tab at `WorkspaceSettingsModal.tsx:3054-3062`.
7. Omni-search: `App.tsx:124-134` toggles on Cmd/Ctrl+K; server debounce `OmniSearchModal.tsx:87-118` (single search effect — deduped single search block); channel hit → `setActiveChannel` + close (`OmniSearchModal.tsx:315-316`), agent hit → profile (`OmniSearchModal.tsx:345-346`), message hit → jump channel (`OmniSearchModal.tsx:393-394`); verbs `run()` + `recordVerbUse` + close (`OmniSearchModal.tsx:214-218`).
8. QuickAsk capture (Phase G): `App.tsx` summons on Ctrl/Cmd+Shift+K (palette keeps Ctrl/Cmd+K) and mounts `<QuickAsk/>` lazy in `Suspense`; `crowdos:quick-ask-open` event bridges the two capture palette verbs to the panel; `QuickAsk.tsx` asks in place via `addMessage` (offline `queueSend` with will-send copy) and expands via Shift+Enter to the full composer with a best-effort `setDraft` backup.
8. Agent profile: open via `openAgentProfileModal(id)` (roster rows, message avatars, search); shared overlay focus moves to `Close agent profile`, traps Tab inside the dialog, and restores the originating trigger on close/Escape. DM `AgentProfileModal.tsx:72-86`; patch apply `AgentProfileModal.tsx:88-112`; override toggle/revert inline `AgentProfileModal.tsx:297-337`; Open Agent Studio `AgentProfileModal.tsx:210-217` embeds studio modal `AgentProfileModal.tsx:533-537`. Open studio uses negative vertical margins to reach 24px high without moving the module row; the DM command is non-shrinking at 24×24.
9. Inline channel: opened from sidebar category `+`; validation `InlineChannelModal.tsx:47-53`; create `InlineChannelModal.tsx:55-69` → `createChannel(catId, slug, desc)` + toast + close; the header close button is `w-6 h-6`.
10. Confirm: `ConfirmDialog.tsx:30-68` Escape/Tab-trap/scroll-lock; danger styling + labels per caller; overlay portaled to `document.body` (`ConfirmDialog.tsx:75-155`) so the off-canvas sidebar's non-none `translate` cannot become the containing block for the `fixed` layer.

## Current Implementation

| Component | Role |
|---|---|
| `workspace/modals/WorkspaceSettingsModal.tsx` | Admin console: 12-tab router, agents/roles/channels/skills/tools/models/mounts/diagnostics/audit/safety/screen-lock editors, delete flow; mounts tab hosts `MountsInspector`; diagnostics tab hosts `settings/DiagnosticsTab`; audit tab hosts `settings/AuditTab` |
| `workspace/modals/OmniSearchModal.tsx` | Federated finder over channels, agents, tools, local + server messages; dual-mode Search + Commands palette tabs |
| `workspace/modals/palette-verbs.ts` | 14 palette verbs (`buildVerbs`) + subsequence scorer (`fuzzyScore`/`filterVerbs`) + `crowdos_palette_recent` recency (cap 10, `loadRecentVerbs`/`recordVerbUse`); every `run()` calls a real store action |
| `workspace/QuickAsk.tsx` | Floating quick-ask capture panel (Phase G): defaults to the current channel scope + L0 agent when present (honest empty otherwise), scope line names where the answer lands plus runtime and the draft-snapshot mount short path (honest dash when unknown); Enter asks in place via `addMessage`/`queueSend`, Shift+Enter expands to the full composer; 4000-char cap, 150ms fade only, reduced-motion static, focus trap via `use-overlay-focus`, Escape closes |
| `workspace/modals/AgentProfileModal.tsx` | Agent dossier: identity, module cards, hot-patch roster + composer, hierarchy, DM footer, studio launcher |
| `workspace/modals/OperatorProfileModal.tsx` | User profile: username + user tag + optional preference, portaled to `document.body`; persists to `crowdos_operator` via `workspace/operator-profile-model.ts` on save |
| `workspace/modals/InlineChannelModal.tsx` | Single-channel creator with category picker + slug validation; portaled to `document.body` so transformed sidebar ancestors cannot constrain its fixed overlay |
| `ui/ConfirmDialog.tsx` | Shared confirm: danger-aware role/focus, Escape/backdrop/Tab-trap, body lock; portaled to `document.body` so transformed sidebar ancestors cannot constrain its fixed overlay |

## Props & Store

- `WorkspaceSettingsModal` — no props; driven by `settingsModalOpen, workspaceSettingsTab, workspaces, activeWorkspaceId` + ~30 store actions (agents, roles, tools, instruction/model/toolkit/constraints/capabilities modules, categories/channels, budget). Local: confirm-modal state, per-editor forms, drag state, budget inputs. Diagnostics tab hosts `DiagnosticsTab` (no props; reads `workspaces, activeWorkspaceId, agents, dbSyncStatus, globalSoftCap, perProviderBudget, totalTokensConsumed` plus `performance` entries; local `copied, tick` only). Mounts tab hosts `MountsInspector` (no props; reads `workspaces, activeWorkspaceId, activeChannelId, incrementFilesystemRevision` from the store plus category/channel picks; local per-level snapshots, effective scope, allowed roots, revision, busy/status, browse-open, and clear target). Audit tab hosts `AuditTab` (no props; reads `approvalRequests, draftByChannel, modelProfiles, modelModules, restoreAuditByRun, workspaces, activeWorkspaceId`; local `kind, query, exported` only).
- `OmniSearchModal { open; onClose }` — reads `workspaces, activeWorkspaceId, agents, tools, messages, setActiveChannel, openAgentProfileModal`; local `query, serverResults, isSearchingServer` + `tab` (search|commands) + `activeVerbIndex`. Verbs registry is `modals/palette-verbs.ts` (`buildVerbs`/`filterVerbs`/`fuzzyScore` + `loadRecentVerbs`/`recordVerbUse` over the `crowdos_palette_recent` mirror, cap 10).
- `OmniSearchModal { open; onClose }` — reads `workspaces, activeWorkspaceId, agents, tools, messages, setActiveChannel, openAgentProfileModal`; local `query, serverResults, isSearchingServer` + `tab` (search|commands) + `activeVerbIndex`. Verbs registry is `modals/palette-verbs.ts` (16 verbs: 14 switch/admin + 2 Phase G capture `open-quick-ask` / `ask-l0-in-place` summoning QuickAsk via the `crowdos:quick-ask-open` window event; `buildVerbs`/`filterVerbs`/`fuzzyScore` + `loadRecentVerbs`/`recordVerbUse` over the `crowdos_palette_recent` mirror, cap 10).
- `QuickAsk { open; onClose }` — reads `workspaces, activeWorkspaceId, activeChannelId, agents, selectedMode, draftByChannel, addMessage, queueSend, setDraft`; local `text, sending, shown`. Summoned globally by Ctrl/Cmd+Shift+K (`App.tsx` hotkey, palette kept on Ctrl/Cmd+K) and by the two capture palette verbs; mount readout is display-only from the `draftByChannel` snapshot (no new fetch).
- `AgentProfileModal` — no props; driven by `selectedAgentId, agentProfileModalOpen, closeAgentProfileModal`; reads `agents, instruction/model/toolkit/constraints/capabilitiesModules, runtimeOverrides, tools`; actions `addMessage, addRuntimeOverride, deleteRuntimeOverride, toggleRuntimeOverride`; local DM text, studio open, patch form.
- `InlineChannelModal { open; categoryId?; onClose }` — reads `createChannel, workspaces, activeWorkspaceId`; local name/desc/category.
- `OperatorProfileModal { open; onClose }` — reads/writes the operator profile via `loadOperatorProfile`/`saveOperatorProfile`; local name/tag/preference draft, reloaded into the sidebar on close.
- `ConfirmDialog { open; title; description; confirmLabel?; cancelLabel?; isDanger?; onConfirm; onCancel }` — stateless.

## Relations

- Parents: `App.tsx` lazy-mounts the three big modals in `Suspense`; `InlineChannelModal` is instantiated by `WorkspaceSidebar` but portals its overlay to `document.body`; `ConfirmDialog` is reused by dropdown (leave), chat (clear logs), and settings (deletes), and portals its overlay to `document.body` for the same reason (the sidebar `<nav>` carries a non-none `translate` below `xl`, which would otherwise become the containing block for its `fixed` overlay and pin the dialog inside the sidebar).
- Children: settings → `ModelCardsTab`, `CrowIcon`, `AgentStudioModal`, `ScreenLockSettingsPanel`, `MountsInspector`, `DiagnosticsTab`, `AuditTab`, `ConfirmDialog`; mounts cards → per-level `FolderMountPicker`; profile → `PresenceIndicator`, `StatusBadge`, `AgentStudioModal`.
- Store: settings/profile/search/channel actions on `crowdOsStore`; toasts via `ToastProvider`.
- API: search `GET /api/search?q=&limit=`; agent/role/channel/budget mutations via store (endpoints not enumerated here).

## Emits-Listens

- No socket calls in modal files; mutations flow through store actions which emit `user:message` (profile DM) and rely on socket-fed refresh (`agent:spawned`, `workspace:sync`, budget events) to update open modal state.
- `AgentProfileModal` hot-patch actions (`addRuntimeOverride`, `toggleRuntimeOverride`, `deleteRuntimeOverride`) are store-local unless the store forwards them — forwarding unverified (see Gaps).

## Owns

- Form drafts per editor, validation derivations, role-drag id, confirm-modal queue (single slot), search query + server snapshot, profile DM/patch drafts, channel-creation fields. Only `OperatorProfileModal` persists to localStorage (`crowdos_operator` on save); nothing else in these files does.

## Flags

- No env vars; responsive via `max-w-*`, `max-h-[90vh/dvh]`, scroll regions, `md:` settings split (top nav below `md`, side nav at `md+`), `sm:` search/type tweaks; z-indexes: search `9995`, inline-channel `9990`, confirm `9990`, settings/profile `50`.
- Reduced-motion not specially handled in modals (springs always run) — contrast with shell/chat.

## Decisions

- `[Observed]` One settings modal with tab router instead of per-domain dialogs — single admin entry point.
- `[Observed]` Danger confirms default-focus Cancel; non-danger default-focus Confirm.
- `[Observed]` Runtime patches require an audit reason and stay reversible/toggleable rather than editing modules in place.
- `[Observed]` Search prefers server history first, then in-memory messages — recency vs persistence merge.
- `[Observed]` 2026-09-27 visual polish pass (complete sweep): every form label, section header, status chip, and stream-state badge across settings/search/profile/studio moved from mono-uppercase ALL-CAPS to sentence-case medium (matching the shell's roster style); count badges are square `rounded` + `tnum` instead of pills; fantasy copy replaced with plain language (Admin Console, nodes/sectors/NORMAL BOUND stats, deprovision/mind/virtual-environment vocabulary, gas → cost, internal monologue → reasoning). Presentational only — tab ids, ports, and flows unchanged.
- `[Observed]` Workspace delete carries no native dialog; the confirm contract is two styled confirms with cancel routing (keep vs flush scope).
- `[Inferred]` Budget/toolkit error paths may still use native alerts — legacy seams inside styled flows (delete flow verified clean).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Single admin console plus danger-confirm plus reversible patches stay; tab coverage, override propagation, and hardcoded authority are the gaps.
One settings modal with tab router stays the single admin entry point. Per-domain dialogs duplicating it are forbidden.
Danger confirms stay default-focus Cancel with non-danger default-focus Confirm. Unconfirmed destructive actions are forbidden.
Runtime patches stay reversible and auditable with a required reason. Silent in-place module edits are forbidden.
Every settings tab MUST have documented per-field behavior plus endpoints plus error paths. Spot-read-only tabs are forbidden.
Hosted surfaces ModelCardsTab plus ScreenLockSettingsPanel plus AgentStudioModal MUST be documented where hosted or explicitly out of scope with a pointer. Silent hosting gaps are forbidden.
Runtime-override propagation MUST declare one contract: local-only, server-persisted, or socket-broadcast. Unverified propagation is forbidden.
Screen-lock tab relationship to screenLockStore and lockscreen flow MUST be documented. Unlinked duplicate lock surfaces are forbidden.
ROLE_PERMISSIONS plus ROLE_COLORS plus agent PRESETS MUST come from server authority or be labeled local defaults with an explicit override rule. Silent client-hardcoded authority is forbidden.
Concurrent edits across tabs MUST coordinate or explicitly last-write-wins with a documented rule. Silent cross-tab clobber is forbidden.
## Failure + Resume

- Validation blocks submit with inline messages (channel slug, category, agent name charset, duplicate warnings) instead of server round-trips.
- Import/parse failures surface toast errors (`WorkspaceSettingsModal.tsx:751-780`); toolkit JSON errors use `alert` in create path.
- Empty search: "No matching entities or logs found" (Search tab, `OmniSearchModal.tsx:408-412`); Commands empty: `No matching commands for "{query}"` (`OmniSearchModal.tsx:420-422`); profile with unknown id renders null (modal simply doesn't open).
- Modals lock body scroll, move focus into the overlay, and restore focus to the opener on close; Escape always available; delete wizard (Portal file, not mounted here) is stricter than settings delete.

## Gaps

- Tab bodies for roles/tools/model_cards/skills/safety/screen_lock only spot-read; per-field behavior, endpoints, and error paths per tab unverified (mounts, diagnostics, audit observed 2026-10-04: `MountsInspector` cards, Winner plus why, per-level browse, Clear-only-while-set; `DiagnosticsTab` measured-only rows plus Copy bundle; `AuditTab` live projections plus JSON export).
- `ModelCardsTab`, `ScreenLockSettingsPanel`, `AgentStudioModal` internals undocumented (out of assigned scope but hosted here).
- Runtime-override propagation (local-only vs server-persisted vs socket-broadcast) unverified.
- Screen-lock tab vs `screenLockStore`/lockscreen flow relationship unverified.
- Settings modal has no URL deep-linking; tab state lost on close; concurrent edits across tabs uncoordinated.
- `ROLE_PERMISSIONS`/`ROLE_COLORS`/agent `PRESETS` are client-hardcoded; server authority model unverified.

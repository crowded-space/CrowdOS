# Settings panels

> Type: Feature · Status: aligned · Updated: 2026-10-04

## Intent

One admin console for the workspace: overview, agents, roles, tools, models, skills, channels, mounts, diagnostics, audit, safety, and screen lock — no per-domain dialogs.

## Architectural decision

- [Observed] One modal with a 12-tab router instead of per-domain dialogs (`WorkspaceSettingsModal.tsx:944-957` tab list; mounts body at `:3063-3065`; diagnostics body at `:3067-3069`; audit body at `:3071-3073`).
- [Observed] Destructive actions arm a styled confirm before executing (area doc flow).
- [Observed] Destructive actions arm a styled confirm before executing (area doc flow). Local-only surfaces say so: roles header carries a local-only marker (role CRUD is store-only, no server enforcement), tools header carries one (toggle flips the local list only; real grants come from each agent's toolkit module), and the two safety policy toggles are labeled local-view-only with budget caps named as the real enforcement. The kill switch sends real stops per workspace channel over the existing cancel transport. The tools tab shows no invoke counts (the seeded counts and their dead increment action were removed).
- [Observed] Agent and skill forms default unassigned instead of binding phantom ids: presets carry identity only with blank module bindings, blank create/edit fields send undefined, the skill model select offers an explicit unassigned option, and agent model/instruction selects label their empty options as unassigned rather than promising flagship or default fallbacks.
- [Observed] Runtime-affecting edits stay reversible/auditable where observed: model-card delete confirms, profile hot-patches require reason (profile surface, not this console).
- [Observed] Mounts tab hosts the Mounts matrix (`MountsInspector`, named and default export): Workspace vs Category vs Channel cards with a Winner badge on the `effective.source` level, the effective `sourceHint` why-line, Clear confirm-guarded only while a path is set, per-level Browse via `FolderMountPicker`, honest loading/error/empty states, and live reads with no sample data (`MountsInspector.tsx:51-516`; readers `api/client.ts:516-545`).
- [Observed] Diagnostics tab hosts `DiagnosticsTab` (default export, `settings/DiagnosticsTab.tsx`): perf rows from real measured marks only (`performance.measure('fetchWorkspaces')` at `crowdOsStore.ts:2432-2433` plus navigation timing), honest no-data states for unmeasured S12 rows, motion-budget plus a11y gates (single-pulse target, reduced-motion static, toast live-region policy), and a Copy diagnostics bundle of real workspace/budget/perf/motion/client state only (no message content, files, secrets, keys, or PINs).
- [Observed] Diagnostics tab hosts `DiagnosticsTab` (default export, `settings/DiagnosticsTab.tsx`): perf rows from real measured marks only (`performance.measure('fetchWorkspaces')` at `crowdOsStore.ts:2432-2433` plus navigation timing), honest no-data states for unmeasured S12 rows, motion-budget plus a11y gates (single-pulse target, reduced-motion static, toast live-region policy), and a Copy diagnostics bundle of real workspace/budget/perf/motion/client state only (no message content, files, secrets, keys, or PINs).
- [Observed] Audit tab hosts `AuditTab` (default export, `settings/AuditTab.tsx`): kind filter (approvals/mounts/models/restores) plus text search over live store projections only — approvals from `approvalRequests`, mounts from composer-observed `draftByChannel` mount snapshots, models from `modelProfiles`/`modelModules`, restores from `restoreAuditByRun` — honest dashes for unrecorded fields plus an Export button that downloads the filtered real events as JSON only (arg values, message content, file contents, secrets, keys, PINs excluded).
- [Inferred] Centralize admin into a single entry point at the cost of a large modal file (~3080 lines).
- [Observed] Audit tab hosts `AuditTab` (default export, `settings/AuditTab.tsx`): kind filter (approvals/mounts/models/restores) plus text search over live store projections only, honest dashes for unrecorded fields, plus an Export button that downloads the filtered real events as JSON only (arg values, message content, file contents, secrets, keys, PINs excluded).
- [Inferred] Centralize admin into a single entry point at the cost of a large modal file (~3080 lines).

## How it works

Any `setWorkspaceSettingsTab(tab)` + `setSettingsModalOpen(true)` opens the console to the caller-chosen tab; focus moves into the dialog, Escape/backdrop closes, focus returns to the opening control, and body scroll locks (`WorkspaceSettingsModal.tsx:588-597,959-965`). Tab ids: overview, agents, roles, tools, model_cards, skills_manager, channels, mounts, diagnostics, audit, safety, screen_lock (`WorkspaceSettingsModal.tsx:944-957`) — the `overview` tab is labeled `Workspace`, so its header reads `Workspace Settings` (id kept for caller compat). Model cards (`ModelCardsTab`) manage label/provider/model/baseUrl/apiKey/temperature/maxTokens with test-connection per card and confirm-on-delete; tests route through `apiClient.testModelModule` (tenant headers + status-carrying errors) with honest copy — custom providers note the config-only probe limit, 404 reports a deleted model, offline flags stay explicit, and failures offer Test/Retry plus a Fix shortcut into edit (`ModelCardsTab.tsx`; `api/client.ts` test method). The API-key field is intentionally blank on edit (an empty key means "keep the stored key" because reads return a redacted mask that must never be sent back), and updates send only provided fields (the store drops blank keys and non-finite numbers), so editing a Local-mode module no longer fails server validation. Workspace delete is a two-step styled confirm (delete intent, then Flush tables vs Keep DB intact) with no native dialog — cancel on the second step keeps the DB and still deletes the workspace (`WorkspaceSettingsModal.tsx:1018-1050`). Safety shows global token consumption vs soft cap with gradient bar plus cap/provider-cap editors (`WorkspaceSettingsModal.tsx:2741-3011`). Screen lock hosts `ScreenLockSettingsPanel`, a PIN opt-in surface that stores only scrypt hashes server-side, never displays the PIN, and calls `setPin`/`clearPin` locally on enable/disable (`ScreenLockSettingsPanel.tsx:11-59`). Workspace tab hosts the Storage & Sync section (2026-09-18): storage-mode toggle (`default` dual-write / `local` files-only), serving-tier line + unreachable notice, conflict resolver (flush-local/flush-db/change-db, snapshot auto-taken), backlog banner + Sync now, and confirm-guarded Rebuild search index. Since 2026-09-26 the same section also hosts the Postgres connection inline (reused `WorkspaceDatabaseField`: Test + Provision schema + Connect & Save / Disconnect), so a database can be attached without leaving Settings. Mounts hosts the Mounts matrix (2026-10-04): three level cards (Workspace, Category, Channel) read live via `getWorkspaceMount` / `getCategoryMount` / `getChannelMount` plus `getEffectiveMount` and `getAllowedRoots` (`api/client.ts:516-545`); the winning level carries the Winner badge with the effective `sourceHint` why-line; override means replace, never merge, with no virtual filesystem; Clear is confirm-guarded and offered only while a path is set; per-card read failures render cause plus Retry and Browse (`MountsInspector.tsx`). Audit hosts the Audit table (2026-10-04): kind filter plus text search over live projections (approvals, composer mount snapshots, model registry, confirmed restores) with honest dashes for unrecorded fields; Export downloads the filtered real events as JSON only (arg values, message content, file contents, secrets, keys, PINs excluded).

## Components involved

| Area doc | Role |
|---|---|
| <../Domain Spec/Modals.md> | Owns the console shell, tab router, per-tab editors, and confirm contract; this spec narrates only the 12-tab UX with emphasis on model cards, mounts, diagnostics, audit, safety, and screen lock |

## Current state

All 12 tabs render behind the tab router with side nav at `md+` and top nav below that (`h-[85vh]/[75vh]` shell). Model-card CRUD, safety budget bar, diagnostics measured-only rows plus Copy bundle, audit filterable projections plus JSON export, and screen-lock PIN enable/disable observed as described. Matches the area doc's settings expectations.

## Alignment notes

- 2026-09-18 dual-boot: Overview Storage & Sync section renders preference/tier/conflict/backlog/rebuild surfaces; `runQuiet` treats backend `ok:false` as deferred (no false success toast); rebuild arms a styled confirm like the flush actions.
- 2026-09-26 model modules zero-default: `ModelCardsTab` keeps a single entry button (`New Model Profile`; the duplicate header `Add Model Module` removed), drops the hardcoded Google Gemini / gemini-2.0-flash telemetry card for a data-driven empty state (`No model providers configured`), and the offline test fallback no longer treats `google` as configured without a key. Fresh workspaces start with zero model providers; agents stay unassigned until one is registered.
- 2026-09-27 visual polish pass: Workspace tab fake telemetry ("nodes/sectors/NORMAL BOUND") replaced with real counts (agents, channels, storage mode) and a plain-language explainer; every tab's mono-uppercase labels moved to sentence-case; kill-switch copy is literal ("Stop all running work" / "Resume agent work"). Tab ids and behaviors unchanged.

- 2026-10-04 diagnostics tab: Settings gains the Diagnostics tab (diagnostics, WorkspaceSettingsModal.tsx:953,3065-3066) hosting settings/DiagnosticsTab.tsx \u2014 measured-only perf rows (performance.measure('fetchWorkspaces') at crowdOsStore.ts:2432-2433 plus navigation timing; unmeasured S12 rows report no-data), motion-budget plus a11y gates (single-pulse target with live pulsing-surface count, reduced-motion static, toast live-region policy), and Copy diagnostics bundle of real workspace/budget/perf/motion/client state only (no message content, files, secrets, keys, or PINs).- 2026-10-04 mounts matrix: Settings gains the Mounts tab (`mounts`, `WorkspaceSettingsModal.tsx:952,3061-3063`) hosting `MountsInspector` — per-level cards, Winner plus why, replace-not-merge, Clear-only-while-set, per-level `FolderMountPicker` browse, and live reads with no sample data.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* One modal with 11-tab router stays the single admin entry point. Destructive actions arm a styled confirm.
* Every tab has documented per-field behavior plus endpoints plus error paths. Spot-read-only tabs are forbidden.
* Runtime-override propagation declares one contract: local-only, server-persisted, or socket-broadcast. Screen-lock tab relationship to screenLockStore and lockscreen flow is documented.
* ROLE_PERMISSIONS plus ROLE_COLORS plus agent PRESETS come from server authority or are labeled local defaults with override rule.
* No URL deep-linking is an explicit contract with tab-state loss documented. Concurrent edits across tabs coordinate or last-write-wins by rule. Authority: Modals area doc.
## Open gaps

- Per-field behavior, endpoints, and error paths per tab (roles/tools/skills/safety/screen_lock) mostly unverified — mounts and diagnostics observed 2026-10-04 — area doc flags these as spot-read only.
- Runtime-override propagation (local-only vs server-persisted vs socket-broadcast) and screen-lock vs lockscreen-flow relationship unverified.
- No URL deep-linking: tab state is lost on close; concurrent edits across tabs uncoordinated.
- Role permissions/colors and agent presets are client-hardcoded; server authority unverified.
- Role permissions/colors and agent presets are client-hardcoded; server authority unverified.
- Verify polish: workspace delete drops the nested native confirm for a two-step styled confirm (Flush tables vs Keep DB intact; cancel still deletes without flushing); model tests go through `apiClient.testModelModule` with custom no-probe, 404, and offline copy plus Test/Retry/Fix; mount read failures render cause with per-card Retry and Browse.

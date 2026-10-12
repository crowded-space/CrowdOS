# Portal

## Purpose

Local-first workspace hub: enter or switch workspaces first, create second. The database is an optional enhancement behind a collapsed disclosure. Plus the shared workspace create/edit form elements and the strict delete wizard (same file, reused by settings-class surfaces).

## Feature Scope

In-scope: `WorkspacePortal` two-pane hub (workspace list with filter/keyboard/row menu plus local-first creation form with collapsed optional database), `WorkspaceMark` muted tiles, `portal-support` validation/filter/recency helpers, `WorkspaceManageDialogs` shared pieces (`WorkspaceIconPicker`, `WorkspaceDatabaseField` + state helpers, `WorkspaceFormModal`, `DeleteWorkspaceWizard`, `countWorkspaceChannels`), single-create flow with verified-database-or-local fallback.
Non-goals: in-workspace chrome and chat (see Workspace Shell / Chat Area), settings admin tabs (see Modals), filesystem and socket runtime, screen-lock flows.

## Expect

- `[Observed]` Portal renders only when no workspace is active (`App.tsx:124-135`); otherwise the shell replaces it.
- `[Observed]` Step 2 (name/icon/launch) stays hidden until the DB connection test succeeds.
- `[Observed]` Editing the DB URL after a test resets status to idle and clears the log.
- `[Observed]` Launch requires a non-empty name plus verified connection; provisioning progress disables the button.
- `[Observed]` Existing sessions list shows count and re-enters on click.
- `[Observed]` Shared DB field validates `postgresql://` shape, masks the URL with show/hide, and separates Test from Provision-schema steps.
- `[Observed]` Shared form modal validates name length/duplicate and DB shape before enabling submit.
- `[Observed]` Delete wizard enforces 3 ordered steps: acknowledge checkbox → exact-name match → type `DELETE`; buttons arm only when each gate passes.
- `[Inferred]` Portal create path requires a DB URL (BYODB mandatory at onboarding) while the shared form treats DB as optional/disconnectable — two policies for two contexts.

## Flow

1. Gate: `App.tsx:124-135` shows portal when `!activeWorkspaceId`; portal fetches registry on mount (`WorkspacePortal.tsx:39-41`).
2. Enter URL: `WorkspacePortal.tsx:144-157` input; any edit resets `testStatus` to idle (`WorkspacePortal.tsx:149`).
3. Test: submit `WorkspacePortal.tsx:55-85` pushes staged log lines with 400ms beats, calls `apiClient.testWorkspaceDatabase` (`WorkspacePortal.tsx:12-19`), sets success/failed with inline icon (`WorkspacePortal.tsx:158-167`).
4. Name/icon: Step 2 block, always visible (`WorkspacePortal.tsx:226-265`); 8-icon grid (`WorkspacePortal.tsx:21-30,249-264`); `canCreateDb` = name + verified test, `canCreateLocal` = name only (`WorkspacePortal.tsx:101-103`).
5. Launch: `WorkspacePortal.tsx:87-99` calls `createWorkspace(name, dbUrl, icon)`; store provisions and enters; failures append to log and re-enable.
6. Re-enter: `WorkspacePortal.tsx:318-329` lists `workspaces` with icon + chevron → `enterWorkspace(id)`.
7. Shared create/edit: `WorkspaceFormModal` (`WorkspaceManageDialogs.tsx:344-479`) resets per open (`:371-377`), validates (`:388-396`), resolves DB tri-state keep/set/clear (`:84-91`) on submit (`:460-464`).
8. Shared DB field: Test (`WorkspaceManageDialogs.tsx:121-130`) then Provision (`:132-146`); disconnect is two-click confirm (`:188-207`); `.env` mapping noted (`:335-337`).
9. Delete: `DeleteWorkspaceWizard` (`:491-729`) steps 1→2→3 with `acknowledged`, `nameMatches`, `destroyMatches` gates; `onConfirm` fires only armed (`:713-720`).

## Current Implementation

| Component | Role |
|---|---|
| `portal/WorkspacePortal.tsx` | Onboarding card: DB test log, gated name/icon step, launch, existing-session re-entry |
| `portal/WorkspaceManageDialogs.tsx` (`WorkspaceIconPicker`) | 8-variant labeled icon radiogroup |
| `portal/WorkspaceManageDialogs.tsx` (`WorkspaceDatabaseField`) | BYODB editor: masked URL, test/provision, replace/disconnect/undo |
| `portal/WorkspaceManageDialogs.tsx` (`WorkspaceFormModal`) | Create/edit shell: name + icon + DB field, validation, submit |
| `portal/WorkspaceManageDialogs.tsx` (`DeleteWorkspaceWizard`) | 3-step irreversible-delete flow with stepper |
| `portal/WorkspaceManageDialogs.tsx` (`countWorkspaceChannels`, `initialDatabaseState`, `resolveDatabaseUrl`, `WORKSPACE_ICONS`) | Channel counter, DB tri-state helpers, icon catalog |

## Props & Store

- `WorkspacePortal` — no props; store: `createWorkspace, workspaces, enterWorkspace, fetchWorkspaces, isCreatingWorkspace`; local `workspaceName, selectedIcon, dbUrl, testStatus, logs, isLaunching`.
- `WorkspaceIconPicker { value; onChange }`; `WorkspaceDatabaseField { initial: WorkspaceDatabaseInfo|null|undefined; state: WorkspaceDatabaseState; onChange }` with `{ mode: keep|set|clear; url; provisioned }`.
- `WorkspaceFormModal { open; mode: create|edit; initialName; initialIcon; initialDatabase?; isSaving; error; existingNames; onCancel; onSubmit(name, icon, databaseUrl?, schemaReady?) }`.
- `DeleteWorkspaceWizard { open; workspace: { id, name, icon, categoryCount, channelCount }|null; isDeleting; error; onCancel; onConfirm }`.

## Relations

- Parent: `App.tsx` portal gate; `WorkspaceFormModal`/`DeleteWorkspaceWizard` currently have no observed mount in the 5 assigned areas (likely settings/portal hosts — see Gaps).
- Children: `CrowIcon` for icons; `apiClient` for test/provision; `isPostgresUrl` shape check.
- Store: `fetchWorkspaces` (registry), `createWorkspace` (provision+enter), `enterWorkspace` (re-entry).
- API: `POST /api/workspaces`, `GET /api/workspaces`, `POST /api/workspaces/database/test` (via `apiClient`); provision currently reuses the test call (`src/api/client.ts:220-288`).

## Emits-Listens

- No socket usage in portal files; post-create sync arrives via store handlers (`workspace:sync`, budget/agents refresh after `fetchWorkspaces`).
- DB test/provision are REST-only; launch completion is observed through store state change (`activeWorkspaceId` flips shell into workspace mode).

## Owns

- Onboarding draft (URL/name/icon), test status + terminal log lines, launching flag; form-modal drafts + DB tri-state + wizard step/ack/inputs — all per-mount local state, reset on open.
- No localStorage writes from these files.

## Flags

- `BACKEND_URL = ''` (`WorkspacePortal.tsx:10`) — same-origin calls; no env vars or feature toggles.
- Responsive: `p-4 sm:p-6` shell, `text-[15px] sm:text-[13px]` anti-zoom inputs, `min-h-[44px+]` touch targets, scrollable card (`overflow-y-auto`, session list `max-h-32`).
- `[Observed]` Visual tokens 2026-09-26: single desaturated accent glow (`#465EDB/10`, no violet), `card-elevated` borderless + tinted shadow, square step markers, sentence-case labels, 38ch balanced description.

## Decisions

- `[Observed]` Verify-before-launch: the DB-backed launch button unlocks only after a DB proof; a local workspace needs only a name (`WorkspacePortal.tsx:101-103`).
- `[Observed]` Delete is a 3-step typed ritual while settings delete is a single confirm — different strictness per entry point.
- `[Observed]` DB URL masked by default with explicit reveal; credentials never echoed in logs (redacted `://***@`).
- `[Inferred]` Provision is currently a test-shaped stub (`migrationsApplied: 0`) — UI flow leads the server capability.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Verify-before-launch plus masked DB URL plus strict delete ritual stay; provisioning honesty, DB policy, and switch semantics are the gaps.
Verify-before-launch stays: the DB-backed launch unlocks only after a DB proof; a local workspace needs only a name, and a database-less workspace is an explicit degraded choice.
DB URL stays masked by default with explicit reveal. Credential echo in logs is forbidden.
Delete stays a 3-step typed ritual at the portal entry with proportional strictness at settings delete. Single-confirm irreversible delete is forbidden.
provisionWorkspaceDatabase MUST migrate for real or be labeled a test-shaped stub with the real path documented. Synthetic success presented as provisioning is forbidden.
DB-mandatory versus DB-optional policy MUST agree between portal create, shared form, and server enforcement. Two silent policies are forbidden.
WorkspaceFormModal plus DeleteWorkspaceWizard MUST have verified mounts and onSubmit wiring. Unmounted shared components are forbidden.
Multi-workspace switch MUST document teardown: channel joins, drafts, socket rooms, and pending state. Silent switch leaks are forbidden.
Screen-lock PIN setup MUST have an explicit onboarding decision: offered at onboarding or documented post-hoc-only. Silent absence is forbidden.
## Failure + Resume

- Test failure: `err` log line + failed icon; editing URL resets to idle for a clean retry (`WorkspacePortal.tsx:77-84,149`).
- Launch failure: error appended to log, `isLaunching` released for retry (`WorkspacePortal.tsx:95-98`).
- Field-level: `postgresql://` shape warnings, name too-short/too-long/duplicate blocks, disconnect requires confirm with Undo (`WorkspaceManageDialogs.tsx:216-227`); provision failure still allows save with retry-later note (`:315-320`).
- Wizard errors render inline per step (`:651-663`); Escape/backdrop cancel unless deleting (`:520-527,539`).

## Gaps

- No observed mount for `WorkspaceFormModal` / `DeleteWorkspaceWizard` in assigned areas — callers, `onSubmit` wiring, and whether settings delete should use the wizard are unverified.
- `provisionWorkspaceDatabase` returns a synthetic success without migrating — real provisioning path unverified.
- Portal create mandates DB URL but shared form allows DB-less workspaces; which policy the server enforces is unverified.
- `WorkspaceManageDialogs.test.ts` exists but its coverage wasn't read; test-backed guarantees not claimed here.
- Multi-workspace switch semantics (`enterWorkspace` teardown of channel joins/drafts) unverified from portal scope.
- Screen-lock PIN setup during onboarding not present — lock is settings/post-hoc only.

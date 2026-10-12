# Onboarding flow
> Type: Flow · Status: aligned · Updated: 2026-09-13
## Intent
Take a first launch to a working local workspace, or re-enter an existing session. The database stays optional and never blocks creation.
## Architectural decision
- [Observed] Verify-before-launch: the DB-backed launch button unlocks only after a successful DB test, while a local workspace can still be created without a database (`WorkspacePortal.tsx:101-103`).
- [Observed] Portal create mandates a DB URL while the shared form treats DB as optional — two policies for two contexts (onboarding vs edit).
- [Inferred] Provision currently reuses a test-shaped call (`migrationsApplied: 0`) — the UI flow leads server capability.
## How it works
1. Launch: with no active workspace, `App` renders only the portal card (`App.tsx:124-135`); the portal fetches the workspace registry on mount (`WorkspacePortal.tsx:39-41`).
2. Verify: user enters a DB URL; any edit resets test status to idle; submit logs only real events (a single probing line with the redacted target, then the actual probe result) and calls `apiClient.testWorkspaceDatabase`. No scripted progress lines.
3. Name: Step 2 block always visible (`WorkspacePortal.tsx:226-265`) with an 8-icon grid (`WorkspacePortal.tsx:21-30,249-264`); DB-backed launch needs a non-empty name + verified test, local launch needs only a name (`WorkspacePortal.tsx:101-103`).
4. Provision: launch calls `createWorkspace(name, dbUrl, icon)` (`WorkspacePortal.tsx:87-99`); the store provisions and enters, flipping `activeWorkspaceId` so the shell replaces the portal.
5. Enter workspace: existing sessions list with icons re-enters on click via `enterWorkspace(id)` (`WorkspacePortal.tsx:318-329`).
6. Manage (shared): `WorkspaceFormModal` validates name/duplicate + DB shape before submit (`WorkspaceManageDialogs.tsx:344-479`); delete runs a 3-step typed wizard (`WorkspaceManageDialogs.tsx:491-729`).
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Portal.md> | Owns onboarding card, DB test log, gated identity step, and shared create/edit/delete dialogs |
| <../Domain Spec/Client Infra.md> | Owns boot gate, `apiClient` workspace/database endpoints, and shell handoff |
| <../Domain Spec/Stores.md> | Owns `fetchWorkspaces`, `createWorkspace`, and `enterWorkspace` state transitions |
## Current state
Portal gate → DB test → name/icon → provision → shell entry, plus click-to-re-enter, matches the Portal area doc.
## Alignment notes
none found
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Verify-before-launch stays: the DB-backed launch unlocks only after a DB proof; a local workspace needs only a name, and a database-less workspace is an explicit degraded choice.
* DB URL stays masked by default with explicit reveal. Credential echo in logs is forbidden.
* Launch requires non-empty name plus verified connection with provisioning progress disabling the button.
* provisionWorkspaceDatabase migrates for real or is labeled test-shaped stub with the real path documented. Synthetic success as provisioning is forbidden.
* DB-mandatory versus DB-optional policy agrees between portal create, shared form, and server enforcement. Two silent policies are forbidden.
* WorkspaceFormModal plus DeleteWorkspaceWizard have verified mounts and onSubmit wiring. Unmounted shared components are forbidden.
* Multi-workspace switch documents teardown of joins, drafts, rooms, and pending state. Screen-lock PIN setup has an explicit onboarding or post-hoc-only decision. Authority: Portal area doc; Workspace, Filesystem standards.
## Open gaps
- No observed mount for `WorkspaceFormModal` / `DeleteWorkspaceWizard` in the assigned areas — callers and submit wiring unverified.
- Real provisioning path unverified: provision currently returns a synthetic success without migrating.
- Which DB policy the server enforces (mandatory at create vs optional/disconnectable on edit) is unverified.
- Screen-lock PIN setup during onboarding is absent — lock is post-hoc settings only.

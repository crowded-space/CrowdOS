# Desktop Feature and Flow index

Map only. Truth lives in the doc + its linked domain doc.

## Features

| Doc | Status | Domain docs |
|---|---|---|
| <IPC bridge and contracts.md> | aligned | <../Domain Spec/Desktop Shell.md> |
| <Embedded backend.md> | aligned | <../Domain Spec/Desktop Shell.md> |
| <Security policy and navigation guard.md> | aligned | <../Domain Spec/Desktop Shell.md> |
| <Notifications and deep links.md> | aligned | <../Domain Spec/Desktop Shell.md> |
| <Tray menu and updater.md> | drifting | <../Domain Spec/Desktop Shell.md> |
| <Dialogs and windows.md> | aligned | <../Domain Spec/Desktop Shell.md> |

## Flows

| Doc | Status | Domain docs |
|---|---|---|
| <Database ensure and migrate.md> | aligned | <../Domain Spec/Desktop Shell.md> |
| <Packaging and release.md> | drifting | <../Domain Spec/Desktop Shell.md> |

Rule: new feature/flow doc → same task adds its row here.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the doc plus its linked domain doc. Every desktop feature and flow doc carries a Target Contract section that is flow-scoped; authority stays in the Desktop Shell domain spec.
* New feature or flow doc → same task adds its row here plus a Target Contract in the doc.
* aligned means current-state verified. drifting means recorded drift versus code, with Target Contract stating the required end state.

# Frontend Feature and Flow index

Map only. Truth lives in the doc + its linked area docs.

## Features

| Doc | Status | Area docs |
|---|---|---|
| <Message rendering.md> | aligned | <../Domain Spec/Chat Area.md> |
| <Approval cards and delegation timeline.md> | aligned | <../Domain Spec/Chat Area.md> |
| <Omni-search.md> | aligned | <../Domain Spec/Modals.md> |
| <Settings panels.md> | aligned | <../Domain Spec/Modals.md> |
| <Mention autocomplete.md> | aligned | <../Domain Spec/Chat Area.md> |
| <Toasts and error boundaries.md> | aligned | <../Domain Spec/Client Infra.md> |

## Flows

| Doc | Status | Area docs |
|---|---|---|
| <Studio editing flow.md> | aligned | <../Domain Spec/Agent Studio.md> |
| <Send-message flow.md> | aligned | <../Domain Spec/Chat Area.md> <../Domain Spec/Stores.md> <../Domain Spec/Client Infra.md> |
| <Approval decide flow.md> | aligned | <../Domain Spec/Chat Area.md> |
| <Reconnect digest flow.md> | aligned | <../Domain Spec/Client Infra.md> <../Domain Spec/Stores.md> |
| <Screen-lock flow.md> | drifting | <../Domain Spec/LockScreen.md> |
| <Onboarding flow.md> | aligned | <../Domain Spec/Portal.md> |
| <Explorer ops flow.md> | aligned | <../Domain Spec/Filesystem Explorer.md> <../Domain Spec/Chat Area.md> <../Domain Spec/Workspace Shell.md> |

## Cross-links (feature ↔ flow)

- Approval cards and delegation timeline ↔ Approval decide flow
- Message rendering ↔ Send-message flow
- Settings panels ↔ Screen-lock flow (PIN panel)

Rule: new feature/flow doc → same task adds its row here + cross-links.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the doc plus its linked area docs. Every frontend feature and flow doc carries a Target Contract section that is flow-scoped; authority stays in the linked area docs and backend domain standards.
* New feature or flow doc → same task adds its row here plus cross-links plus a Target Contract in the doc.
* aligned means current-state verified. drifting means recorded drift versus code, with Target Contract stating the required end state.

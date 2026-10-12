# Screen-lock flow
> Type: Flow · Status: drifting · Updated: 2026-09-13
## Intent
Block casual physical access with a non-dismissible PIN veil that also drops credentials and realtime, so locked means no new data can arrive.
## Architectural decision
- [Observed] Lock drops the held PIN (memory + localStorage mirror) and disconnects the socket — the veil is backed by an actual disconnect, not theater (`screenLockStore.ts:51-58`).
- [Observed] Already-rendered content is blur-hidden, not purged — documented in-code as surface-level protection (`screenLockStore.ts:9-13`).
- [Observed] One shared unlock path (`unlockWithPin`) is the only keyhole: set PIN → socket re-handshake → refetch → clear lock (`screenLockStore.ts:60-72`).
## How it works
1. Lock trigger (idle): `App` wires `mousemove`/`keydown` to throttled `touchActivity` with a 10 s interval + focus check; idle past 5 min locks workspaces with `screenLockEnabled` (`App.tsx:54-75`, `screenLockStore.ts:21-22,44-47`).
2. Lock trigger (401): a screenlock-shaped fetch error during workspace refresh calls `lock()` and clears tenant slices (`crowdOsStore.ts:1717-1722,1801-1810`).
3. Veil: `App` mounts `<LockScreen/>` over the shell when `locked`; the veil is a full-viewport blurred `role="dialog"` modal with no close path (`App.tsx:181`, `LockScreen.tsx:36-42`).
4. PIN entry: the overlay autofocuses the PIN input and gates submit on non-empty, non-busy state (`LockScreen.tsx:18-20,22-24,50-67`).
5. Verify: `unlockWithPin` trims, stores the PIN, forces `socket.disconnect().connect()`, and refetches workspaces; a still-screenlock error returns false and stays locked (`screenLockStore.ts:60-72`, `LockScreen.tsx:28-33`).
6. Unlock: success clears the input and lock state; wrong PIN shows an inline alert and keeps the veil (`LockScreen.tsx:29,69-73`).
7. Refresh: post-unlock state arrives via the refetch; gap-fill and digest resume through the store reconnect path.
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/LockScreen.md> | Owns veil UX, lock/unlock store, idle/401 triggers, and PIN setup panel |
| <../Domain Spec/Stores.md> | Owns `fetchWorkspaces` refetch, 401 detection, and tenant-slice clearing |
| <../Domain Spec/Client Infra.md> | Owns socket instance, PIN header injection, and reconnect backoff |
## Current state
Idle/401 lock → credential drop + disconnect → veil → PIN → re-handshake + refetch → unlock matches the LockScreen area doc end to end.
## Alignment notes
- `LockScreen.tsx:6-10` comments that the veil is "rendered at the App root so it covers portal and workspace alike", but `App.tsx:124-135,181` mounts it only in the workspace-shell branch — the portal branch has no veil, so lock state is invisible with no active workspace.
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Lock stays backed by credential drop plus socket disconnect. Veil-only theater is forbidden. Unlock stays through one shared unlockWithPin path.
* refreshSocketPin is a real socket credential refresh or is removed with unlock re-auth documented through the fetch path. Called-on-unlock no-op stubs are forbidden.
* Manual Lock now has a verified entry point or is removed from the store contract.
* Unlock on non-screenlock fetch failure does not clear locked, or explicitly documents the unlocked-but-stale signal contract. Silent stale unlock is forbidden.
* Portal branch has a defined lock behavior: veil coverage or explicit unlocked-portal contract. SetLocked raw setter has a verified caller or is removed. Authority: LockScreen area doc; Pin domain standard.
## Open gaps
- No "Lock now" caller observed despite the store comment naming manual lock as a trigger — entry point unverified.
- `refreshSocketPin()` is a no-op stub; socket re-auth on unlock relies on the fetch PIN patch, not a real credential refresh.
- Unlock on non-screenlock fetch failure still clears `locked`, leaving an unlocked-but-stale shell with only `workspaceError` as signal.

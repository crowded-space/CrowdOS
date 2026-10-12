# LockScreen

## Purpose

Surface-level screenlock against casual physical access (explicitly not full auth): a non-dismissible PIN veil that, on lock, also drops the local PIN copy and disconnects realtime so no new data can arrive until a PIN is re-entered.

## Feature Scope

In-scope: lock/unlock overlay UX, idle/focus/401 lock triggers, per-workspace opt-in PIN setup (set/change/disable), local PIN storage.

Non-goals (other areas): real authentication/authorization (server pin-gate), chat/workspace UX (shell components), API/socket plumbing details (Client Infra), global state architecture (Stores).

## Expect

- `[Observed]` When locked, a full-viewport blurred veil (`z-[200]`, `role="dialog" aria-modal`) covers the workspace shell with no close path and no Escape handling (`LockScreen.tsx:36-42`).
- `[Observed]` The only way out is submitting a PIN the backend accepts; wrong PIN shows an inline alert and stays locked (`LockScreen.tsx:22-34,69-73`).
- `[Observed]` Locking clears the in-memory + localStorage PIN and disconnects the socket; already-rendered content is hidden by blur, not purged (`screenLockStore.ts:51-58`).
- `[Observed]` Idle lock fires only for workspaces with screenlock enabled, after 5 min without activity, checked every 10 s and on window focus (`App.tsx:54-75`, `screenLockStore.ts:21`).
- `[Observed]` Any `fetchWorkspaces` 401-shaped screenlock error (matched by `/screenlock/i`) locks the client and clears tenant slices (`crowdOsStore.ts:1717-1722,1801-1810`; `screenLockStore.ts:25-26`).
- `[Observed]` Unlock re-handshakes the socket and refetches workspaces through one shared path (`unlockWithPin`); success clears the input (`LockScreen.tsx:29`, `screenLockStore.ts:60-72`).
- `[Observed]` Settings panel never displays the PIN, only an enabled/disabled badge (`ScreenLockSettingsPanel.tsx:138-147`).
- `[Inferred]` Manual "Lock now" exists as a store action but no caller was observed in the files read.

## Flow

1. Opt in: user sets a PIN in the workspace settings panel — validations (≥4 / ≤128 chars, confirm match, current PIN required when already enabled), `POST` via `apiClient`, then `setPin` so this client stays authenticated (`ScreenLockSettingsPanel.tsx:61-98`).
2. Change/disable: same panel; current PIN required; disable calls `DELETE` then `clearPin` (`ScreenLockSettingsPanel.tsx:100-123`).
3. Idle lock: `App` wires `mousemove`/`keydown` → throttled `touchActivity` and interval/focus checks → `lock()` when `screenLockEnabled` and idle past `SCREENLOCK_IDLE_MS` (`App.tsx:54-75`).
4. 401 lock: `fetchWorkspaces` (roster or tenant fetch) sees a screenlock 401 → `lock()` + `clearTenantSlices()` (`crowdOsStore.ts:1717-1722,1801-1810`).
5. Unlock: overlay autofocuses PIN input (`LockScreen.tsx:18-20`); submit → `unlockWithPin`: trim → `setPin` → socket re-handshake → `fetchWorkspaces` → still a screenlock error means failure, else `locked: false` (`screenLockStore.ts:60-72`).
6. Panel stays in sync: enable/disable mirrors `screenLockEnabled` onto the workspace row via direct `setState` (`ScreenLockSettingsPanel.tsx:49-59`).

## Current Implementation

| Component | Role |
|---|---|
| `LockScreen` (`components/lockscreen/LockScreen.tsx`) | Veil + PIN form; local `pin`/`unlocking`/`failed` state; autofocus; submit gating |
| `useScreenLockStore` (`stores/screenLockStore.ts`) | `locked`, `lastActivity`, `touchActivity` (5 s throttle), `setLocked`, `lock`, `unlockWithPin`, `isScreenlockError` |
| `ScreenLockSettingsPanel` (`components/workspace/ScreenLockSettingsPanel.tsx`) | Per-workspace PIN status, set/change/disable forms, validation + error/notice states |
| Idle wiring (`src/App.tsx:54-75`) | Activity listeners, 10 s interval check, focus check, per-workspace enable gate |
| PIN storage (`src/config/pin.ts`) | Memory-first PIN with localStorage mirror (`crowdos_pin`) + `VITE_LOCAL_PIN` fallback |

## Props & Store

- `LockScreen`: no props; reads `unlockWithPin` from `useScreenLockStore` (`LockScreen.tsx:12`).
- `ScreenLockSettingsPanel`: props `{ workspaceId: string }`; local `loading/saving/enabled/newPin/confirmPin/currentPin/error/notice` state; reads `apiClient`, `setPin`/`clearPin`, and `useCrowdOSStore` (one direct `setState` mirror).
- `useScreenLockStore` slice: `locked: boolean`, `lastActivity: number`, actions `touchActivity`, `setLocked`, `lock`, `unlockWithPin`.

## Relations

- Parents: `App` renders `<LockScreen/>` only in the workspace-shell branch when `locked` (`App.tsx:181`); the portal (no-workspace) branch has no veil.
- Children: none (raw elements + `lucide-react` `Lock` icon).
- Store: calls `useCrowdOSStore.fetchWorkspaces` + reads `workspaceError` on unlock; writes `workspaces[].screenLockEnabled` from the panel.
- API (via `apiClient`): `GET` screen-lock status, `POST` set PIN, `DELETE` disable PIN (`src/api/client.ts:314-341`).
- Socket: `lock()` calls `socket.disconnect()`; `unlockWithPin` calls `refreshSocketPin()` (currently a no-op — Client Infra) then `disconnect().connect()`.

## Emits-Listens

- Socket sent: none directly (only connect/disconnect side effects via the shared socket instance).
- Socket received: none in this area (401 detection happens on REST responses in the store).
- Store actions: `touchActivity` (on mousemove/keydown), `lock` (interval/focus/401 paths), `unlockWithPin` (overlay submit), `setLocked` (no caller observed in files read).

## Owns

`locked`, `lastActivity` (throttled timestamp), overlay-local `pin`/`unlocking`/`failed` form state, panel-local form/notice state. PIN itself is owned by `src/config/pin.ts` (memory + `crowdos_pin` mirror), not this store.

## Flags

`SCREENLOCK_IDLE_MS = 5 min`, `ACTIVITY_THROTTLE_MS = 5 s` (`screenLockStore.ts:21-22`) — constants, no env vars or toggles. Per-workspace opt-in flag `screenLockEnabled` (server-sourced).

## Decisions

- `[Observed]` Lock drops credentials + realtime, so "locked means no new data can arrive" — the veil is backed by an actual disconnect (`screenLockStore.ts:6-18,51-58`).
- `[Observed]` Stale tenant rows are cleared on 401-lock (`clearTenantSlices`), but already-rendered content behind the veil is blur-hidden, not purged — documented in-code as surface-level (`screenLockStore.ts:9-13`).
- `[Observed]` One shared unlock path for the overlay ("exactly one keyhole", `screenLockStore.ts:17-18`).
- `[Observed]` Panel writes through `apiClient` while unlock verification goes through `fetchWorkspaces` — two paths, one gate signal (`workspaceError`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Disconnect-backed veil plus single unlock path stay; socket re-auth, lock triggers, error matching, and portal coverage are the gaps.
Lock stays backed by credential drop plus socket disconnect. Veil-only theater without disconnect is forbidden.
Unlock stays through one shared unlockWithPin path. Parallel unlock paths are forbidden.
refreshSocketPin MUST be a real socket credential refresh or be removed with unlock re-auth documented through the fetch path. Called-on-unlock no-op stubs are forbidden.
Manual Lock now MUST have a verified entry point or be removed from the store contract. Documented-but-unwired triggers are forbidden.
setLocked raw setter MUST have a verified caller or be removed. Unused public setters are forbidden.
PIN length rules MUST match the server contract enforced in Pin and Workspace domains. Client-only length rules are forbidden.
isScreenlockError MUST match a narrow error code or typed signal, never substring screenlock. Broad message matching is forbidden.
Veil MUST have attempt throttling plus cooldown messaging. Unlimited silent retry is forbidden.
Caps-Lock warning plus per-workspace or user-configurable idle timeout are required or explicitly deferred with a decision record.
Portal branch MUST have a defined lock behavior: veil coverage or explicit unlocked-portal contract. Silent invisible lock state is forbidden.
## Failure + Resume

- Wrong PIN: inline `role="alert"` message, input kept, stays locked (`LockScreen.tsx:69-73`).
- Unlock with non-screenlock fetch failure still clears `locked` (`screenLockStore.ts:60-72` returns true unless the error matches screenlock) — a failed refetch can leave an unlocked-but-stale shell; the store-level `workspaceError` is the only signal.
- `lock()` is idempotent and disconnect is `try/catch`-guarded (`screenLockStore.ts:51-58`).
- Panel load failure shows an inline error with no retry button; save/disable failures show inline errors and keep form state (`ScreenLockSettingsPanel.tsx:125-131,212-217`).
- Locked + no active workspace renders the portal branch with no veil (`App.tsx:124-135`) — lock state is invisible there until a workspace is entered.
- Reconnect behavior: unlock forces `socket.disconnect().connect()`; gap-fill/digest is owned by the store layer (Stores).

## Gaps

- `refreshSocketPin()` is a no-op (`src/config/socket.ts:124-126`); socket re-auth on unlock relies on the fetch PIN patch, not a real socket credential refresh.
- No "Lock now" button observed in the files read despite the store comment naming manual lock as a trigger.
- No `setLocked` caller observed; unclear whether anything uses the raw setter.
- PIN length upper bound (128) and 4-char minimum are client-side only; server rules unverified.
- `isScreenlockError` matches any message containing "screenlock" (case-insensitive) — broad enough to misfire on unrelated text.
- Veil has no Caps-Lock warning, no attempt throttling, no cooldown messaging.
- `ACTIVITY_THROTTLE_MS`/`SCREENLOCK_IDLE_MS` are single constants — no per-workspace or user-configurable timeout (noted in-code as deferred).

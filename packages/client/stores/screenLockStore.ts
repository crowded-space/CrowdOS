import { create } from 'zustand';
import { clearPin, setPin } from '../src/config/pin';
import { refreshSocketPin, socket } from '../src/config/socket';
import { useCrowdOSStore } from './crowdOsStore';

// Literal lock screen state (blurred overlay + PIN gate).
//
// Model (deliberately small):
// - `locked` only gates the UI overlay. Locking also drops the held PIN
//   (memory + localStorage mirror) and disconnects the socket, so locked
//   means no new data can arrive until a PIN is re-entered — the overlay
//   is not theater. Already-rendered content is hidden by blur, not purged
//   (surface-level screenlock, same bar as the server pin-gate claims).
// - Lock triggers: screenlock-401 from the API, idle timeout (only when a
//   PIN is held — nothing to protect otherwise), window focus past the
//   timeout, or manual "Lock now".
// - Unlock = present PIN -> re-handshake socket -> refetch. One shared
//   path (unlockWithPin) for the overlay, so there is exactly one keyhole.

// ponytail: single constant, no settings UI — add configurability when asked.
export const SCREENLOCK_IDLE_MS = 5 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 5000;

/** True when a backend error message is a screenlock 401 (the unlock cue). */
export const isScreenlockError = (msg: unknown): boolean =>
  typeof msg === 'string' && /screenlock/i.test(msg);

interface ScreenLockState {
  locked: boolean;
  lastActivity: number;
  /** Record user activity (throttled). Subscribed selectively — cheap. */
  touchActivity: () => void;
  setLocked: (locked: boolean) => void;
  /** Drop credentials + realtime, show the overlay. Idempotent. */
  lock: () => void;
  /** Present PIN, re-handshake, refetch. True when the backend accepts it. */
  unlockWithPin: (pin: string) => Promise<boolean>;
}

export const useScreenLockStore = create<ScreenLockState>()((set, get) => ({
  locked: false,
  lastActivity: Date.now(),

  touchActivity: () => {
    const now = Date.now();
    if (now - get().lastActivity > ACTIVITY_THROTTLE_MS) set({ lastActivity: now });
  },

  setLocked: (locked: boolean) => set({ locked }),

  lock: () => {
    if (get().locked) return;
    clearPin();
    try {
      socket.disconnect();
    } catch {}
    set({ locked: true });
  },

  unlockWithPin: async (pin: string) => {
    const clean = pin.trim();
    if (!clean) return false;
    setPin(clean);
    try {
      refreshSocketPin();
      socket.disconnect().connect();
    } catch {}
    await useCrowdOSStore.getState().fetchWorkspaces();
    if (isScreenlockError(useCrowdOSStore.getState().workspaceError)) return false;
    set({ locked: false, lastActivity: Date.now() });
    return true;
  },
}));

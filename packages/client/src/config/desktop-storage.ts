// Renderer storage split for desktop (P1c, Zero-Auth: PIN stays in localStorage).
//
// Grep inventory (packages/client/stores/crowdOsStore.ts + packages/client/src,
// 2026-09-03; `localStorage.getItem|setItem|removeItem` + `crowdos_` prefix sweep):
//
// | #  | key                              | kind     | notes                                                        |
// |----|----------------------------------|----------|--------------------------------------------------------------|
// | 1  | crowdos_pin                      | ui-pref  | Zero-Auth PIN (src/config/pin.ts). MUST stay in localStorage |
// | 2  | crowdos_active_channel           | ui-pref  | last open channel (store + src/config/socket.ts)             |
// | 3  | crowdos_active_workspace         | ui-pref  | last open workspace                                          |
// | 4  | crowdos_selected_mode            | ui-pref  | composer mode (only persisted when pinned)                   |
// | 5  | crowdos_is_pinned                | ui-pref  | composer pin flag                                            |
// | 6  | crowdos_muted_channels           | ui-pref  | mute map JSON (store + MainChatArea.tsx)                     |
// | 7  | crowdos_mute_<channelId>         | ui-pref  | legacy per-channel flag (`crowdos_mute_` prefix scan)        |
// | 8  | crowdos_quick_access             | ui-pref  | capped (8) portal recents                                    |
// | 9  | crowdos_seq_cursors              | cursor   | channelId -> last seq; gap/digest resume                     |
// | 10 | crowdos_messages                 | cursor   | capped per-channel message mirror (largest; evict first)     |
// | 11 | (reconnectDigest)                | cursor*  | in-memory only today — no localStorage key; future cursors.json |
// | 12 | crowdos_workspaces               | unknown  | server-mirror cache, refetchable via fetchWorkspaces         |
// | 13 | crowdos_agents                   | unknown  | server-mirror cache (roster / runtime:snapshot)              |
// | 14 | crowdos_model_profiles           | unknown  | module cache, refetchable                                    |
// | 15 | crowdos_instruction_modules      | unknown  | module cache, refetchable                                    |
// | 16 | crowdos_model_modules            | unknown  | module cache, refetchable                                    |
// | 17 | crowdos_toolkit_modules          | unknown  | module cache, refetchable                                    |
// | 18 | crowdos_constraints_modules      | unknown  | module cache, refetchable                                    |
// | 19 | crowdos_capabilities_modules     | unknown  | module cache, refetchable                                    |
// | —  | theme/sidebar keys               | ui-pref* | none found in grep; reserved — append here if added later    |
//
// Classification: `ui-pref` = tiny prefs that stay in localStorage and are
// never auto-evicted. `cursor` = restart-survival state that will move to main
// userData (cursors.json) in a later phase; for now localStorage with quota
// guard (evictable). `unknown` = server-mirror caches; safe to drop, not
// auto-evicted by safeSet today.
//
// TODO (later phase): async persistence of CURSOR_KEYS to main userData via
// window.crowdos (userData/cursors.json). This module stays sync/localStorage
// only and must NOT depend on window.crowdos.

export type StorageKind = 'ui-pref' | 'cursor' | 'unknown';

/** Small UI prefs that stay in localStorage (never auto-evicted). */
export const UI_PREF_KEYS: readonly string[] = [
  'crowdos_pin',
  'crowdos_active_channel',
  'crowdos_active_workspace',
  'crowdos_selected_mode',
  'crowdos_is_pinned',
  'crowdos_muted_channels',
  'crowdos_quick_access',
];

/** Prefix for legacy per-channel mute flags; shares `ui-pref` classification. */
export const MUTE_KEY_PREFIX = 'crowdos_mute_';

/**
 * Restart-survival mirrors. Future home: main userData (cursors.json).
 * For now localStorage with quota guard — largest entry is evicted first.
 */
export const CURSOR_KEYS: readonly string[] = [
  'crowdos_seq_cursors',
  'crowdos_messages',
];

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export function getStorageKind(key: string): StorageKind {
  if (!key) return 'unknown';
  if ((UI_PREF_KEYS as readonly string[]).indexOf(key) !== -1) return 'ui-pref';
  if (key === 'crowdos_muted_channels' || key.indexOf(MUTE_KEY_PREFIX) === 0) return 'ui-pref';
  if ((CURSOR_KEYS as readonly string[]).indexOf(key) !== -1) return 'cursor';
  return 'unknown';
}

export function safeGet(key: string): string | null {
  if (!hasLocalStorage() || !key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeRemove(key: string): void {
  if (!hasLocalStorage() || !key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore (private-mode / unavailable storage)
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === 'QuotaExceededError') return true;
  if (e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (e.code === 22) return true;
  return false;
}

/** Remove the largest CURSOR_KEYS mirror to free quota. Returns evicted key or null. */
function evictLargestCursorMirror(excludeKey?: string): string | null {
  if (!hasLocalStorage()) return null;
  let largestKey: string | null = null;
  let largestSize = 0;
  for (const k of CURSOR_KEYS) {
    if (k === excludeKey) continue;
    let size = 0;
    try {
      const v = localStorage.getItem(k);
      size = v ? v.length : 0;
    } catch {
      size = 0;
    }
    if (size > largestSize) {
      largestSize = size;
      largestKey = k;
    }
  }
  // Fall back to the key being written if it is itself a cursor mirror and
  // nothing else was found (e.g. single huge crowdos_messages value).
  if (!largestKey && excludeKey && (CURSOR_KEYS as readonly string[]).indexOf(excludeKey) !== -1) {
    largestKey = excludeKey;
  }
  if (!largestKey) return null;
  try {
    localStorage.removeItem(largestKey);
  } catch {
    return null;
  }
  return largestKey;
}

export function safeSet(key: string, value: string): void {
  if (!hasLocalStorage() || !key) return;
  try {
    localStorage.setItem(key, value);
    return;
  } catch (err) {
    if (!isQuotaError(err)) return;
  }
  // On QuotaExceededError: drop the largest CURSOR_KEYS mirror, retry once.
  evictLargestCursorMirror(key);
  try {
    localStorage.setItem(key, value);
  } catch {
    // give up — caller state stays in memory; never throw from storage helper
  }
}

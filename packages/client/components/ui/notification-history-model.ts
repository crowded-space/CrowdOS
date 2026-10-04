/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notification history journal + DND schedule (Phase G, local-only).
//
// The live toast stack stays per-ToastProvider mount (max 3 stacked, quiet
// role=status vs assertive role=alert). This module is the persisted record
// behind the notification center: every toast() call plus every real
// dispatch projection (approvals, run completions/failures, mentions) lands
// here newest-first, capped, in localStorage. No server endpoint, no second
// run/approval model: rows only reference channel/run/approval ids owned by
// the store, and the center routes back to them via applyDeepLink.
//
// DND is a local quiet-hours schedule (crowdos_notification_dnd). It gates
// the center badge only. The store OS-notify path (run.status_changed ->
// new Notification) is mute-aware but not DND-aware, and window.crowdos
// exposes invoke/on + pickDirectory only, so there is no renderer->main
// tray/badge path for an OS tray count. Both are recorded as honest gaps
// in the Toasts flow doc, never invented here.

export type notificationKind = 'approval' | 'failure' | 'mention' | 'run' | 'toast';

export interface notificationHistoryEntry {
  id: string;
  kind: notificationKind;
  title: string;
  detail: string | null;
  channelId: string | null;
  runId: string | null;
  approvalId: string | null;
  receivedAt: string;
  assertive: boolean;
  read: boolean;
}

export type notificationDraft = Omit<notificationHistoryEntry, 'read'> & { read?: boolean };

export interface dndSchedule {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

export const NOTIFICATION_HISTORY_KEY = 'crowdos_notification_history';
export const NOTIFICATION_DND_KEY = 'crowdos_notification_dnd';
export const NOTIFICATION_HISTORY_CAP = 100;
export const NOTIFICATION_HISTORY_EVENT = 'crowdos:notification-history';

export const DEFAULT_DND_SCHEDULE: dndSchedule = { enabled: false, startHour: 22, endHour: 7 };

function canStore(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function emitHistoryChanged(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(NOTIFICATION_HISTORY_EVENT));
    }
  } catch {
    // History signal is best-effort; the live list still renders.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asKind(value: unknown): notificationKind | null {
  if (value === 'approval' || value === 'failure' || value === 'mention' || value === 'run' || value === 'toast') {
    return value;
  }
  return null;
}

function asEntry(value: unknown): notificationHistoryEntry | null {
  if (!isRecord(value)) return null;
  const kind = asKind(value.kind);
  if (!kind || typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.title !== 'string' || !value.title) return null;
  return {
    id: value.id,
    kind,
    title: value.title,
    detail: typeof value.detail === 'string' ? value.detail : null,
    channelId: typeof value.channelId === 'string' ? value.channelId : null,
    runId: typeof value.runId === 'string' ? value.runId : null,
    approvalId: typeof value.approvalId === 'string' ? value.approvalId : null,
    receivedAt: typeof value.receivedAt === 'string' ? value.receivedAt : new Date().toISOString(),
    assertive: value.assertive === true,
    read: value.read === true,
  };
}

export function loadNotificationHistory(): notificationHistoryEntry[] {
  if (!canStore()) return [];
  try {
    const raw = localStorage.getItem(NOTIFICATION_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: notificationHistoryEntry[] = [];
    for (const item of parsed) {
      const entry = asEntry(item);
      if (entry && !out.some(function (e) { return e.id === entry.id; })) out.push(entry);
    }
    return out
      .sort(function (a, b) { return a.receivedAt < b.receivedAt ? 1 : -1; })
      .slice(0, NOTIFICATION_HISTORY_CAP);
  } catch {
    return [];
  }
}

export function saveNotificationHistory(entries: notificationHistoryEntry[], notify = true): void {
  if (!canStore()) return;
  try {
    const capped = entries
      .slice()
      .sort(function (a, b) { return a.receivedAt < b.receivedAt ? 1 : -1; })
      .slice(0, NOTIFICATION_HISTORY_CAP);
    localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(capped));
    if (notify) emitHistoryChanged();
  } catch {
    // Quota or private-mode failure: the live list still renders.
  }
}

export function appendNotificationHistory(draft: notificationDraft): void {
  if (!draft || typeof draft.id !== 'string' || !draft.id) return;
  if (!asKind(draft.kind)) return;
  if (typeof draft.title !== 'string' || !draft.title) return;
  const prev = loadNotificationHistory();
  const existing = prev.find(function (e) { return e.id === draft.id; });
  if (existing) {
    // Refresh mutable fields but never resurrect read state: a re-fired
    // dispatch for the same id must not mark a read row unread.
    existing.title = draft.title;
    existing.detail = draft.detail ?? null;
    existing.channelId = draft.channelId ?? null;
    existing.runId = draft.runId ?? null;
    existing.approvalId = draft.approvalId ?? null;
    saveNotificationHistory(prev);
    return;
  }
  const entry: notificationHistoryEntry = {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    detail: draft.detail ?? null,
    channelId: draft.channelId ?? null,
    runId: draft.runId ?? null,
    approvalId: draft.approvalId ?? null,
    receivedAt: draft.receivedAt || new Date().toISOString(),
    assertive: draft.assertive === true,
    read: draft.read === true,
  };
  saveNotificationHistory([entry, ...prev]);
}

export function markNotificationRead(id: string): void {
  if (!id) return;
  const prev = loadNotificationHistory();
  const target = prev.find(function (e) { return e.id === id; });
  if (!target || target.read) return;
  target.read = true;
  saveNotificationHistory(prev);
}

export function markAllNotificationsRead(): void {
  const prev = loadNotificationHistory();
  if (!prev.some(function (e) { return !e.read; })) return;
  for (const e of prev) e.read = true;
  saveNotificationHistory(prev);
}

export function clearNotificationHistory(): void {
  if (!canStore()) return;
  try {
    localStorage.removeItem(NOTIFICATION_HISTORY_KEY);
  } catch {
    // Ignore: the change event below still refreshes the live list.
  }
  emitHistoryChanged();
}

export function subscribeNotificationHistory(listener: () => void): () => void {
  if (typeof window === 'undefined') return function () {};
  const handler = function () { listener(); };
  window.addEventListener(NOTIFICATION_HISTORY_EVENT, handler);
  window.addEventListener('storage', handler);
  return function () {
    window.removeEventListener(NOTIFICATION_HISTORY_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

function clampHour(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(23, Math.floor(value)));
  }
  return fallback;
}

export function loadDndSchedule(): dndSchedule {
  if (!canStore()) return { ...DEFAULT_DND_SCHEDULE };
  try {
    const raw = localStorage.getItem(NOTIFICATION_DND_KEY);
    if (!raw) return { ...DEFAULT_DND_SCHEDULE };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_DND_SCHEDULE };
    return {
      enabled: parsed.enabled === true,
      startHour: clampHour(parsed.startHour, DEFAULT_DND_SCHEDULE.startHour),
      endHour: clampHour(parsed.endHour, DEFAULT_DND_SCHEDULE.endHour),
    };
  } catch {
    return { ...DEFAULT_DND_SCHEDULE };
  }
}

export function saveDndSchedule(schedule: dndSchedule): void {
  if (!canStore()) return;
  try {
    const next: dndSchedule = {
      enabled: schedule.enabled === true,
      startHour: clampHour(schedule.startHour, DEFAULT_DND_SCHEDULE.startHour),
      endHour: clampHour(schedule.endHour, DEFAULT_DND_SCHEDULE.endHour),
    };
    localStorage.setItem(NOTIFICATION_DND_KEY, JSON.stringify(next));
  } catch {
    // DND edit stays in memory for this mount.
  }
}

// Local quiet-hours check (device timezone). Equal bounds mean full-day
// quiet; overnight windows (start > end) wrap past midnight.
export function isDndActive(schedule: dndSchedule, atMs?: number): boolean {
  if (!schedule || schedule.enabled !== true) return false;
  const hour = new Date(typeof atMs === 'number' ? atMs : Date.now()).getHours();
  const start = clampHour(schedule.startHour, DEFAULT_DND_SCHEDULE.startHour);
  const end = clampHour(schedule.endHour, DEFAULT_DND_SCHEDULE.endHour);
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function formatDndLabel(schedule: dndSchedule): string {
  if (!schedule || schedule.enabled !== true) return 'DND off';
  const pad = function (h: number): string {
    return String(clampHour(h, 0)).padStart(2, '0') + ':00';
  };
  return 'DND ' + pad(schedule.startHour) + '-' + pad(schedule.endHour);
}

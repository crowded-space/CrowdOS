/**
 * Portal support helpers: validation, filtering, recents metadata.
 * Pure functions stay here so unit tests cover behavior without rendering.
 */

export const WORKSPACE_NAME_MAX = 100;
export const WORKSPACE_NAME_MIN = 2;
export const PORTAL_LAST_OPENED_KEY = 'crowdos_portal_last_opened';
export const PORTAL_HIDDEN_KEY = 'crowdos_portal_hidden';
export const PORTAL_ICON_IDS = [
  'crow-white-rounded',
  'crow-dark-rounded',
  'crow-indigo-circle',
  'crow-amber-cyber',
  'crow-cyan-radar',
  'crow-rose-governance',
  'crow-matrix-terminal',
  'crow-cosmos',
] as const;
export type portalIconId = (typeof PORTAL_ICON_IDS)[number];

export type nameValidation =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'too-short' | 'too-long' | 'duplicate' | 'invalid-chars' };

const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

export function validateWorkspaceName(name: string, existingNames: string[]): nameValidation {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length < WORKSPACE_NAME_MIN) return { ok: false, reason: 'too-short' };
  if (trimmed.length > WORKSPACE_NAME_MAX) return { ok: false, reason: 'too-long' };
  if (INVALID_NAME_CHARS.test(trimmed)) return { ok: false, reason: 'invalid-chars' };
  const lower = trimmed.toLowerCase();
  if (existingNames.some((n) => n.toLowerCase() === lower)) return { ok: false, reason: 'duplicate' };
  return { ok: true };
}

export function workspaceNameError(reason: 'empty' | 'too-short' | 'too-long' | 'duplicate' | 'invalid-chars'): string {
  switch (reason) {
    case 'empty':
      return 'Enter a workspace name.';
    case 'too-short':
      return 'Use at least 2 characters.';
    case 'too-long':
      return 'Keep the name under 100 characters.';
    case 'duplicate':
      return 'A workspace with this name already exists.';
    case 'invalid-chars':
      return 'Remove characters that cannot be used in a folder name.';
  }
}

export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.password) parsed.password = '***';
    else if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^@]+@/, '://***@');
  }
}

export function filterWorkspaces<T extends { id: string; name: string }>(
  workspaces: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return workspaces;
  return workspaces.filter((w) => w.name.toLowerCase().includes(q));
}

export function sortWorkspacesByRecency<T extends { id: string }>(
  workspaces: T[],
  lastOpened: Record<string, number>,
): T[] {
  return [...workspaces].sort((a, b) => (lastOpened[b.id] ?? 0) - (lastOpened[a.id] ?? 0));
}

export function relativeTime(value: string | number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return 'Never opened';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(time)) return 'Never opened';
  const diff = now - time;
  if (diff < 0) return 'Just now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'Just now';
  if (diff < hour) {
    const n = Math.floor(diff / minute);
    return n + ' min ago';
  }
  if (diff < day) {
    const n = Math.floor(diff / hour);
    return n + ' hr ago';
  }
  if (diff < 30 * day) {
    const n = Math.floor(diff / day);
    return n === 1 ? 'Yesterday' : n + ' days ago';
  }
  try {
    return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return 'Never opened';
  }
}

export function readLastOpened(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PORTAL_LAST_OPENED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function recordLastOpened(id: string): Record<string, number> {
  const next = { ...readLastOpened(), [id]: Date.now() };
  try {
    localStorage.setItem(PORTAL_LAST_OPENED_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function readHiddenWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(PORTAL_HIDDEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function hideWorkspace(id: string): string[] {
  const next = Array.from(new Set([...readHiddenWorkspaces(), id]));
  try {
    localStorage.setItem(PORTAL_HIDDEN_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return value.slice(0, keep) + '\u2026' + value.slice(value.length - keep);
}

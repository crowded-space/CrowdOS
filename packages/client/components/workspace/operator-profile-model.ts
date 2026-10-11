import { safeGet, safeSet } from '@/src/config/desktop-storage';

export interface operatorProfile {
  name: string;
  tag: string;
  /** Free-form operator preference injected into agent context; null/empty = inject nothing. */
  preference: string | null;
}

export const OPERATOR_STORAGE_KEY = 'crowdos_operator';
export const OPERATOR_DEFAULT_NAME = 'Local operator';
export const OPERATOR_DEFAULT_TAG = 'Human';
export const OPERATOR_MAX_NAME = 80;
export const OPERATOR_MAX_TAG = 24;
export const OPERATOR_MAX_PREFERENCE = 2000;

function cleanName(raw: unknown): string {
  return typeof raw === 'string' && raw.trim()
    ? raw.trim().slice(0, OPERATOR_MAX_NAME)
    : OPERATOR_DEFAULT_NAME;
}

function cleanTag(raw: unknown): string {
  return typeof raw === 'string' && raw.trim()
    ? raw.trim().slice(0, OPERATOR_MAX_TAG)
    : OPERATOR_DEFAULT_TAG;
}

function cleanPreference(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, OPERATOR_MAX_PREFERENCE).trim();
  return trimmed ? trimmed : null;
}

export function loadOperatorProfile(): operatorProfile {
  const fallback: operatorProfile = { name: OPERATOR_DEFAULT_NAME, tag: OPERATOR_DEFAULT_TAG, preference: null };
  try {
    const raw = safeGet(OPERATOR_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const rec = parsed as Record<string, unknown>;
    return {
      name: cleanName(rec.name),
      tag: cleanTag(rec.tag),
      preference: cleanPreference(rec.preference),
    };
  } catch {
    return fallback;
  }
}

export function saveOperatorProfile(profile: operatorProfile): void {
  try {
    safeSet(OPERATOR_STORAGE_KEY, JSON.stringify({
      name: cleanName(profile.name),
      tag: cleanTag(profile.tag),
      preference: cleanPreference(profile.preference),
    }));
  } catch {
  }
}

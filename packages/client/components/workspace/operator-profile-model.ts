import { safeGet, safeSet } from '@/src/config/desktop-storage';

export interface operatorProfile {
  name: string;
  email: string;
}

export const OPERATOR_STORAGE_KEY = 'crowdos_operator';
export const OPERATOR_DEFAULT_NAME = 'Local operator';

export function loadOperatorProfile(): operatorProfile {
  try {
    const raw = safeGet(OPERATOR_STORAGE_KEY);
    if (!raw) return { name: OPERATOR_DEFAULT_NAME, email: '' };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { name: OPERATOR_DEFAULT_NAME, email: '' };
    const rec = parsed as Record<string, unknown>;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 80) : OPERATOR_DEFAULT_NAME;
    const email = typeof rec.email === 'string' ? rec.email.trim().slice(0, 120) : '';
    return { name, email };
  } catch {
    return { name: OPERATOR_DEFAULT_NAME, email: '' };
  }
}

export function saveOperatorProfile(profile: operatorProfile): void {
  try {
    const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim().slice(0, 80) : OPERATOR_DEFAULT_NAME;
    const email = typeof profile.email === 'string' ? profile.email.trim().slice(0, 120) : '';
    safeSet(OPERATOR_STORAGE_KEY, JSON.stringify({ name, email }));
  } catch {
  }
}

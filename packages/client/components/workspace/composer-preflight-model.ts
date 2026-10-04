/**
 * Composer preflight view-model: pure mappings for the preflight line
 * above Send. Free of React, fetch, and the store so the honesty rule
 * stays testable: anything without a real source resolves to honest
 * empty and the component hides that segment.
 */
import type { contextBreakdown, preflightOverflow, writeScope } from '../../types/crowdOs';

/** Character count at which the composer warns before the hard cap. */
export const COMPOSER_WARN_AT = 3000;

/** Last path segment for the mount chip; unknown renders honest empty. */
export function shortPath(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Overflow state against the composer cap; non-finite input is ok. */
export function overflowState(charCount: number, max = 4000, warnAt = COMPOSER_WARN_AT): preflightOverflow {
  if (!Number.isFinite(charCount) || charCount < 0) return 'ok';
  if (charCount > max) return 'over';
  if (charCount >= warnAt) return 'warn';
  return 'ok';
}

/** Breakdown tooltip (history / files / memory); unknown is honest empty. */
export function contextTooltipText(breakdown: contextBreakdown | null | undefined): string {
  if (!breakdown) return '';
  const parts: string[] = [];
  if (typeof breakdown.history === 'number') parts.push('History ' + breakdown.history + '%');
  if (typeof breakdown.files === 'number') parts.push('Files ' + breakdown.files + '%');
  if (typeof breakdown.memory === 'number') parts.push('Memory ' + breakdown.memory + '%');
  return parts.join(' - ');
}

/** Write-scope chip label; unknown is honest empty, never an implied scope. */
export function writeScopeLabel(scope: writeScope | null | undefined): string {
  switch (scope) {
    case 'read':
      return 'Read-only';
    case 'write':
      return 'Write allowed';
    case 'command':
      return 'Commands allowed';
    default:
      return '';
  }
}

/** Cost hint text; unknown is honest empty, never a fake total. */
export function costHintText(hint: string | null | undefined): string {
  return typeof hint === 'string' ? hint.trim() : '';
}

/**
 * Projected send length: the draft plus the mention chips MainChatArea
 * prefixes at send time. The textarea enforces maxLength while typing, so
 * charCount alone can never reach 'over' - the mention prefix is the
 * only path that pushes a send past the cap, and the guard reads this.
 */
export function projectedSendLength(draftText: string, mentionNames: string[]): number {
  const draft = typeof draftText === 'string' ? draftText.trim() : '';
  const names = Array.isArray(mentionNames) ? mentionNames : [];
  if (names.length === 0) return draft.length;
  const prefix = names.map((name) => '@' + name).join(' ');
  return (prefix + (draft ? ' ' + draft : '')).length;
}

import { describe, expect, it } from 'vitest';

import {
  TOAST_ERROR_DISMISS_MS,
  TOAST_QUIET_DISMISS_MS,
  toastAriaLive,
  toastAutoDismissMs,
  toastIsReviewable,
  toastRole,
} from './toast-lifetimes';

// UI audit §2.9/§2.17: error toasts used to persist until manually dismissed —
// a stale validation error could occupy a third of the max-3 stack forever,
// following the user across pages and workspaces. The fix gives errors a
// longer-but-finite auto-dismiss while keeping the role=alert contract.

describe('toastAutoDismissMs (UI audit §2.9/§2.17)', () => {
  it('gives errors a finite auto-dismiss instead of persisting forever', () => {
    expect(toastAutoDismissMs('error')).toBe(TOAST_ERROR_DISMISS_MS);
    expect(TOAST_ERROR_DISMISS_MS).toBeGreaterThan(0);
    expect(Number.isFinite(TOAST_ERROR_DISMISS_MS)).toBe(true);
  });

  it('keeps errors visible 3x longer than quiet toasts', () => {
    expect(TOAST_ERROR_DISMISS_MS).toBeGreaterThan(TOAST_QUIET_DISMISS_MS);
    expect(TOAST_ERROR_DISMISS_MS).toBe(TOAST_QUIET_DISMISS_MS * 3);
  });

  it('keeps the 4s quiet dismiss for success and info', () => {
    expect(toastAutoDismissMs('success')).toBe(TOAST_QUIET_DISMISS_MS);
    expect(toastAutoDismissMs('info')).toBe(TOAST_QUIET_DISMISS_MS);
  });
});

describe('toast reviewability (UI audit §2.12/§2.14 minor #16)', () => {
  it('records only error toasts in the notification journal', () => {
    expect(toastIsReviewable('error')).toBe(true);
  });

  it('keeps routine success/info toasts out of the bell', () => {
    expect(toastIsReviewable('success')).toBe(false);
    expect(toastIsReviewable('info')).toBe(false);
  });
});

describe('toast a11y contract unchanged with finite error dismissal', () => {
  it('errors keep role=alert / aria-live=assertive', () => {
    expect(toastRole('error')).toBe('alert');
    expect(toastAriaLive('error')).toBe('assertive');
  });

  it('quiet toasts keep role=status / aria-live=polite', () => {
    expect(toastRole('success')).toBe('status');
    expect(toastRole('info')).toBe('status');
    expect(toastAriaLive('success')).toBe('polite');
    expect(toastAriaLive('info')).toBe('polite');
  });
});

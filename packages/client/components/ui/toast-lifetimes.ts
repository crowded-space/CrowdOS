import type { ToastType } from './ToastProvider';

// UI audit §2.9/§2.17: quiet toasts (success/info) auto-dismiss after 4s.
// Errors used to persist until manually dismissed — a stale validation error
// from a modal the user already abandoned could occupy a third of the stack
// (TOAST_MAX=3) forever, following the user across pages and into other
// workspaces. Errors now get a longer-but-finite auto-dismiss: need-me events
// stay visible 3× longer than quiet feedback, but the stack can no longer
// fill with immortal toasts. The a11y contract is unchanged — errors keep
// role=alert / aria-live=assertive so screen readers still announce them
// while they are visible, and the manual dismiss button always works.
export const TOAST_QUIET_DISMISS_MS = 4000;
export const TOAST_ERROR_DISMISS_MS = 12000;

export function toastAutoDismissMs(type: ToastType): number {
  return type === 'error' ? TOAST_ERROR_DISMISS_MS : TOAST_QUIET_DISMISS_MS;
}

export function toastRole(type: ToastType): 'alert' | 'status' {
  return type === 'error' ? 'alert' : 'status';
}

export function toastAriaLive(type: ToastType): 'assertive' | 'polite' {
  return type === 'error' ? 'assertive' : 'polite';
}

// UI audit §2.12/§2.14 (minor #16): the notification journal is for events
// that need review — real dispatch projections and error toasts. Quiet
// toasts (success/info) are ephemeral feedback for the action the operator
// just took; recording them bumped the bell for routine events ("Channel
// created") and let connection churn ("Connection update" on every
// reconnect digest) fill the center with noise.
export function toastIsReviewable(type: ToastType): boolean {
  return type === 'error';
}

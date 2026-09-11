// Pure notification logic for the desktop shell (P3b hardening stub).
//
// No Electron value imports here: the real main process wires the Electron
// `Notification` module later (showing the native toast + routing its click
// through `buildNotificationAction`). This file stays runtime-free so unit
// tests can import it in plain Node.

export interface DesktopNotification {
  title: string;
  body: string;
  channelId?: string;
  runId?: string;
}

// Deep-link targets the main process routes on Notification click:
//   crowdos://c/<channelId>      — open a channel
//   crowdos://w/<ws>/<channelId> — open a workspace channel pair
export type CrowdosDeepLink =
  | `crowdos://c/${string}`
  | `crowdos://w/${string}/${string}`;

export interface NotificationAction {
  deepLink: CrowdosDeepLink;
}

// Native toasts are reserved for terminal run states plus approval prompts
// (all other run-status chatter stays inside the renderer timeline).
const NATIVE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "approval-requested",
]);

export function shouldShowNativeNotification(runStatus: string): boolean {
  const normalized = runStatus.trim().toLowerCase().replace(/_/g, "-");
  return NATIVE_STATUSES.has(normalized);
}

// A `channelId` already shaped as "<ws>/<channel>" maps to the `w` form;
// a plain id maps to the `c` form. With no channel context the action
// deep-links to the app home and main decides routing.
export function buildNotificationAction(
  notification: DesktopNotification,
): NotificationAction {
  const raw = (notification.channelId ?? "").trim();
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return { deepLink: `crowdos://w/${parts[0]}/${parts[1]}` };
  }
  if (parts.length === 1) {
    return { deepLink: `crowdos://c/${parts[0]}` };
  }
  return { deepLink: `crowdos://c/` };
}

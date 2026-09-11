import { getIpcAllowlist } from "./ipc-contracts.js";
import type {
  IpcChannel,
  IpcEventChannel,
  IpcInvokeChannel,
} from "./ipc-contracts.js";
import { IPC_ALLOWLIST } from "./ipc-contracts.js";
import { getDesktopSecurity } from "./security-policy.js";
import type { DesktopSecurityPolicy } from "./security-policy.js";
import { DESKTOP_SECURITY } from "./security-policy.js";
import { getDesktopPaths } from "./paths.js";
import type { DesktopPaths } from "./paths.js";
import { buildNotificationAction } from "./main/notifications.js";
import type {
  CrowdosDeepLink,
  DesktopNotification,
  NotificationAction,
} from "./main/notifications.js";
import { getTrayMenuTemplate } from "./main/tray-menu.js";
import type {
  TrayMenuState,
  TrayRecentWorkspace,
} from "./main/tray-menu.js";
import { UPDATE_CHANNELS, canAutoUpdate } from "./main/updater.js";
import type {
  AutoUpdateDecision,
  UpdateChannel,
  UpdaterFeed,
  UpdaterState,
} from "./main/updater.js";
import {
  EXTERNAL_HTTPS_ALLOWLIST,
  isAllowedNavigation,
} from "./main/navigation-guard.js";
import type {
  DesktopPermission,
  NavigationGuardOptions,
} from "./main/navigation-guard.js";

export type {
  AutoUpdateDecision,
  CrowdosDeepLink,
  DesktopNotification,
  DesktopPaths,
  DesktopPermission,
  DesktopSecurityPolicy,
  IpcChannel,
  IpcEventChannel,
  IpcInvokeChannel,
  NavigationGuardOptions,
  NotificationAction,
  TrayMenuState,
  TrayRecentWorkspace,
  UpdateChannel,
  UpdaterFeed,
  UpdaterState,
};
export { DESKTOP_SECURITY, EXTERNAL_HTTPS_ALLOWLIST, IPC_ALLOWLIST, UPDATE_CHANNELS };

// Domain Facade Standard: this file is the ONLY public entry point of the
// Desktop domain. Thin facade — no business logic, no fetch, no DB access.
// Internals (ipc-contracts, security-policy, paths, main/, preload/,
// utility/) must never be imported directly from outside this folder.
export const desktopGate = {
  getIpcContracts: getIpcAllowlist,
  getSecurityPolicy: getDesktopSecurity,
  getPaths: getDesktopPaths,
  getTrayMenu: getTrayMenuTemplate,
  canAutoUpdate,
  isAllowedNavigation,
  buildNotificationAction,
};

export type DesktopGate = typeof desktopGate;

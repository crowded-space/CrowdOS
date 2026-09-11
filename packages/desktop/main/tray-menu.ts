// Pure tray-menu template builder for the desktop shell (P3b stub).
//
// Returns Electron `MenuItemConstructorOptions`-shaped plain objects only —
// the real main process passes the result to `Menu.buildFromTemplate` later.
// No Electron runtime imports (type-only), no ipc calls, so this stays
// unit-testable in plain Node without Electron installed.
// @ts-ignore - electron is an optional peer dependency; type-only import,
// erased at runtime so `tsc --noEmit` passes without electron installed.
import type { MenuItemConstructorOptions } from "electron";

export interface TrayRecentWorkspace {
  id: string;
  name: string;
}

export interface TrayMenuState {
  recentWorkspaces: TrayRecentWorkspace[];
  runningCount: number;
  pendingApprovals: number;
}

// Recent-workspace items carry their target via the item `id`
// (`crowdos:windows:open-channel:<workspaceId>`); main wires the click to
// the `crowdos:windows:open-channel` invoke channel. Pause/Cancel is only
// enabled while runs are in flight.
export function getTrayMenuTemplate(
  state: TrayMenuState,
): MenuItemConstructorOptions[] {
  const recentItems: MenuItemConstructorOptions[] =
    state.recentWorkspaces.length > 0
      ? state.recentWorkspaces.map((ws) => ({
          label: ws.name,
          id: `crowdos:windows:open-channel:${ws.id}`,
          toolTip: "crowdos:windows:open-channel",
          type: "normal",
        }))
      : [{ label: "(No recent workspaces)", enabled: false }];

  const runningLabel =
    state.runningCount > 0
      ? `Pause/Cancel Run (${state.runningCount} running)`
      : "Pause/Cancel Run";
  const approvalsLabel =
    state.pendingApprovals > 0
      ? `Review Approvals (${state.pendingApprovals} pending)`
      : "Review Approvals";

  return [
    { label: "Open Recent", submenu: recentItems },
    { type: "separator" },
    {
      label: runningLabel,
      id: "crowdos:runs:pause-cancel",
      toolTip: "crowdos:runs:pause-cancel",
      enabled: state.runningCount > 0,
    },
    {
      label: approvalsLabel,
      id: "crowdos:approvals:list",
      toolTip: "crowdos:approvals:list",
      enabled: state.pendingApprovals > 0,
    },
    { type: "separator" },
    {
      label: "Check for Updates",
      id: "crowdos:updater:check",
      toolTip: "crowdos:updater:check",
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ];
}

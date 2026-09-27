import { z } from "zod";

// Renderer -> main (request/response via ipcRenderer.invoke / ipcMain.handle).
// Channel names mirror the socket.io event names used by the web client.
export const IpcInvokeChannelSchema = z.enum([
  "crowdos:config:get",
  "crowdos:dialog:openDirectory",
  "crowdos:dialog:openFile",
  "crowdos:dialog:save",
  "crowdos:fs:list",
  "crowdos:fs:read",
  "crowdos:fs:write",
  "crowdos:fs:mkdir",
  "crowdos:fs:delete",
  "crowdos:fs:rename",
  "crowdos:runs:resume",
  "crowdos:runs:compensations",
  "crowdos:runs:undo",
  "crowdos:approvals:decide",
  "crowdos:approvals:list",
  "crowdos:notify:show",
  "crowdos:windows:open-channel",
  "crowdos:windows:open-diff",
  "crowdos:updater:check",
  "crowdos:updater:install",
  "crowdos:log:write",
  "crowdos:autostart:get",
  "crowdos:autostart:set",
]);

// Main -> renderer (one-way events via webContents.send / ipcRenderer.on).
export const IpcEventChannelSchema = z.enum([
  "crowdos:run-status",
  "crowdos:approval-requested",
  "crowdos:deep-link",
]);

export const IpcChannelSchema = z.union([
  IpcInvokeChannelSchema,
  IpcEventChannelSchema,
]);

export type IpcInvokeChannel = z.infer<typeof IpcInvokeChannelSchema>;
export type IpcEventChannel = z.infer<typeof IpcEventChannelSchema>;
export type IpcChannel = z.infer<typeof IpcChannelSchema>;

// Narrow, readonly views derived from the zod schemas (single source of truth).
export const IPC_INVOKE_CHANNELS: readonly IpcInvokeChannel[] =
  IpcInvokeChannelSchema.options;
export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] =
  IpcEventChannelSchema.options;
export const IPC_ALLOWLIST: readonly IpcChannel[] = [
  ...IPC_INVOKE_CHANNELS,
  ...IPC_EVENT_CHANNELS,
];

export function getIpcAllowlist(): readonly IpcChannel[] {
  return IPC_ALLOWLIST;
}

export function getIpcInvokeChannels(): readonly IpcInvokeChannel[] {
  return IPC_INVOKE_CHANNELS;
}

export function getIpcEventChannels(): readonly IpcEventChannel[] {
  return IPC_EVENT_CHANNELS;
}

export function isIpcChannel(channel: string): channel is IpcChannel {
  return IpcChannelSchema.safeParse(channel).success;
}

export function isIpcInvokeChannel(channel: string): channel is IpcInvokeChannel {
  return IpcInvokeChannelSchema.safeParse(channel).success;
}

export function isIpcEventChannel(channel: string): channel is IpcEventChannel {
  return IpcEventChannelSchema.safeParse(channel).success;
}

export function parseIpcChannel(channel: string): IpcChannel {
  return IpcChannelSchema.parse(channel);
}

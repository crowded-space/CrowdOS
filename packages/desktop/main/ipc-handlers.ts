import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isIpcInvokeChannel } from "../ipc-contracts.js";
import type { IpcInvokeChannel } from "../ipc-contracts.js";
import { buildNotificationAction } from "./notifications.js";
import { canAutoUpdate } from "./updater.js";

// IPC → action wiring for the desktop main process (Windows-first, v1).
//
// Scope: dialogs, config, notifications, windows, updater, logs. The
// data-plane channels (vfs:*, runs:*, approvals:*) intentionally stay on the
// embedded HTTP API + socket.io in v1 — the renderer already speaks those via
// apiClient/socket, so main returns a 501-style envelope pointing there
// instead of duplicating the backend behind IPC.
//
// This module never imports Electron values (handles are injected), so it
// stays unit-testable in plain Node and `tsc --noEmit` passes without the
// Electron binary installed.

export interface IpcEventLike {
  // ponytail: `| null` keeps this assignable to Electron's real
  // IpcMainInvokeEvent (senderFrame: WebFrameMain | null) now that the
  // declared electron dep is actually installed; `?.` call sites unaffected.
  senderFrame?: { url?: string } | null;
}

export interface IpcMainHandle {
  handle(channel: string, listener: (event: IpcEventLike, payload: unknown) => unknown): void;
}

export interface DialogHandle {
  showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>;
}

export interface ShellHandle {
  openExternal(url: string): Promise<void>;
}

export interface NotificationInstance {
  show(): void;
  on(event: "click", cb: () => void): void;
}

export interface NotificationCtor {
  new (opts: { title: string; body: string }): NotificationInstance;
}

export interface RendererWindowLike {
  focus(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface IpcHandlerDeps {
  ipcMain: IpcMainHandle;
  dialog: DialogHandle;
  shell: ShellHandle;
  NotificationCtor: NotificationCtor;
  getBackend: () => { port: number; backendBaseUrl: string };
  getMainWindow: () => RendererWindowLike | null;
  logFile: string;
  isPackaged: boolean;
  getRunningCount?: () => number;
}

const dialogOptionsSchema = z
  .object({
    defaultPath: z.string().optional(),
    // Nitehunter parity: renderer sends { initialPath } — map to defaultPath.
    initialPath: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough()
  .optional();

const notifySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(1000).optional(),
  channelId: z.string().optional(),
  runId: z.string().optional(),
});

const logSchema = z.object({
  message: z.string().max(20_000),
  level: z.enum(["info", "warn", "error"]).optional(),
});

const openChannelSchema = z
  .object({
    workspaceId: z.string().optional(),
    channelId: z.string().min(1),
  })
  .passthrough();

const REST_FALLBACK_BY_PREFIX: Array<{ prefix: string; area: string }> = [
  { prefix: "crowdos:vfs:", area: "VFS (LocalVFS)" },
  { prefix: "crowdos:runs:", area: "runs (checkpoint/resume/compensations)" },
  { prefix: "crowdos:approvals:", area: "approvals (decide/list)" },
];

let activeLogStream: { path: string; stream: WriteStream } | null = null;
let logDirReady = false;

async function writeDesktopLog(logFile: string, line: string): Promise<void> {
  if (!logDirReady) {
    try {
      await mkdir(dirname(logFile), { recursive: true });
      logDirReady = true;
    } catch {
      // ignore
    }
  }
  if (!activeLogStream || activeLogStream.path !== logFile) {
    const stream = createWriteStream(logFile, { flags: "a", encoding: "utf8" });
    stream.on("error", (err) => console.error("[desktop log error]", err));
    activeLogStream = { path: logFile, stream };
  }
  return new Promise<void>((resolve) => {
    activeLogStream?.stream.write(line, () => resolve());
  });
}

function isTrustedSender(event: IpcEventLike): boolean {
  const url = event?.senderFrame?.url;
  if (!url) return process.env.CROWDOS_DEV === "1";
  return (
    url.startsWith("file://") ||
    url.startsWith("app://") ||
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost")
  );
}

function focusAndDeepLink(deps: IpcHandlerDeps, url: string): void {
  try {
    const win = deps.getMainWindow();
    if (win) {
      win.focus();
      win.webContents.send("crowdos:deep-link", { url });
    }
  } catch {
    // best-effort: never fail an IPC call on window forwarding
  }
}

async function handleInvoke(
  deps: IpcHandlerDeps,
  channel: IpcInvokeChannel,
  payload: unknown,
): Promise<unknown> {
  switch (channel) {
    case "crowdos:config:get": {
      const backend = deps.getBackend();
      return { port: backend.port, backendBaseUrl: backend.backendBaseUrl };
    }
    case "crowdos:dialog:openDirectory": {
      // Nitehunter parity: native openDirectory picker titled
      // 'Select Repository Root'. Canceled → { canceled: true, path: null },
      // otherwise the chosen directory (validate/attach stays server-side).
      const opts = dialogOptionsSchema.parse(payload);
      const defaultPath = opts?.defaultPath ?? opts?.initialPath;
      const res = await deps.dialog.showOpenDialog({
        title: "Select Repository Root",
        ...(opts ?? {}),
        ...(defaultPath ? { defaultPath } : {}),
        properties: ["openDirectory"],
      });
      return { canceled: res.canceled, path: res.canceled ? null : (res.filePaths[0] ?? null) };
    }
    case "crowdos:dialog:openFile": {
      const opts = dialogOptionsSchema.parse(payload);
      const res = await deps.dialog.showOpenDialog({
        ...(opts ?? {}),
        properties: ["openFile"],
      });
      return { canceled: res.canceled, filePaths: res.filePaths };
    }
    case "crowdos:dialog:save": {
      const opts = dialogOptionsSchema.parse(payload);
      const res = await deps.dialog.showSaveDialog({ ...(opts ?? {}) });
      return { canceled: res.canceled, filePath: res.canceled ? null : (res.filePath ?? null) };
    }
    case "crowdos:notify:show": {
      const parsed = notifySchema.parse(payload);
      const action = buildNotificationAction({
        title: parsed.title,
        body: parsed.body ?? "",
        channelId: parsed.channelId,
        runId: parsed.runId,
      });
      const instance = new deps.NotificationCtor({
        title: parsed.title,
        body: parsed.body ?? "",
      });
      instance.on("click", () => {
        if (action.deepLink) focusAndDeepLink(deps, action.deepLink);
        else {
          try {
            deps.getMainWindow()?.focus();
          } catch {
            // ignore
          }
        }
      });
      instance.show();
      return { ok: true };
    }
    case "crowdos:windows:open-channel": {
      const parsed = openChannelSchema.parse(payload);
      const url = parsed.workspaceId
        ? `crowdos://w/${parsed.workspaceId}/${parsed.channelId}`
        : `crowdos://c/${parsed.channelId}`;
      focusAndDeepLink(deps, url);
      return { ok: true };
    }
    case "crowdos:windows:open-diff": {
      try {
        deps.getMainWindow()?.focus();
      } catch {
        // ignore
      }
      return { ok: true };
    }
    case "crowdos:updater:check": {
      const runningCount = deps.getRunningCount?.() ?? 0;
      const decision = canAutoUpdate({ isPackaged: deps.isPackaged, runningCount });
      return { ...decision, updateAvailable: false, channel: "stable" as const };
    }
    case "crowdos:updater:install": {
      return {
        ok: false,
        reason: "Auto-install is not wired in v1 — quit (draining running runs first) and run the signed installer.",
      };
    }
    case "crowdos:log:write": {
      const parsed = logSchema.parse(payload);
      const line = `${new Date().toISOString()} [${parsed.level ?? "info"}] ${parsed.message}\n`;
      await writeDesktopLog(deps.logFile, line);
      return { ok: true };
    }
    default: {
      const fallback = REST_FALLBACK_BY_PREFIX.find((f) => channel.startsWith(f.prefix));
      if (fallback) {
        return {
          ok: false,
          error: `${fallback.area} stays on the embedded HTTP API + socket.io in v1 — use apiClient/socket, not IPC.`,
        };
      }
      return { ok: false, error: `Unhandled IPC channel: ${channel}` };
    }
  }
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const channels: IpcInvokeChannel[] = [
    "crowdos:config:get",
    "crowdos:dialog:openDirectory",
    "crowdos:dialog:openFile",
    "crowdos:dialog:save",
    "crowdos:vfs:list",
    "crowdos:vfs:read",
    "crowdos:vfs:write",
    "crowdos:vfs:mkdir",
    "crowdos:vfs:delete",
    "crowdos:vfs:rename",
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
  ];
  for (const channel of channels) {
    if (!isIpcInvokeChannel(channel)) continue;
    deps.ipcMain.handle(channel, async (event: IpcEventLike, payload: unknown) => {
      if (!isTrustedSender(event)) throw new Error(`crowdos IPC: untrusted sender for ${channel}`);
      try {
        return await handleInvoke(deps, channel, payload);
      } catch (err) {
        return { ok: false, error: `Invalid IPC payload for ${channel}: ${(err as Error)?.message ?? String(err)}` };
      }
    });
  }
}

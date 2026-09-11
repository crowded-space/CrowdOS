import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type IpcEventChannel,
  type IpcInvokeChannel,
} from "../ipc-contracts.js";
// @ts-ignore - electron is an optional peer dependency; type-only import,
// erased at runtime so `tsc --noEmit` passes without electron installed.
import type { ContextBridge, IpcRenderer } from "electron";

// Minimal structural shapes for the Electron preload APIs. The real preload
// entry (Phase P1) passes the live `ipcRenderer` / `contextBridge` in, so
// this module never imports Electron values and stays testable in plain Node.
export interface PreloadIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
}

export interface PreloadContextBridge {
  exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
}

export interface PreloadHandles {
  ipcRenderer: IpcRenderer & PreloadIpcRenderer;
  contextBridge: ContextBridge & PreloadContextBridge;
}

export type CrowdosEventUnsubscribe = () => void;

// window.crowdos: the ONLY renderer-to-main surface. Whitelisted invoke/on
// over IPC_ALLOWLIST channels; no raw fs, shell, or require exposure.
export interface PickDirectoryOptions {
  initialPath?: string;
  defaultPath?: string;
  title?: string;
}

export interface PickDirectoryResult {
  canceled: boolean;
  path: string | null;
}

export interface CrowdosBridgeApi {
  invoke(channel: IpcInvokeChannel, payload?: unknown): Promise<unknown>;
  on(
    channel: IpcEventChannel,
    listener: (payload: unknown) => void,
  ): CrowdosEventUnsubscribe;
  // Nitehunter parity: typed `select-repository` wrapper over
  // `crowdos:dialog:openDirectory`. The client tree UI already calls
  // `window.crowdos.pickDirectory({ initialPath })` and falls back to
  // `/api/fs/pick-folder` + manual browser when absent — this makes the
  // native path actually resolve in the desktop shell.
  pickDirectory(opts?: PickDirectoryOptions): Promise<PickDirectoryResult>;
}

declare global {
  interface Window {
    crowdos?: CrowdosBridgeApi;
  }
}

export function createCrowdosBridgeApi(
  handles: Pick<PreloadHandles, "ipcRenderer">,
): CrowdosBridgeApi {
  const allowedInvoke = new Set<string>(IPC_INVOKE_CHANNELS);
  const allowedEvents = new Set<string>(IPC_EVENT_CHANNELS);
  return {
    invoke(channel: IpcInvokeChannel, payload?: unknown): Promise<unknown> {
      if (!allowedInvoke.has(channel)) {
        throw new Error(`crowdos bridge: invoke blocked for channel ${channel}`);
      }
      return handles.ipcRenderer.invoke(channel, payload);
    },
    async pickDirectory(opts?: PickDirectoryOptions): Promise<PickDirectoryResult> {
      // Nitehunter `select-repository` semantics: native openDirectory dialog
      // titled 'Select Repository Root'; cancel → { canceled: true, path: null }.
      const raw = (await handles.ipcRenderer.invoke("crowdos:dialog:openDirectory", {
        title: "Select Repository Root",
        ...(opts?.initialPath ? { initialPath: opts.initialPath } : {}),
        ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
        ...(opts?.title ? { title: opts.title } : {}),
      })) as unknown;
      if (typeof raw === "string") {
        return { canceled: !raw, path: raw || null };
      }
      if (raw && typeof raw === "object") {
        const rec = raw as Record<string, unknown>;
        const fps = rec.filePaths;
        const firstFilePath =
          Array.isArray(fps) && typeof fps[0] === "string" ? (fps[0] as string) : null;
        if (
          typeof rec.path !== "undefined" ||
          typeof rec.canceled !== "undefined" ||
          firstFilePath !== null
        ) {
          const p =
            typeof rec.path === "string" ? rec.path : firstFilePath;
          return { canceled: Boolean(rec.canceled) || !p, path: p };
        }
      }
      return { canceled: true, path: null };
    },
    on(
      channel: IpcEventChannel,
      listener: (payload: unknown) => void,
    ): CrowdosEventUnsubscribe {
      if (!allowedEvents.has(channel)) {
        throw new Error(`crowdos bridge: subscribe blocked for channel ${channel}`);
      }
      const wrapped = (_event: unknown, value: unknown): void => {
        listener(value);
      };
      handles.ipcRenderer.on(channel, wrapped);
      return () => {
        handles.ipcRenderer.removeListener(channel, wrapped);
      };
    },
  };
}

export function exposeCrowdosBridge(handles: PreloadHandles): CrowdosBridgeApi {
  const api = createCrowdosBridgeApi(handles);
  handles.contextBridge.exposeInMainWorld(
    "crowdos",
    api as unknown as Record<string, unknown>,
  );
  return api;
}

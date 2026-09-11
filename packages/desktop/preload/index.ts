// Preload entry — the ONLY code that runs in the renderer preload context.
// Exposes the whitelisted `window.crowdos` bridge (invoke/on over the IPC
// allowlist). No fs, shell, or Node access is exposed here by design.
// @ts-ignore - electron is resolved at runtime; tsc passes without the binary.
import { contextBridge, ipcRenderer } from "electron";
import { exposeCrowdosBridge } from "./bridge.js";

exposeCrowdosBridge({ ipcRenderer, contextBridge });

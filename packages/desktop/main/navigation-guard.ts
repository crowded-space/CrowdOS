// Pure navigation / permission hardening for the desktop shell (P3b stub).
//
// The real main process wires these into `will-navigate`, `setWindowOpenHandler`,
// `session.setPermissionRequestHandler`, and `shell.openExternal`. Kept as pure
// functions (no Electron imports at all) so unit tests cover the policy in
// plain Node.

import { fileURLToPath } from "node:url";
import { normalize } from "node:path";
import { rendererCandidates } from "../paths.js";

export interface NavigationGuardOptions {
  backendPort: number;
  devServerPort?: number;
  devServerUrl?: string;
  allowedRendererPaths?: string[];
}

// Top-level navigation allowlist: the bundled renderer itself (`app://`,
// `file://`) plus the loopback-only embedded backend on the injected port
// (http + ws). In dev mode, the dev renderer server (e.g. 127.0.0.1:22077)
// is also permitted. Everything else is denied here.
export function isAllowedNavigation(
  url: string,
  opts: NavigationGuardOptions,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  switch (parsed.protocol) {
    case "app:":
      return true;
    case "file:": {
      try {
        const filePath = normalize(fileURLToPath(url)).toLowerCase();
        const candidates = opts.allowedRendererPaths ?? rendererCandidates();
        return candidates.some((c) => {
          const candidatePath = normalize(c).toLowerCase();
          return filePath === candidatePath || filePath.startsWith(candidatePath.replace(/index\.html$/, ""));
        });
      } catch {
        return false;
      }
    }
    case "http:":
    case "ws:": {
      const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      if (!isLoopback) return false;
      const portNum = Number(parsed.port);
      if (portNum === opts.backendPort) return true;
      if (opts.devServerPort && portNum === opts.devServerPort) return true;
      if (opts.devServerUrl && url.startsWith(opts.devServerUrl)) return true;
      return false;
    }
    default:
      return false;
  }
}

// Host allowlist for `shell.openExternal`. If non-empty, restricts opens to
// listed hosts. When empty, permits safe external https: web destinations.
export const EXTERNAL_HTTPS_ALLOWLIST: readonly string[] = [];

export function isAllowedExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  // Disallow loopback addresses from openExternal to prevent local port confusion
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    return false;
  }
  if (EXTERNAL_HTTPS_ALLOWLIST.length > 0) {
    return EXTERNAL_HTTPS_ALLOWLIST.includes(parsed.hostname.toLowerCase());
  }
  return true;
}

export type DesktopPermission =
  | "camera"
  | "microphone"
  | "geolocation"
  | "notifications";

// Least privilege: only Notification toasts are granted; camera, microphone,
// and geolocation are always denied.
export function getPermissionDecision(
  permission: DesktopPermission,
): boolean {
  return permission === "notifications";
}

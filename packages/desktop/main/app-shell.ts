import { DESKTOP_SECURITY } from "../security-policy.js";
// @ts-ignore - electron is an optional peer dependency; type-only import,
// erased at runtime so `tsc --noEmit` passes without electron installed.
import type { App, BrowserWindow } from "electron";
// @ts-ignore - electron is an optional peer dependency; type-only import.
import type { BrowserWindowConstructorOptions } from "electron";

// Minimal structural shapes so this module stays importable (and testable)
// without Electron installed. The real main entry (Phase P1) will
// `await import("electron")` and pass the live handles in.
export interface ElectronAppHandle {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners?(event: string): unknown;
}

export interface ElectronBrowserWindowStatic {
  new (options: BrowserWindowConstructorOptions): BrowserWindow;
}

export interface DesktopShellHandles {
  app: App & ElectronAppHandle;
  BrowserWindow: ElectronBrowserWindowStatic;
}

export interface CreateMainWindowOptions {
  preloadPath: string;
}

// BrowserWindow options derived from the shared DESKTOP_SECURITY baseline.
// Loopback-only: the renderer may only reach the embedded backend on 127.0.0.1
// (see security-policy.ts allowedConnectSrc / csp).
export function buildMainWindowOptions(
  opts: CreateMainWindowOptions,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#0A0A0B",
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: DESKTOP_SECURITY.contextIsolation,
      sandbox: DESKTOP_SECURITY.sandbox,
      nodeIntegration: DESKTOP_SECURITY.nodeIntegration,
      webSecurity: DESKTOP_SECURITY.webSecurity,
      backgroundThrottling: false,
    },
  };
}

export function createMainWindow(
  handles: DesktopShellHandles,
  opts: CreateMainWindowOptions,
): BrowserWindow {
  const win = new handles.BrowserWindow(buildMainWindowOptions(opts));
  return win;
}

// Single-instance lock: second launches quit so only one backend owns the port.
export function ensureSingleInstanceLock(handles: DesktopShellHandles): boolean {
  const gotLock = handles.app.requestSingleInstanceLock();
  if (!gotLock) {
    handles.app.quit();
    return false;
  }
  return true;
}

// crowdos:// deep-link protocol. Registers the OS handler and wires
// second-instance / open-url argv parsing, emitting the raw URL to the
// optional callback (the main entry forwards it as `crowdos:deep-link`).
export function registerCrowdosProtocol(
  handles: DesktopShellHandles,
  onDeepLink?: (url: string) => void,
): void {
  try {
    (handles.app as unknown as { setAsDefaultProtocolClient?: (scheme: string) => void }).setAsDefaultProtocolClient?.(
      'crowdos',
    );
  } catch {
    // Best-effort: protocol registration must never break startup.
  }
  if (!onDeepLink) return;
  try {
    const appAny = handles.app as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    appAny.on('second-instance', (...args: unknown[]) => {
      try {
        // Electron: second-instance args are (event, commandLine, workingDirectory).
        const commandLine = args[1];
        const url = extractDeepLinkFromArgv(
          Array.isArray(commandLine) ? (commandLine as string[]) : [],
        );
        if (url) onDeepLink(url);
      } catch {
        // ignore malformed second-instance argv
      }
    });
    appAny.on('open-url', (...args: unknown[]) => {
      try {
        // macOS: open-url args are (event, url).
        const raw = args[1];
        const parsed = parseCrowdosUrl(typeof raw === 'string' ? raw : String(raw ?? ''));
        if (parsed) onDeepLink(parsed);
      } catch {
        // ignore malformed open-url payloads
      }
    });
  } catch {
    // Best-effort: listener wiring must never break startup.
  }
}

/**
 * Validate/normalize a single crowdos:// URL. Returns the trimmed,
 * unquoted URL when it carries the crowdos:// scheme, else null.
 */
export function parseCrowdosUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  let cleaned = url.trim();
  if (cleaned.length >= 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }
  if (!cleaned) return null;
  if (!/^crowdos:\/\//i.test(cleaned)) return null;
  return cleaned;
}

/**
 * Find the first crowdos:// URL in an argv array (incl. Windows
 * second-instance argv, where the URL may be quoted or embedded in a
 * larger arg). Returns the normalized URL or null.
 */
export function extractDeepLinkFromArgv(argv: string[]): string | null {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const idx = arg.toLowerCase().indexOf('crowdos://');
    if (idx === -1) continue;
    let candidate = arg.slice(idx).trim();
    // Cut at whitespace (argv entries are usually exact, but be defensive).
    const ws = candidate.search(/\s/);
    if (ws !== -1) candidate = candidate.slice(0, ws);
    // Strip trailing quotes/commas possibly added by shell quoting.
    candidate = candidate.replace(/['",;]+$/g, '').trim();
    const parsed = parseCrowdosUrl(candidate);
    if (parsed) return parsed;
  }
  return null;
}

// Graceful shutdown: stop the embedded backend before the app exits.
export function installGracefulShutdown(
  handles: DesktopShellHandles,
  onShutdown: () => Promise<void>,
): void {
  let isQuitting = false;
  handles.app.on("before-quit", ((event: { preventDefault: () => void }) => {
    if (isQuitting) return;
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
    isQuitting = true;
    void Promise.resolve(onShutdown())
      .catch((err) => {
        console.error("[desktop] shutdown error:", err);
      })
      .finally(() => {
        handles.app.quit();
      });
  }) as (...a: never[]) => void);
  handles.app.on("window-all-closed", () => {
    handles.app.quit();
  });
}

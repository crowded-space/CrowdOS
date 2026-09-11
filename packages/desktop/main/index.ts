// CrowdOS desktop main entry (Windows-first, Zero-Auth, loopback-only).
//
// Run: `npm run dev:electron` (dev, loads vite) or packaged (`npm run dist`).
// SINGLE-USER LOCAL SHELL: the embedded backend trusts the loopback caller;
// never listen on LAN/WAN, never expose IPC past the allowlist.
//
// NOTE on the `@ts-ignore` below: Electron resolves at runtime under the
// desktop shell. The ignore keeps `tsc --noEmit` green without the ~100MB
// binary installed; `npm install` (devDeps) is still required for `dist`.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// @ts-ignore - electron is resolved at runtime; see note above.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import { getDesktopPaths, rendererCandidates } from "../paths.js";
import { DESKTOP_SECURITY } from "../security-policy.js";
import {
  buildMainWindowOptions,
  ensureSingleInstanceLock,
  installGracefulShutdown,
  registerCrowdosProtocol,
} from "./app-shell.js";
import type { DesktopShellHandles } from "./app-shell.js";
import { loadDesktopConfig, saveDesktopConfig, saveDesktopConfigDebounced } from "./config-store.js";
import { ensureDatabase } from "./ensure-database.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { isAllowedExternal, isAllowedNavigation } from "./navigation-guard.js";
import { getTrayMenuTemplate } from "./tray-menu.js";
import { startEmbeddedBackend } from "../utility/embedded-backend.js";

const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/community_agent";
const DEV_RENDERER_URL = process.env.VITE_URL ?? "http://127.0.0.1:22077";

// Register custom privileged scheme for packaged asset loading
try {
  protocol?.registerSchemesAsPrivileged?.([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
} catch {
  // Best-effort: protocol scheme registration
}

// Structural main-window shape (the real BrowserWindow under Electron).
export interface MainWindowLike {
  show: () => void;
  focus: () => void;
  close: () => void;
  loadURL: (u: string) => Promise<void>;
  loadFile: (f: string) => Promise<void>;
  on: (e: string, cb: (...a: never[]) => void) => void;
  once: (e: string, cb: (...a: never[]) => void) => void;
  getBounds: () => { x?: number; y?: number; width: number; height: number };
  webContents: {
    send: (c: string, p: unknown) => void;
    on: (e: string, cb: (...a: never[]) => void) => void;
    openDevTools?: (opts?: { mode?: string }) => void;
    session?: unknown;
  };
}

async function pickFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 10; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => {
        probe.close(() => resolve(true));
      });
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return preferred;
}

function bootstrapCandidates(): string[] {
  const out: string[] = [];
  try {
    const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
    if (resources) out.push(join(resources, "server", "dist", "db", "bootstrap.js"));
  } catch {
    // ignore
  }
  try {
    const appPath = (app as unknown as { getAppPath?: () => string }).getAppPath?.();
    if (appPath) out.push(join(appPath, "..", "server", "dist", "db", "bootstrap.js"));
  } catch {
    // ignore
  }
  out.push(join(__dirname, "..", "..", "server", "dist", "db", "bootstrap.js"));
  out.push(join(__dirname, "..", "..", "..", "server", "dist", "db", "bootstrap.js"));
  return out;
}

async function boot(): Promise<void> {
  const handles = { app, BrowserWindow } as unknown as DesktopShellHandles;
  if (!ensureSingleInstanceLock(handles)) return;

  const isDev = process.env.CROWDOS_DEV === "1";
  const isPackaged = (() => {
    try {
      return (app as unknown as { isPackaged?: boolean }).isPackaged === true;
    } catch {
      return false;
    }
  })();

  const userData = (app as unknown as { getPath: (n: string) => string }).getPath("userData");
  const paths = getDesktopPaths(userData);
  mkdirSync(paths.workspacesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const stored = loadDesktopConfig(paths.configFile);

  // Embedded backend env (loopback-only, inline queue, cwd-independent roots).
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    const envCandidates = [
      join(__dirname, "..", "..", "..", ".env"),
      join(__dirname, "..", "..", ".env"),
      join(paths.dataRoot, ".env"),
    ];
    for (const envFile of envCandidates) {
      if (existsSync(envFile)) {
        try {
          const raw = readFileSync(envFile, "utf8");
          for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx > 0) {
              const key = trimmed.slice(0, eqIdx).trim();
              let val = trimmed.slice(eqIdx + 1).trim();
              if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
              }
              if (!process.env[key]) {
                process.env[key] = val;
              }
            }
          }
          if (process.env.DATABASE_URL) break;
        } catch {
          // ignore
        }
      }
    }
  }
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    process.env.DATABASE_URL = DEFAULT_DATABASE_URL;
  }
  process.env.QUEUE_MODE = "inline";
  process.env.DESKTOP_MODE = "1";
  if (!process.env.WORKSPACE_DIR || process.env.WORKSPACE_DIR.trim().length === 0) {
    process.env.WORKSPACE_DIR = paths.workspacesDir;
  }
  const databaseUrl = process.env.DATABASE_URL;

  const migrated = await ensureDatabase({ databaseUrl, bootstrapCandidates: bootstrapCandidates() });
  if (migrated.status === "failed") {
    console.error(`[desktop] database migration failed: ${migrated.reason}`);
    try {
      dialog.showErrorBox(
        "CrowdOS database unavailable",
        `${migrated.reason}\n\nStart Postgres 16 on 127.0.0.1:5432 and relaunch, or run: npm run db:push`,
      );
    } catch {
      // headless — continue so the failure is visible in backend logs too
    }
  }

  // Desktop backend defaults to 12077 (in dev, always 12077; never use web dev port 3001)
  const preferredPort = isDev ? 12077 : (stored.backendPort && stored.backendPort !== 3001 ? stored.backendPort : 12077);
  const port = await pickFreePort(preferredPort);
  let backend: Awaited<ReturnType<typeof startEmbeddedBackend>>;
  try {
    backend = await startEmbeddedBackend({ port, databaseUrl });
  } catch (err) {
    console.error(`[desktop] embedded backend failed to start: ${(err as Error)?.message ?? err}`);
    try {
      dialog.showErrorBox(
        "CrowdOS backend failed to start",
        `${(err as Error)?.message ?? err}\n\nCheck that Postgres is running and DATABASE_URL is correct, then relaunch.`,
      );
    } catch {
      // headless — error already logged above
    }
    (app as unknown as { quit: () => void }).quit();
    return;
  }
  const backendBaseUrl = `http://127.0.0.1:${backend.port}`;
  saveDesktopConfig(paths.configFile, { backendPort: backend.port });

  let mainWindow: MainWindowLike | null = null;

  registerIpcHandlers({
    ipcMain,
    dialog,
    shell,
    NotificationCtor: Notification,
    getBackend: () => ({ port: backend.port, backendBaseUrl }),
    getMainWindow: () => mainWindow,
    logFile: join(paths.logsDir, "desktop.log"),
    isPackaged,
  });

  const preloadCandidates = [
    join(__dirname, "..", "preload", "index.cjs"),
    join(__dirname, "preload", "index.cjs"),
    join(__dirname, "..", "preload", "index.js"),
    join(__dirname, "preload", "index.js"),
  ];
  const preloadPath = preloadCandidates.find((p) => existsSync(p)) ?? preloadCandidates[0];
  const options = buildMainWindowOptions({ preloadPath });
  const created = new BrowserWindow({
    ...options,
    ...(stored.windowBounds ? { ...stored.windowBounds } : {}),
  });
  const win: MainWindowLike = created as unknown as MainWindowLike;
  mainWindow = win;

  // Gracefully show window when ready to eliminate white screen flicker
  let windowShown = false;
  const showWindowGracefully = () => {
    if (windowShown) return;
    windowShown = true;
    try {
      win.show();
      win.focus();
    } catch {
      // ignore
    }
  };
  win.once("ready-to-show", showWindowGracefully);
  setTimeout(showWindowGracefully, 1500);

  // Debounced bounds persistence
  try {
    win.on("resize", (() => {
      try {
        const bounds = win.getBounds();
        saveDesktopConfigDebounced(paths.configFile, {
          windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        }, 500);
      } catch {
        // ignore
      }
    }) as (...a: never[]) => void);

    win.on("close", (() => {
      try {
        const bounds = win.getBounds();
        saveDesktopConfig(paths.configFile, {
          windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      } catch {
        // ignore persistence failures on close
      }
    }) as (...a: never[]) => void);
  } catch {
    // ignore
  }

  // Hardening: deny unexpected navigations / popups, gate permissions + CSP.
  try {
    win.webContents.on("will-navigate", ((event: { preventDefault: () => void }, url: string) => {
      if (
        !isAllowedNavigation(url, {
          backendPort: backend.port,
          devServerPort: 22077,
          devServerUrl: DEV_RENDERER_URL,
        })
      ) {
        event.preventDefault();
      }
    }) as (...a: never[]) => void);
    const contents = win as unknown as {
      setWindowOpenHandler?: (h: (d: { url: string }) => { action: "deny" }) => void;
    };
    contents.setWindowOpenHandler?.(({ url }: { url: string }) => {
      if (isAllowedExternal(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  } catch {
    // ignore
  }
  try {
    const sess = session as unknown as {
      defaultSession?: {
        setPermissionRequestHandler?: (
          h: (wc: unknown, permission: string, cb: (allow: boolean) => void) => void,
        ) => void;
        webRequest?: {
          onHeadersReceived?: (
            h: (details: unknown, cb: (r: { responseHeaders?: Record<string, string[]> }) => void) => void,
          ) => void;
        };
      };
    };
    sess.defaultSession?.setPermissionRequestHandler?.((_wc, permission, callback) => {
      callback(permission === "notifications");
    });
    sess.defaultSession?.webRequest?.onHeadersReceived?.((details: any, callback) => {
      const responseHeaders = { ...(details?.responseHeaders ?? {}) };
      if (!isDev) {
        responseHeaders["Content-Security-Policy"] = [DESKTOP_SECURITY.csp];
      }
      callback({ responseHeaders });
    });
  } catch {
    // ignore
  }

  registerCrowdosProtocol(handles, (url: string) => {
    try {
      win.webContents.send("crowdos:deep-link", { url });
    } catch {
      // ignore — window gone
    }
  });
  try {
    (app as unknown as { on: (e: string, cb: () => void) => void }).on("second-instance", () => {
      try {
        win.focus();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  // System Tray setup
  try {
    const iconCandidates = [
      join(__dirname, "..", "..", "client", "public", "icon_only_dark.png"),
      join(__dirname, "..", "..", "..", "client", "public", "icon_only_dark.png"),
    ];
    const trayIconPath = iconCandidates.find((p) => existsSync(p));
    if (trayIconPath) {
      const tray = new Tray(trayIconPath);
      tray.setToolTip("CrowdOS");
      const template = getTrayMenuTemplate({
        recentWorkspaces: [],
        runningCount: 0,
        pendingApprovals: 0,
      });
      tray.setContextMenu(Menu.buildFromTemplate(template));
      tray.on("click", () => {
        try {
          win.focus();
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // Tray is best-effort
  }

  if (isDev) {
    await win.loadURL(DEV_RENDERER_URL);
    // Debug: auto-open detached DevTools (CROWDOS_DEVTOOLS=0 to disable).
    if (process.env.CROWDOS_DEVTOOLS !== "0") {
      try {
        win.webContents.openDevTools?.({ mode: "detach" });
      } catch {
        // ignore — DevTools unavailable in this build
      }
    }
  } else {
    // Packaged renderer: resolve client/dist/index.html
    const target = rendererCandidates(__dirname).find((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
    if (!target) {
      dialog.showErrorBox(
        "CrowdOS renderer missing",
        "client/dist/index.html was not found. Run: npm run build --workspace @community-agent/client",
      );
      (app as unknown as { quit: () => void }).quit();
      return;
    }

    const clientDistDir = dirname(target);
    // Register app:// protocol to serve client assets seamlessly with proper MIME types
    try {
      protocol.handle("app", async (req: { url: string }) => {
        const parsedUrl = new URL(req.url);
        let pathname = decodeURIComponent(parsedUrl.pathname);
        if (pathname === "/" || pathname === "") pathname = "/index.html";
        const resolvedFile = normalize(join(clientDistDir, pathname));
        if (!resolvedFile.toLowerCase().startsWith(normalize(clientDistDir).toLowerCase())) {
          return new Response("Forbidden", { status: 403 });
        }
        if (existsSync(resolvedFile) && statSync(resolvedFile).isFile()) {
          return net.fetch(pathToFileURL(resolvedFile).toString());
        }
        const indexPath = join(clientDistDir, "index.html");
        if (existsSync(indexPath)) {
          return net.fetch(pathToFileURL(indexPath).toString());
        }
        return new Response("Not Found", { status: 404 });
      });
      await win.loadURL("app://crowdos/index.html");
    } catch {
      // Fallback to direct file loading if protocol handling is unavailable
      await win.loadFile(target);
    }
  }

  installGracefulShutdown(handles, async () => {
    await backend.stop();
  });
}

void (app as unknown as { whenReady: () => Promise<void> })
  .whenReady()
  .then(boot)
  .catch((err) => {
    console.error("[desktop] Failed to boot desktop shell:", err);
  });

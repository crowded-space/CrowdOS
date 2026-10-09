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
  crashReporter,
  dialog,
  globalShortcut,
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
import { startDesktopLogTee } from "./desktop-log.js";
import { ensureDatabase } from "./ensure-database.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { isAllowedExternal, isAllowedNavigation } from "./navigation-guard.js";
import { getTrayMenuTemplate } from "./tray-menu.js";
import { startEmbeddedBackend } from "../utility/embedded-backend.js";

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
export function focusMainWindow(win: {
  isMinimized?: () => boolean;
  restore?: () => void;
  show?: () => void;
  moveTop?: () => void;
  focus?: () => void;
} | null): void {
  if (!win) return;
  try {
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    win.moveTop?.();
    win.focus?.();
  } catch {
    // best-effort: never fail IPC on window forwarding
  }
}

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
  // Persist main-process diagnostics (console warn/error) to the documented
  // file log so a packaged build keeps support evidence on disk (QA audit
  // 2026-09-23: logs/desktop.log never existed). Boot/IPC/backend failures
  // land here; the stream writer lives in ./desktop-log.ts.
  startDesktopLogTee(join(paths.logsDir, "desktop.log"));

  // Windows toast identity (required for native toasts) + crash evidence.
  try {
    (app as unknown as { setAppUserModelId?: (id: string) => void }).setAppUserModelId?.(
      "com.crowded-space.crowdspace",
    );
  } catch {
    // ignore
  }
  try {
    crashReporter.start({
      productName: "CrowdSpace Nightly",
      companyName: "CrowdSpace",
      submitURL: "",
      uploadToServer: false,
    });
  } catch {
    // crash reporter is best-effort in dev
  }

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
  // Local-only parity: leave DATABASE_URL unset when nothing configured it so
  // the embedded backend runs file-first. Forcing a default Postgres URL here
  // would put every desktop launch on a database even when the server
  // supports Local-only operation. ensureDatabase skips cleanly on empty URLs.
  process.env.QUEUE_MODE = "inline";
  process.env.DESKTOP_MODE = "1";
  if (!process.env.WORKSPACE_DIR || process.env.WORKSPACE_DIR.trim().length === 0) {
    process.env.WORKSPACE_DIR = paths.workspacesDir;
  }
  const rawDatabaseUrl = process.env.DATABASE_URL?.trim();
  const databaseUrl = rawDatabaseUrl && rawDatabaseUrl.length > 0 ? rawDatabaseUrl : "";

  const migrated = await ensureDatabase({ databaseUrl, bootstrapCandidates: bootstrapCandidates() });
  if (migrated.status === "failed") {
    // Offline-first: Postgres is optional. Log and continue without a
    // blocking dialog — persistence-backed routes degrade until the DB is up.
    console.warn(`[desktop] database unavailable, continuing offline: ${migrated.reason}`);
  } else if (migrated.status === "skipped") {
    console.warn(`[desktop] database setup skipped (${migrated.reason}), continuing offline`);
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
        `${(err as Error)?.message ?? err}\n\nSee ${join(paths.logsDir, "desktop.log")} for details. If persistence is needed, start Postgres 16 on 127.0.0.1:5432 and relaunch (or run: npm run db:push).`,
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
  let trayRefreshHook: (() => void) | null = null;

  const recordRecentWorkspace = (workspaceId: string) => {
    try {
      const cfg = loadDesktopConfig(paths.configFile);
      const next = [workspaceId, ...(cfg.recentWorkspaceIds ?? []).filter((id) => id !== workspaceId)].slice(0, 8);
      saveDesktopConfig(paths.configFile, { recentWorkspaceIds: next });
      trayRefreshHook?.();
    } catch {
      // ignore
    }
  };

  registerIpcHandlers({
    ipcMain,
    dialog,
    shell,
    NotificationCtor: Notification,
    getBackend: () => ({ port: backend.port, backendBaseUrl }),
    getMainWindow: () => mainWindow,
    logFile: join(paths.logsDir, "desktop.log"),
    isPackaged,
    getAutostart: () => {
      try {
        return Boolean(
          (app as unknown as { getLoginItemSettings?: () => { openAtLogin?: boolean } }).getLoginItemSettings?.().openAtLogin,
        );
      } catch {
        return false;
      }
    },
    setAutostart: (enabled: boolean) => {
      try {
        (app as unknown as { setLoginItemSettings?: (s: Record<string, unknown>) => void }).setLoginItemSettings?.({
          openAtLogin: enabled,
        });
      } catch {
        // ignore
      }
    },
    onWorkspaceOpened: recordRecentWorkspace,
    onNotificationShown: () => {
      try {
        const count = ((app as unknown as { getBadgeCount?: () => number }).getBadgeCount?.() ?? 0) + 1;
        (app as unknown as { setBadgeCount?: (n: number) => void }).setBadgeCount?.(count);
        (created as unknown as { flashFrame?: (flag: boolean) => void } | null)?.flashFrame?.(true);
      } catch {
        // ignore
      }
    },
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

  // Clear the taskbar/dock badge once the user returns to the app.
  try {
    win.on("focus", (() => {
      try {
        (app as unknown as { setBadgeCount?: (n: number) => void }).setBadgeCount?.(0);
        (created as unknown as { setProgressBar?: (n: number) => void }).setProgressBar?.(-1);
      } catch {
        // ignore
      }
    }) as (...a: never[]) => void);
  } catch {
    // ignore
  }

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
      focusMainWindow(win as unknown as Parameters<typeof focusMainWindow>[0]);
    });
  } catch {
    // ignore
  }

  // System Tray setup (live recents from config; counts stay 0 until the
  // run-status approval plumbing reports them — template renders honestly).
  let trayRef: InstanceType<typeof Tray> | null = null;
  const refreshTray = () => {
    if (!trayRef) return;
    try {
      const cfg = loadDesktopConfig(paths.configFile);
      const recents = (cfg.recentWorkspaceIds ?? []).slice(0, 5).map((id) => ({
        id,
        name: id,
      }));
      trayRef.setContextMenu(
        Menu.buildFromTemplate(
          getTrayMenuTemplate({ recentWorkspaces: recents, runningCount: 0, pendingApprovals: 0 }),
        ),
      );
    } catch {
      // ignore
    }
  };
  try {
    const iconCandidates = [
      join(__dirname, "..", "..", "client", "public", "icon_only_dark.png"),
      join(__dirname, "..", "..", "..", "client", "public", "icon_only_dark.png"),
    ];
    const trayIconPath = iconCandidates.find((p) => existsSync(p));
    if (trayIconPath) {
      const tray = new Tray(trayIconPath);
      trayRef = tray;
      tray.setToolTip("CrowdOS");
      trayRefreshHook = refreshTray;
      refreshTray();
      tray.on("click", () => {
        focusMainWindow(win as unknown as Parameters<typeof focusMainWindow>[0]);
      });
    }
  } catch {
    // Tray is best-effort
  }

  // Windows JumpList recents (Discord/Slack parity for taskbar right-click).
  try {
    const jumpCfg = loadDesktopConfig(paths.configFile);
    const jumpRecents = (jumpCfg.recentWorkspaceIds ?? []).slice(0, 5);
    if (jumpRecents.length > 0) {
      (app as unknown as {
        setJumpList?: (items: Array<{ type: string; items?: Array<Record<string, unknown>> }>) => void;
      }).setJumpList?.([
        {
          type: "custom",
          items: jumpRecents.map((id) => ({
            type: "task",
            title: id,
            program: process.execPath,
            args: `crowdos://w/${id}`,
          })),
        },
      ]);
    }
  } catch {
    // ignore
  }

  // Single global shortcut (user decision): show/hide the workspace.
  // Everything else stays in-app (Ctrl+K palette) to avoid OS conflicts.
  try {
    const accelerator = "CommandOrControl+Shift+O";
    const ok = globalShortcut.register(accelerator, () => {
      try {
        const w = win as unknown as {
          isVisible?: () => boolean;
          hide?: () => void;
        } & Parameters<typeof focusMainWindow>[0];
        if (w.isVisible?.() === false) focusMainWindow(w);
        else if ((win as unknown as { isMinimized?: () => boolean }).isMinimized?.()) {
          focusMainWindow(w);
        } else {
          try {
            (w as { hide?: () => void }).hide?.();
          } catch {
            focusMainWindow(w);
          }
        }
      } catch {
        // ignore
      }
    });
    if (!ok) console.warn(`[desktop] global shortcut ${accelerator} unavailable`);
    (app as unknown as { on: (e: string, cb: () => void) => void }).on("will-quit", () => {
      try {
        globalShortcut.unregisterAll();
      } catch {
        // ignore
      }
    });
  } catch {
    // global shortcuts are best-effort (sandboxed/CI environments)
  }

  // Spellcheck suggestions context menu (Slack/Discord parity).
  try {
    const contents = win.webContents as unknown as {
      on?: (e: string, cb: (event: unknown, params: Record<string, unknown>) => void) => void;
    };
    contents.on?.("context-menu", (_event: unknown, params: Record<string, unknown>) => {
      try {
        const misspelt = params?.misspelledWord as string | undefined;
        const suggestions = (params?.dictionarySuggestions as string[] | undefined) ?? [];
        const menu = Menu.buildFromTemplate([
          ...(misspelt
            ? [
                ...suggestions.slice(0, 5).map((s) => ({
                  label: s,
                  click: () =>
                    (win.webContents as unknown as { replaceMisspelling?: (s: string) => void }).replaceMisspelling?.(s),
                })),
                { type: "separator" as const },
              ]
            : []),
          { role: "copy" as const },
          { role: "paste" as const },
          { role: "cut" as const },
          { role: "selectAll" as const },
        ]);
        menu.popup();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  // Crashed-renderer recovery instead of a dead white window.
  try {
    const wc = win.webContents as unknown as {
      on?: (e: string, cb: (event: unknown, killed: boolean) => void) => void;
    };
    wc.on?.("render-process-gone", (_event: unknown, killed: boolean) => {
      try {
        const answer = (dialog as unknown as { showMessageBoxSync: (w: unknown, o: unknown) => number }).showMessageBoxSync(win, {
          type: "warning",
          title: "CrowdOS renderer stopped",
          message: killed
            ? "The workspace view was stopped unexpectedly."
            : "The workspace view crashed.",
          detail: "Reload to continue. Recent work is preserved on local files.",
          buttons: ["Reload", "Close"],
          defaultId: 0,
        });
        if (answer === 0) {
          try {
            (win.webContents as unknown as { reload?: () => void }).reload?.();
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
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
        "client/dist/index.html was not found. Run: npm run build --workspace @crowdspace/client",
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

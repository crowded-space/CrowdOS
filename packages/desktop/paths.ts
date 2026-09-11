import { join, normalize } from "node:path";

// Filesystem roots for the desktop shell.
//
// IMPORTANT: never call process.cwd() here (or in any new desktop code).
// The working directory is launch-dependent (dev runner vs. packaged app vs.
// tests) and must not be treated as the data/workspace root. Callers inject
// the Electron `app.getPath("userData")` value instead, which keeps this
// module pure, deterministic, and unit-testable without Electron.

export function resolveDesktopDataRoot(appUserDataPath: string): string {
  if (!appUserDataPath || appUserDataPath.trim().length === 0) {
    throw new Error("resolveDesktopDataRoot: appUserDataPath must be non-empty");
  }
  return normalize(appUserDataPath);
}

export function resolveWorkspaceRoot(dataRoot: string): string {
  if (!dataRoot || dataRoot.trim().length === 0) {
    throw new Error("resolveWorkspaceRoot: dataRoot must be non-empty");
  }
  return join(dataRoot, "workspaces");
}

export function resolveWorkspacesDir(dataRoot: string): string {
  if (!dataRoot || dataRoot.trim().length === 0) {
    throw new Error("resolveWorkspacesDir: dataRoot must be non-empty");
  }
  return join(dataRoot, "workspaces");
}

export function resolveLogsDir(dataRoot: string): string {
  if (!dataRoot || dataRoot.trim().length === 0) {
    throw new Error("resolveLogsDir: dataRoot must be non-empty");
  }
  return join(dataRoot, "logs");
}

export function rendererCandidates(baseDir?: string): string[] {
  const out: string[] = [];
  try {
    const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
    if (resources) out.push(join(resources, "client", "dist", "index.html"));
  } catch {}
  try {
    const electron = (process as any)?.versions?.electron;
    if (electron) {
      const app = (globalThis as any).electronApp;
      const appPath = app?.getAppPath?.();
      if (appPath) out.push(join(appPath, "..", "client", "dist", "index.html"));
    }
  } catch {}
  const targetDir = baseDir ?? (typeof __dirname !== "undefined" ? __dirname : "");
  if (targetDir) {
    out.push(join(targetDir, "..", "..", "client", "dist", "index.html"));
    out.push(join(targetDir, "..", "..", "..", "client", "dist", "index.html"));
  }
  return out;
}

export const DESKTOP_STORE_FILES = {
  config: "config.json",
  cursors: "cursors.json",
} as const;

export function resolveConfigFile(dataRoot: string): string {
  if (!dataRoot || dataRoot.trim().length === 0) {
    throw new Error("resolveConfigFile: dataRoot must be non-empty");
  }
  return join(dataRoot, DESKTOP_STORE_FILES.config);
}

export interface DesktopPaths {
  dataRoot: string;
  workspaceRoot: string;
  /** Plural alias of workspaceRoot: <userData>/workspaces/ */
  workspacesDir: string;
  /** <userData>/logs/ */
  logsDir: string;
  /** <userData>/config.json */
  configFile: string;
}

export function getDesktopPaths(appUserDataPath: string): DesktopPaths {
  const dataRoot = resolveDesktopDataRoot(appUserDataPath);
  const workspaceRoot = resolveWorkspaceRoot(dataRoot);
  const workspacesDir = resolveWorkspacesDir(dataRoot);
  const logsDir = resolveLogsDir(dataRoot);
  const configFile = resolveConfigFile(dataRoot);
  return { dataRoot, workspaceRoot, workspacesDir, logsDir, configFile };
}

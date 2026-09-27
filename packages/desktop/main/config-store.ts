import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Persisted desktop shell state (main process only, never the renderer).
// Stored at <userData>/config.json — UI prefs stay in renderer localStorage,
// seq cursors migrate to cursors.json in a later phase (see desktop-storage.ts).
export interface DesktopFileConfig {
  backendPort?: number;
  windowBounds?: { x?: number; y?: number; width: number; height: number };
  recentWorkspaceIds?: string[];
}

export function loadDesktopConfig(configFile: string): DesktopFileConfig {
  try {
    const raw = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as DesktopFileConfig;
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

export function saveDesktopConfig(configFile: string, patch: DesktopFileConfig): DesktopFileConfig {
  const current = loadDesktopConfig(configFile);
  const next = { ...current, ...patch };
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(next, null, 2), "utf8");
  return next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingConfig: DesktopFileConfig | null = null;

export function saveDesktopConfigDebounced(
  configFile: string,
  patch: DesktopFileConfig,
  delayMs = 300,
): void {
  const current = pendingConfig ?? loadDesktopConfig(configFile);
  pendingConfig = { ...current, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (pendingConfig) {
      saveDesktopConfig(configFile, pendingConfig);
      pendingConfig = null;
    }
    saveTimer = null;
  }, delayMs);
}

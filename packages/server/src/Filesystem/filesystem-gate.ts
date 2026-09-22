// ─── Filesystem domain gate ──────────────────────────────────────────
// Depends-on: none
import { LocalFilesystem, type LocalFilesystemOptions } from "./local-filesystem.js";
import {
  normalizePath,
  isPathSafe,
  isInsideRoot,
  resolveWorkspacePath,
  extractName,
  guessMimeType,
} from "./path-guard.js";
import type { FileNode, FileStat } from "./filesystem-types.js";
import { REPO_MARKER_NAMES, isVisibleEntryName } from "./entry-visibility.js";

export { LocalFilesystem, normalizePath, isPathSafe, isInsideRoot, resolveWorkspacePath, extractName, guessMimeType, isVisibleEntryName, REPO_MARKER_NAMES };
export type { FileNode, FileStat, LocalFilesystemOptions };

export const filesystemGate = {
  createLocalFilesystem: (options: LocalFilesystemOptions) => new LocalFilesystem(options),
  normalizePath,
  isPathSafe,
  isInsideRoot,
  resolveWorkspacePath,
  extractName,
  guessMimeType,
  isVisibleEntryName,
};

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

export { LocalFilesystem, normalizePath, isPathSafe, isInsideRoot, resolveWorkspacePath, extractName, guessMimeType };
export type { FileNode, FileStat, LocalFilesystemOptions };

export const filesystemGate = {
  createLocalFilesystem: (options: LocalFilesystemOptions) => new LocalFilesystem(options),
  normalizePath,
  isPathSafe,
  isInsideRoot,
  resolveWorkspacePath,
  extractName,
  guessMimeType,
};

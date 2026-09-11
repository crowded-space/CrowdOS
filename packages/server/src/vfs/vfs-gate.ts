import { LocalVFS, type LocalVFSOptions } from "./local-vfs.js";
import { normalizePath, isPathSafe, resolveWorkspacePath, extractName, guessMimeType } from "./path-guard.js";
import type { VirtualFS, FileNode, FileStat } from "./vfs.interface.js";

export { LocalVFS, normalizePath, isPathSafe, resolveWorkspacePath, extractName, guessMimeType };
export type { VirtualFS, FileNode, FileStat, LocalVFSOptions };

export const vfsGate = {
  createLocalVFS: (options: LocalVFSOptions) => new LocalVFS(options),
  normalizePath,
  isPathSafe,
  resolveWorkspacePath,
  extractName,
  guessMimeType,
};

export type { VirtualFS, FileNode, FileStat } from "./vfs.interface.js";
export { LocalVFS } from "./local-vfs.js";
export type { LocalVFSOptions } from "./local-vfs.js";
export { normalizePath, isPathSafe, resolveWorkspacePath, extractName, guessMimeType } from "./path-guard.js";
export interface MountInfo {
  workspaceId: string | null;
  mountedPath: string | null;
  source: "channel" | "category" | "workspace" | "none";
  effectivePath: string | null;
}

export interface ChannelMountRecord {
  id: string;
  workspaceId: string | null;
  categoryId: string | null;
  name: string;
  folderPath: string | null;
}

export interface CategoryMountRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  folderPath: string | null;
}

export interface WorkspaceMountRecord {
  id: string;
  name: string;
  rootPath: string;
  folderPath: string | null;
}

export interface FsBrowseEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

// ─── Virtual Filesystem Interface ────────────────────────────────────

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mimeType: string | null;
  updatedAt: Date;
}

export interface FileStat {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mimeType: string | null;
  checksum: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface VirtualFS {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  list(path: string): Promise<FileNode[]>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  initialize(): Promise<void>;
}
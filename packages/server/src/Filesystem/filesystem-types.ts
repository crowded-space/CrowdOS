// ─── Filesystem contracts ────────────────────────────────────────────
// One implementation (LocalFilesystem) — no interface abstraction.

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

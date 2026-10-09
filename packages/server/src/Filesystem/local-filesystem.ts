// ─── Local Filesystem Implementation ───────────────────────────────────
// CrowdOS §16 + §35.5: direct clamped fs, no DB mirror.
// Reads/writes hit disk only via the path-guard jail.
//
// Canon (mock-structure-polished): initialize() materializes the workspace
// folder layout — a per-folder workspace.json plus vfs/{.crowdos,agents,
// artifacts,src}. `vfs/` is a local config sandbox: never a mount target for
// user repositories.

import fs from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspacePath, normalizePath, extractName, guessMimeType } from "./path-guard.js";
import { isVisibleEntryName } from "./entry-visibility.js";
import type { FileNode, FileStat } from "./filesystem-types.js";

export interface LocalFilesystemOptions {
  workspaceId: string;
  workspaceRoot: string;
  actorId: string;
  /**
   * Display name written into the per-folder workspace.json copy. Absent = the
   * workspace id (the copy is a mirror; the global index stays truth).
   */
  workspaceName?: string;
  onEvent?: (type: string, path: string, metadata?: Record<string, unknown>) => void;
}

export class LocalFilesystem {
  private readonly workspaceId: string;
  private readonly workspaceRoot: string;
  private readonly actorId: string;
  private readonly workspaceName: string;
  private readonly onEvent?: LocalFilesystemOptions["onEvent"];

  constructor(options: LocalFilesystemOptions) {
    this.workspaceId = options.workspaceId;
    this.workspaceRoot = options.workspaceRoot;
    this.actorId = options.actorId;
    this.workspaceName = options.workspaceName?.trim() || options.workspaceId;
    this.onEvent = options.onEvent;
  }

  async initialize(): Promise<void> {
    // Pure fs: ensure the canon folder layout. No DB.
    await fs.mkdir(this.workspaceRoot, { recursive: true });

    const standardDirs = [
      "/vfs",
      "/vfs/src",
      "/vfs/artifacts",
      "/vfs/agents",
      "/vfs/.crowdos",
      "/vfs/.crowdos/runtime",
      "/vfs/.crowdos/cache",
      "/vfs/.crowdos/snapshots",
    ];

    for (const dir of standardDirs) {
      await this.mkdir(dir);
    }

    // Canon: runtime object only — permissions, constraints, artifactDir,
    // fsMounts. Categories and channels live in their own files next to it.
    const wsJsonPath = "/vfs/.crowdos/workspace.json";
    if (!(await this.exists(wsJsonPath))) {
      const defaultMeta = {
        workspace: {
          id: this.workspaceId,
          name: this.workspaceName,
          createdAt: new Date().toISOString(),
          permissions: { network: false, shell: false, maxAgents: 8 },
          constraints: { networkAccess: false, shellExecution: true, memoryLimitMb: 512, cpuLimit: 1 },
          artifactDir: "vfs/artifacts",
          fsMounts: { scope: "workspace", mode: "default", mounts: [] },
        },
      };
      await this.write(wsJsonPath, JSON.stringify(defaultMeta, null, 2));
    }
  }

  private resolve(path: string): Promise<string> {
    return resolveWorkspacePath(this.workspaceRoot, path);
  }

  async read(path: string): Promise<string> {
    const absPath = await this.resolve(path);
    const stat = await fs.stat(absPath).catch(() => null);
    const MAX_READ_BYTES = 1_048_576; // 1MB cap — prevents OOM from large files into LLM context
    if (stat && stat.size > MAX_READ_BYTES) {
      const handle = await fs.open(absPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        await handle.read(buf, 0, MAX_READ_BYTES, 0);
        return buf.toString('utf8') + `\n\n[TRUNCATED: file ${stat.size} bytes, showing first ${MAX_READ_BYTES} bytes]`;
      } finally { await handle.close(); }
    }
    return fs.readFile(absPath, "utf8");
  }

  async readBinary(path: string): Promise<Buffer> {
    const absPath = await this.resolve(path);
    const stat = await fs.stat(absPath).catch(() => null);
    const MAX_READ_BYTES = 1_048_576;
    // FS-002: truncation was silent (text path returns a marker, binary did
    // not). Record it on the buffer so callers can detect the cut.
    if (stat && stat.size > MAX_READ_BYTES) {
      const handle = await fs.open(absPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0);
        const out = buf.subarray(0, bytesRead);
        (out as unknown as Record<string, unknown>).truncated = true;
        (out as unknown as Record<string, unknown>).totalBytes = stat.size;
        return out;
      } finally { await handle.close(); }
    }
    return fs.readFile(absPath);
  }

  async write(path: string, content: string): Promise<void> {
    const absPath = await this.resolve(path);
    const normalized = normalizePath(path);
    const size = Buffer.byteLength(content, "utf8");

    const parentDir = join(absPath, "..");
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
    this.onEvent?.("file.updated", normalized, { size });
  }

  async mkdir(path: string): Promise<void> {
    const absPath = await this.resolve(path);
    await fs.mkdir(absPath, { recursive: true });
  }

  async delete(path: string): Promise<void> {
    const absPath = await this.resolve(path);
    const normalized = normalizePath(path);
    const stat = await fs.stat(absPath);

    if (stat.isDirectory()) {
      await fs.rm(absPath, { recursive: true, force: true });
    } else {
      await fs.unlink(absPath);
    }
    this.onEvent?.("file.deleted", normalized);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = await this.resolve(oldPath);
    const absNew = await this.resolve(newPath);
    const normalizedNew = normalizePath(newPath);
    const normalizedOld = normalizePath(oldPath);

    const newParent = join(absNew, "..");
    await fs.mkdir(newParent, { recursive: true });
    await fs.rename(absOld, absNew);
    this.onEvent?.("file.renamed", normalizedNew, { oldPath: normalizedOld });
  }

  async list(path: string): Promise<FileNode[]> {
    const absPath = await this.resolve(path);
    const entries = await fs.readdir(absPath, { withFileTypes: true });

    // One visibility rule, shared with the mount picker (entry-visibility.ts).
    // This used to hide only .crowdos, so a mounted repository’s own markers
    // showed up in the picker but vanished from the tree.
    const filtered = entries.filter((entry) => isVisibleEntryName(entry.name));
    const nodes: FileNode[] = [];
    const BOUNDED_CONCURRENCY = 32;
    for (let i = 0; i < filtered.length; i += BOUNDED_CONCURRENCY) {
      const batch = filtered.slice(i, i + BOUNDED_CONCURRENCY);
      const batchNodes = await Promise.all(
        batch.map(async (entry): Promise<FileNode | null> => {
          // FS-001: one dangling symlink/junction must not fail the whole
          // listing. A broken entry resolves to null here and is skipped
          // below (was: stat throw -> LIST_FAIL ENOENT for the entire dir).
          try {
            const entryPath = join(absPath, entry.name);
            const stat = await fs.stat(entryPath);
            return {
              name: entry.name,
              path: normalizePath(join(path, entry.name)),
              type: entry.isDirectory() ? "directory" : "file",
              size: stat.size,
              mimeType: entry.isFile() ? guessMimeType(entry.name) : null,
              updatedAt: stat.mtime,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const n of batchNodes) if (n) nodes.push(n);
    }

    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const name = extractName(path);
    const absPath = await this.resolve(path);
    const fsStat = await fs.stat(absPath);

    return {
      name,
      path: normalized,
      type: fsStat.isDirectory() ? "directory" : "file",
      size: fsStat.size,
      mimeType: fsStat.isFile() ? guessMimeType(name) : null,
      checksum: null,
      createdAt: fsStat.birthtime,
      updatedAt: fsStat.mtime,
      createdBy: this.actorId,
      updatedBy: this.actorId,
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const absPath = await this.resolve(path);
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Local VFS Implementation ────────────────────────────────────────
// VirtualFS backed by local disk with metadata sync to PostgreSQL.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";

import { getDb } from "../shared/config/database.js";
import { workspaceNodes, workspaces } from "../db/schema.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import { resolveWorkspacePath, normalizePath, extractName, guessMimeType } from "./path-guard.js";
import type { VirtualFS, FileNode, FileStat } from "./vfs.interface.js";

export interface LocalVFSOptions {
  workspaceId: string;
  workspaceRoot: string;
  actorId: string;
  onEvent?: (type: string, path: string, metadata?: Record<string, unknown>) => void;
}

/**
 * Directory listing cache (P2-1). Shared across LocalVFS instances of the same
 * process so any instance's mutation invalidates the workspace's entries.
 * Short TTL bounds staleness for out-of-band disk changes (e.g. bash tools).
 */
const listCache = new TtlCache<FileNode[]>(10_000, 300);

export class LocalVFS implements VirtualFS {
  private readonly workspaceId: string;
  private readonly workspaceRoot: string;
  private readonly actorId: string;
  private readonly onEvent?: LocalVFSOptions["onEvent"];

  constructor(options: LocalVFSOptions) {
    this.workspaceId = options.workspaceId;
    this.workspaceRoot = options.workspaceRoot;
    this.actorId = options.actorId;
    this.onEvent = options.onEvent;
  }

  async initialize(): Promise<void> {
    const db = getDb();

    // 1. Ensure workspace row exists in DB (especially for "default" workspace to avoid FK constraint errors)
    const existing = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, this.workspaceId),
    });

    if (!existing) {
      const now = new Date();
      await db.insert(workspaces).values({
        id: this.workspaceId,
        name: this.workspaceId === "default" ? "Default Workspace" : this.workspaceId,
        ownerId: this.actorId || "human_operator",
        status: "ACTIVE",
        rootPath: this.workspaceRoot.replace(/\\/g, "/"),
        permissions: {
          network: false,
          shell: false,
          maxAgents: 8,
        },
        constraints: {
          networkAccess: false,
          shellExecution: true,
          memoryLimitMb: 512,
          cpuLimit: 1,
        },
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
    }

    // 2. Ensure physical root folder exists
    await fs.mkdir(this.workspaceRoot, { recursive: true });

    // 3. Initialize default sectors via VFS mkdir so they sync to PG nodes table
    const standardDirs = [
      "/src",
      "/artifacts",
      "/agents",
      "/.crowdos",
      "/.crowdos/runtime",
      "/.crowdos/cache",
      "/.crowdos/snapshots",
    ];

    for (const dir of standardDirs) {
      await this.mkdir(dir);
    }

    // 4. Create default workspace.json inside /.crowdos if not present
    const wsJsonPath = "/.crowdos/workspace.json";
    if (!(await this.exists(wsJsonPath))) {
      const defaultMeta = {
        id: this.workspaceId,
        name: this.workspaceId === "default" ? "Default Workspace" : this.workspaceId,
        createdAt: new Date().toISOString(),
        permissions: { network: false, shell: false, maxAgents: 8 },
        constraints: { networkAccess: false, shellExecution: true, memoryLimitMb: 512, cpuLimit: 1 },
      };
      await this.write(wsJsonPath, JSON.stringify(defaultMeta, null, 2));
    }
  }

  private resolve(path: string): Promise<string> {
    return resolveWorkspacePath(this.workspaceRoot, path);
  }

  /** Invalidate cached listings for this workspace after a mutation. */
  private invalidateListCache(): void {
    listCache.invalidatePrefix(`${this.workspaceId}:`);
  }

  private computeChecksum(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
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
    if (stat && stat.size > MAX_READ_BYTES) {
      const handle = await fs.open(absPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0);
        return buf.subarray(0, bytesRead);
      } finally { await handle.close(); }
    }
    return fs.readFile(absPath);
  }

  async write(path: string, content: string): Promise<void> {
    const absPath = await this.resolve(path);
    const normalized = normalizePath(path);
    const name = extractName(path);
    const checksum = this.computeChecksum(content);
    const size = Buffer.byteLength(content, "utf8");
    const mimeType = guessMimeType(name);

    // Ensure parent directory exists
    const parentDir = join(absPath, "..");
    await fs.mkdir(parentDir, { recursive: true });

    // Write to disk first; compensate (rm) if the DB upsert below fails
    // so disk and DB never diverge (crash between separate select+insert
    // used to leave one without the other).
    await fs.writeFile(absPath, content, "utf8");

    // Sync metadata to DB atomically in 1 RTT via upsert on
    // (workspace_id, path). The generated id distinguishes insert from
    // update: on conflict the existing id survives, on insert ours does.
    const db = getDb();
    const now = new Date();
    const nodeId = randomUUID();
    try {
      const [row] = await db.insert(workspaceNodes).values({
        id: nodeId,
        workspaceId: this.workspaceId,
        path: normalized,
        name,
        type: "file",
        mimeType,
        size,
        checksum,
        createdBy: this.actorId,
        updatedBy: this.actorId,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [workspaceNodes.workspaceId, workspaceNodes.path],
        set: { size, checksum, mimeType, updatedBy: this.actorId, updatedAt: now },
      }).returning({ id: workspaceNodes.id });

      this.invalidateListCache();
      this.onEvent?.(row.id === nodeId ? "file.created" : "file.updated", normalized, { checksum, size });
    } catch (err) {
      await fs.rm(absPath, { force: true }).catch(() => {});
      this.invalidateListCache();
      throw err;
    }
  }

  async mkdir(path: string): Promise<void> {
    const absPath = await this.resolve(path);
    const normalized = normalizePath(path);
    const name = extractName(path);

    await fs.mkdir(absPath, { recursive: true });
    this.invalidateListCache();

    // Sync directory node to DB atomically via insert-or-ignore on
    // (workspace_id, path) — avoids select→insert race under concurrency.
    const db = getDb();
    const now = new Date();
    await db.insert(workspaceNodes).values({
      id: randomUUID(),
      workspaceId: this.workspaceId,
      path: normalized,
      name,
      type: "directory",
      mimeType: null,
      size: 0,
      checksum: null,
      createdBy: this.actorId,
      updatedBy: this.actorId,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: [workspaceNodes.workspaceId, workspaceNodes.path] });
  }

  async delete(path: string): Promise<void> {
    const absPath = await this.resolve(path);
    const normalized = normalizePath(path);

    // Check if it's a directory or file
    const stat = await fs.stat(absPath);

    if (stat.isDirectory()) {
      await fs.rm(absPath, { recursive: true, force: true });
    } else {
      await fs.unlink(absPath);
    }
    this.invalidateListCache();

    // Remove from DB (cascade removes children for directories)
    const db = getDb();
    const node = await db.query.workspaceNodes.findFirst({
      where: and(
        eq(workspaceNodes.workspaceId, this.workspaceId),
        eq(workspaceNodes.path, normalized),
      ),
    });

    if (node) {
      await db.delete(workspaceNodes).where(eq(workspaceNodes.id, node.id));
    }

    this.onEvent?.("file.deleted", normalized);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = await this.resolve(oldPath);
    const absNew = await this.resolve(newPath);
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const newName = extractName(newPath);

    // Ensure new parent exists
    const newParent = join(absNew, "..");
    await fs.mkdir(newParent, { recursive: true });

    await fs.rename(absOld, absNew);
    this.invalidateListCache();

    // Update DB
    const db = getDb();
    const node = await db.query.workspaceNodes.findFirst({
      where: and(
        eq(workspaceNodes.workspaceId, this.workspaceId),
        eq(workspaceNodes.path, normalizedOld),
      ),
    });

    if (node) {
      await db.update(workspaceNodes)
        .set({
          path: normalizedNew,
          name: newName,
          mimeType: guessMimeType(newName),
          updatedBy: this.actorId,
          updatedAt: new Date(),
        })
        .where(eq(workspaceNodes.id, node.id));
    }

    this.onEvent?.("file.renamed", normalizedNew, { oldPath: normalizedOld });
  }

  async list(path: string): Promise<FileNode[]> {
    const normalizedDir = normalizePath(path);
    const cacheKey = `${this.workspaceId}:${normalizedDir}`;
    const cached = listCache.get(cacheKey);
    if (cached) return cached;

    const absPath = await this.resolve(path);
    const entries = await fs.readdir(absPath, { withFileTypes: true });

    // Bounded stat concurrency (32) — prevents EMFILE on large dirs (was unbounded Promise.all)
    const filtered = entries.filter((entry) => entry.name !== ".crowdos");
    const nodes: FileNode[] = [];
    const BOUNDED_CONCURRENCY = 32;
    for (let i = 0; i < filtered.length; i += BOUNDED_CONCURRENCY) {
      const batch = filtered.slice(i, i + BOUNDED_CONCURRENCY);
      const batchNodes = await Promise.all(
        batch.map(async (entry): Promise<FileNode> => {
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
        }),
      );
      nodes.push(...batchNodes);
    }

    nodes.sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    listCache.set(cacheKey, nodes);
    return nodes;
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const name = extractName(path);
    const absPath = await this.resolve(path);

    // Try to get metadata from DB
    const db = getDb();
    const [fsStat, node] = await Promise.all([
      fs.stat(absPath),
      db.query.workspaceNodes.findFirst({
        where: and(
          eq(workspaceNodes.workspaceId, this.workspaceId),
          eq(workspaceNodes.path, normalized),
        ),
      }),
    ]);

    return {
      name,
      path: normalized,
      type: fsStat.isDirectory() ? "directory" : "file",
      size: fsStat.size,
      mimeType: fsStat.isFile() ? guessMimeType(name) : null,
      checksum: node?.checksum ?? null,
      createdAt: node?.createdAt ?? fsStat.birthtime,
      updatedAt: node?.updatedAt ?? fsStat.mtime,
      createdBy: node?.createdBy ?? "unknown",
      updatedBy: node?.updatedBy ?? "unknown",
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
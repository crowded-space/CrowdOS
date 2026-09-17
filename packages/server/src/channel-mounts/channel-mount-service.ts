import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "../shared/config/database.js";
import { channels, categories, workspaces } from "../db/schema.js";
import { channelGate } from "../channels/channel-gate.js";
import { getWorkspaceRecord } from "../workspace/workspace-gate.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import type { MountInfo } from "./channel-mount-types.js";

// ponytail: mount realpath cached 60s — validate/browse hit the same roots repeatedly.
const mountRealCache = new TtlCache<string>(60_000, 200);

async function cachedRealpath(p: string): Promise<string> {
  const hit = mountRealCache.get(p);
  if (hit) return hit;
  const real = await fsp.realpath(p);
  mountRealCache.set(p, real);
  return real;
}

function getAllowedRoots(): string[] {
  const envRoots = process.env.ALLOWED_MOUNT_ROOTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (envRoots.length > 0) return envRoots.map((p) => path.resolve(p));
  // Deny by default: sandbox only. Operator opts in via ALLOWED_MOUNT_ROOTS.
  // ponytail: single sandbox root; per-workspace roots when multi-tenant matters.
  const sandbox = process.env.WORKSPACE_DIR?.trim()
    ? path.resolve(process.env.WORKSPACE_DIR.trim())
    : path.resolve(path.join(process.cwd(), "sandbox"));
  return [sandbox];
}

function isInsideAllowedRoots(candidate: string, roots: string[]): boolean {
  const norm = (p: string) => {
    let n = path.resolve(p);
    if (process.platform === "win32") {
      n = n.toLowerCase();
      n = n.replace(/^\\\\\?\\/, "");
    }
    while (n.length > 1 && n.endsWith(path.sep)) n = n.slice(0, -1);
    return n;
  };
  const c = norm(candidate);
  return roots.some((r) => {
    const rn = norm(r);
    if (c === rn) return true;
    return c.startsWith(rn.endsWith(path.sep) ? rn : rn + path.sep);
  });
}

export async function validateMountPath(absPath: string): Promise<{ valid: boolean; resolved?: string; error?: string }> {
  if (!absPath || typeof absPath !== "string") return { valid: false, error: "Path required" };
  const trimmed = absPath.trim();
  if (!trimmed) return { valid: false, error: "Path required" };
  // Fast-path: null byte can never be valid — skip stat/realpath syscalls.
  if (trimmed.includes("\0")) return { valid: false, error: "Invalid path" };
  let resolved: string;
  try {
    resolved = path.resolve(trimmed);
  } catch {
    return { valid: false, error: "Invalid path" };
  }
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) return { valid: false, error: "Path is not a directory" };
  } catch (e: any) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { valid: false, error: "Path does not exist" };
    return { valid: false, error: e?.message || "Cannot stat path" };
  }
  // realpath for symlink safety
  let real: string;
  try {
    real = await cachedRealpath(resolved);
  } catch {
    real = resolved;
  }
  if (process.platform === "win32") {
    real = real.replace(/^\\\\\?\\/, "");
  }
  const allowedRoots = getAllowedRoots();
  if (!isInsideAllowedRoots(real, allowedRoots)) {
    return { valid: false, error: `Path outside allowed roots: ${allowedRoots.join(", ")}` };
  }
  return { valid: true, resolved: real };
}

export async function resolveWorkspaceMount(workspaceId: string): Promise<MountInfo> {
  // C3 local-first: registry record is truth when no DATABASE_URL.
  if (!isDatabaseConfigured()) {
    const record = await getWorkspaceRecord(workspaceId).catch(() => null);
    if (!record) return { workspaceId: null, mountedPath: null, source: "none", effectivePath: null };
    if (record.rootPath) {
      const v = await validateMountPath(record.rootPath);
      if (v.valid) {
        return { workspaceId: record.id, mountedPath: v.resolved!, source: "workspace", effectivePath: v.resolved! };
      }
    }
    return { workspaceId: record.id, mountedPath: null, source: "none", effectivePath: record.rootPath ?? null };
  }
  const db = getDb();
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) return { workspaceId: null, mountedPath: null, source: "none", effectivePath: null };

  const customPath = (ws.metadata as Record<string, unknown>)?.customMountPath as string | undefined;
  if (customPath) {
    const v = await validateMountPath(customPath);
    if (v.valid) {
      return {
        workspaceId: ws.id,
        mountedPath: v.resolved!,
        source: "workspace",
        effectivePath: v.resolved!,
      };
    }
  }

  // Also check if rootPath itself is a valid native directory outside default sandbox
  if (ws.rootPath) {
    const defaultSandboxRoot = process.env.WORKSPACE_DIR?.trim()
      ? path.resolve(process.env.WORKSPACE_DIR.trim())
      : path.resolve(path.join(process.cwd(), "sandbox"));
    const wsResolved = path.resolve(ws.rootPath);
    if (!wsResolved.toLowerCase().startsWith(defaultSandboxRoot.toLowerCase())) {
      const v = await validateMountPath(wsResolved);
      if (v.valid) {
        return {
          workspaceId: ws.id,
          mountedPath: v.resolved!,
          source: "workspace",
          effectivePath: v.resolved!,
        };
      }
    }
  }

  return {
    workspaceId: ws.id,
    mountedPath: null,
    source: "none",
    effectivePath: ws.rootPath ?? null,
  };
}

export async function attachWorkspaceMount(workspaceId: string, folderPath: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  // C3 local-first: registry rootPath is truth when no DATABASE_URL.
  if (!isDatabaseConfigured()) {
    const { saveWorkspaceRecord } = await import("../workspace/workspace-gate.js");
    const record = await getWorkspaceRecord(workspaceId).catch(() => null);
    if (!record) return { ok: false, error: "Workspace not found" };
    if (folderPath === null || folderPath.trim() === "") {
      const defaultSandboxRoot = process.env.WORKSPACE_DIR?.trim()
        ? path.resolve(process.env.WORKSPACE_DIR.trim())
        : path.resolve(path.join(process.cwd(), "sandbox"));
      record.rootPath = path.join(defaultSandboxRoot, record.id).replace(/\\/g, "/");
      await saveWorkspaceRecord(record);
      return { ok: true };
    }
    const v = await validateMountPath(folderPath);
    if (!v.valid) return { ok: false, error: v.error! };
    record.rootPath = v.resolved!.replace(/\\/g, "/");
    await saveWorkspaceRecord(record);
    return { ok: true };
  }
  const db = getDb();
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) return { ok: false, error: "Workspace not found" };

  const defaultSandboxRoot = process.env.WORKSPACE_DIR?.trim()
    ? path.resolve(process.env.WORKSPACE_DIR.trim())
    : path.resolve(path.join(process.cwd(), "sandbox"));
  const defaultWsRoot = path.join(defaultSandboxRoot, ws.id).replace(/\\/g, "/");

  const currentMeta = (ws.metadata as Record<string, unknown>) || {};

  if (folderPath === null || folderPath.trim() === "") {
    await db.update(workspaces).set({
      rootPath: defaultWsRoot,
      metadata: { ...currentMeta, customMountPath: null },
      updatedAt: new Date(),
    }).where(eq(workspaces.id, workspaceId));
    return { ok: true };
  }

  const v = await validateMountPath(folderPath);
  if (!v.valid) return { ok: false, error: v.error! };

  await db.update(workspaces).set({
    rootPath: v.resolved!.replace(/\\/g, "/"),
    metadata: { ...currentMeta, customMountPath: v.resolved! },
    updatedAt: new Date(),
  }).where(eq(workspaces.id, workspaceId));
  return { ok: true };
}

export async function resolveChannelMount(channelId: string): Promise<MountInfo> {
  // C3 local-first: channelGate branches to files when no DATABASE_URL.
  const channel = await channelGate.get(channelId).catch(() => null);
  if (!channel) return { workspaceId: null, mountedPath: null, source: "none", effectivePath: null };

  // Start category + workspace lookups early so they run alongside the channel fs check.
  const catPromise = channel.categoryId
    ? channelGate.getCategory(channel.categoryId).catch(() => null)
    : Promise.resolve(null);
  const wsPromise: Promise<MountInfo | null> = channel.workspaceId
    ? resolveWorkspaceMount(channel.workspaceId)
    : Promise.resolve(null);

  // 1. Channel-level mount
  if (channel.folderPath) {
    const v = await validateMountPath(channel.folderPath);
    if (v.valid) {
      return {
        workspaceId: channel.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "channel",
        effectivePath: v.resolved!,
      };
    }
  }

  // 2. Category-level mount
  const [cat, wsMount] = await Promise.all([catPromise, wsPromise]);
  if (cat?.folderPath) {
    const v = await validateMountPath(cat.folderPath);
    if (v.valid) {
      return {
        workspaceId: channel.workspaceId ?? cat.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "category",
        effectivePath: v.resolved!,
      };
    }
  }

  // 3. Workspace-level mount
  if (wsMount?.mountedPath) {
    return {
      workspaceId: channel.workspaceId ?? null,
      mountedPath: wsMount.mountedPath,
      source: "workspace",
      effectivePath: wsMount.mountedPath,
    };
  }

  return {
    workspaceId: channel.workspaceId ?? null,
    mountedPath: null,
    source: "none",
    effectivePath: null,
  };
}

export async function resolveCategoryMount(categoryId: string): Promise<MountInfo> {
  // C3 local-first: channelGate branches to files when no DATABASE_URL.
  const cat = await channelGate.getCategory(categoryId).catch(() => null);
  if (!cat) return { workspaceId: null, mountedPath: null, source: "none", effectivePath: null };
  if (cat.folderPath) {
    const v = await validateMountPath(cat.folderPath);
    if (v.valid) {
      return {
        workspaceId: cat.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "category",
        effectivePath: v.resolved!,
      };
    }
  }
  // Inherit workspace-level mount if category has no folder
  if (cat.workspaceId) {
    const wsMount = await resolveWorkspaceMount(cat.workspaceId);
    if (wsMount.mountedPath) {
      return {
        workspaceId: cat.workspaceId,
        mountedPath: wsMount.mountedPath,
        source: "workspace",
        effectivePath: wsMount.mountedPath,
      };
    }
  }
  return { workspaceId: cat.workspaceId ?? null, mountedPath: null, source: "none", effectivePath: null };
}

export async function attachChannelMount(channelId: string, folderPath: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const channel = await channelGate.get(channelId).catch(() => null);
  if (!channel) return { ok: false, error: "Channel not found" };
  if (folderPath === null || folderPath.trim() === "") {
    await channelGate.update(channelId, { folderPath: null } as any).catch(() => null);
    return { ok: true };
  }
  const v = await validateMountPath(folderPath);
  if (!v.valid) return { ok: false, error: v.error! };
  await channelGate.update(channelId, { folderPath: v.resolved! } as any).catch(() => null);
  return { ok: true };
}

export async function attachCategoryMount(categoryId: string, folderPath: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const cat = await channelGate.getCategory(categoryId).catch(() => null);
  if (!cat) return { ok: false, error: "Category not found" };
  if (folderPath === null || folderPath.trim() === "") {
    await channelGate.updateCategory(categoryId, { folderPath: null }).catch(() => null);
    return { ok: true };
  }
  const v = await validateMountPath(folderPath);
  if (!v.valid) return { ok: false, error: v.error! };
  await channelGate.updateCategory(categoryId, { folderPath: v.resolved! }).catch(() => null);
  return { ok: true };
}

export async function browseFs(targetPath?: string): Promise<{
  path: string;
  parent: string | null;
  entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; path: string }>;
  allowedRoots: string[];
}> {
  const allowedRoots = getAllowedRoots();
  let dir = targetPath?.trim() ? path.resolve(targetPath.trim()) : allowedRoots[0] ?? os.homedir();
  // Clamp to allowed roots if outside
  let realDir: string;
  try {
    realDir = await cachedRealpath(dir);
  } catch {
    realDir = dir;
  }
  if (process.platform === "win32") {
    realDir = realDir.replace(/^\\\\\?\\/, "");
  }
  if (!isInsideAllowedRoots(realDir, allowedRoots)) {
    dir = allowedRoots[0] ?? os.homedir();
    try {
      realDir = await cachedRealpath(dir);
    } catch {
      realDir = dir;
    }
  }
  let stat;
  try {
    stat = await fsp.stat(realDir);
  } catch {
    throw new Error(`Path does not exist: ${realDir}`);
  }
  if (!stat.isDirectory()) {
    dir = path.dirname(realDir);
    realDir = dir;
  }
  const entries = await fsp.readdir(realDir, { withFileTypes: true });
  const filtered = entries
    .filter((e) => {
      // Show .ThisCrowd and .crowdos for repo switching, hide other dotfiles
      if (e.name === '.ThisCrowd' || e.name === '.crowdos' || e.name === '.crowdosrc') return true;
      return !e.name.startsWith('.');
    })
    .map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      path: path.join(realDir, e.name),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const parentCandidate = path.dirname(realDir);
  const parent = parentCandidate !== realDir && isInsideAllowedRoots(parentCandidate, allowedRoots)
    ? parentCandidate
    : null;

  return { path: realDir, parent, entries: filtered.slice(0, 300), allowedRoots };
}

export function getAllowedRootsList(): string[] {
  return getAllowedRoots();
}

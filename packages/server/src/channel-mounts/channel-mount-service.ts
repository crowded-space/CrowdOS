import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, isDatabaseConfigured, isConnectionError } from "../shared/config/database.js";
import { channels, categories, workspaces } from "../db/schema.js";
import { channelGate } from "../channels/channel-gate.js";
import { getWorkspaceRecord, resolveSandboxBase, resolveWorkspaceLocalRoot } from "../workspace/workspace-gate.js";
import { isVisibleEntryName } from "../Filesystem/filesystem-gate.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import type { EffectiveRoot, MountInfo, MountScope } from "./channel-mount-types.js";

// ponytail: mount realpath cached 60s — validate/browse hit the same roots repeatedly.
const mountRealCache = new TtlCache<string>(60_000, 200);

async function cachedRealpath(p: string): Promise<string> {
  const hit = mountRealCache.get(p);
  if (hit) return hit;
  const real = await fsp.realpath(p);
  mountRealCache.set(p, real);
  return real;
}

/**
 * Mount jail for a workspace (Zone B scope).
 *
 * Order: per-workspace registry field → default policy. There is deliberately
 * no env read here: `ALLOWED_MOUNT_ROOTS` appeared in neither `env.ts` nor
 * `.env.example`, so mounting a real repository failed with
 * "Path outside allowed roots" until the operator discovered an undocumented
 * variable. The jail now lives on the workspace record, which already sits
 * outside every root.
 *
 * Default policy = the workspace sandbox + the user's home directory, which is
 * where user repositories actually live. A workspace needing a different scope
 * sets `allowedMountRoots` on its registry record.
 */
async function getAllowedRoots(workspaceId?: string | null): Promise<string[]> {
  const defaultRoots = (): string[] => {
    const sandbox = resolveSandboxBase();
    const home = os.homedir();
    const resolvedHome = home ? path.resolve(home) : "";
    if (!resolvedHome || resolvedHome === sandbox) return [sandbox];
    return [sandbox, resolvedHome];
  };

  if (!workspaceId) return defaultRoots();
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  const configured = record?.allowedMountRoots;
  if (Array.isArray(configured) && configured.length > 0) {
    const resolved = configured
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => path.resolve(r.trim()));
    if (resolved.length > 0) return resolved;
  }
  return defaultRoots();
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

export async function validateMountPath(
  absPath: string,
  workspaceId?: string | null,
): Promise<{ valid: boolean; resolved?: string; error?: string }> {
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
  const allowedRoots = await getAllowedRoots(workspaceId);
  if (!isInsideAllowedRoots(real, allowedRoots)) {
    return { valid: false, error: `Path outside allowed roots: ${allowedRoots.join(", ")}` };
  }
  return { valid: true, resolved: real };
}

async function resolveWorkspaceMountFromRecord(workspaceId: string): Promise<MountInfo | null> {
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  if (!record) return null;
  // Zone B only. `rootPath` is Zone A (workspace-local state) and is NEVER a
  // mount — reading it here is what made the panel and the agent tools resolve
  // different roots the moment a mount was set.
  if (record.mountPath) {
    const v = await validateMountPath(record.mountPath, record.id);
    if (v.valid) {
      return { workspaceId: record.id, mountedPath: v.resolved!, source: "workspace" };
    }
    return {
      workspaceId: record.id,
      mountedPath: null,
      source: "none",
      reason: v.error ?? "Mount path is unusable",
    };
  }
  return { workspaceId: record.id, mountedPath: null, source: "none" };
}

export async function resolveWorkspaceMount(workspaceId: string): Promise<MountInfo> {
  // Dual-boot: registry record when no DATABASE_URL (or forced-local), with
  // record fallback when the PG path dies mid-outage.
  if (!isDatabaseConfigured()) {
    return (await resolveWorkspaceMountFromRecord(workspaceId)) ??
      { workspaceId: null, mountedPath: null, source: "none" };
  }
  try {
    const db = getDb();
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return { workspaceId: null, mountedPath: null, source: "none" };

    const customPath = (ws.metadata as Record<string, unknown>)?.customMountPath as string | undefined;
    if (customPath) {
      const v = await validateMountPath(customPath, ws.id);
      if (v.valid) {
        return {
          workspaceId: ws.id,
          mountedPath: v.resolved!,
          source: "workspace",
        };
      }
      // Configured but unusable — report why rather than silently falling back.
      return {
        workspaceId: ws.id,
        mountedPath: null,
        source: "none",
        reason: v.error ?? "Mount path is unusable",
      };
    }

    // No Zone B mount. `rootPath` (Zone A) is not a mount; the resolver returns
    // "none" and the caller falls back to the workspace-local root explicitly.
    return { workspaceId: ws.id, mountedPath: null, source: "none" };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    return (await resolveWorkspaceMountFromRecord(workspaceId)) ??
      { workspaceId: null, mountedPath: null, source: "none" };
  }
}

/**
 * THE resolver. Every consumer that needs "which directory do I work in for
 * this (workspace, channel)" must call this, or the Repo panel and the agent
 * file tools silently disagree the moment a mount is set.
 *
 * Zone B (a mounted repository) wins when one resolves; otherwise the answer is
 * Zone A (the workspace's own directory) with `zone: "workspace-local"`. The
 * caller therefore never has to re-derive the fallback — which is exactly how
 * the panel and the tools drifted apart before.
 */
export async function resolveEffectiveRoot(input: {
  workspaceId?: string | null;
  channelId?: string | null;
}): Promise<EffectiveRoot> {
  const { workspaceId, channelId } = input;

  if (channelId) {
    const mount = await resolveChannelMount(channelId);
    if (mount.mountedPath) {
      // `mountedPath` non-null implies a real level supplied it; `none` never
      // carries a path, so the narrowing is a formality for the type.
      const source = mount.source === "none" ? "workspace" : mount.source;
      return { path: mount.mountedPath, zone: "mounted", source, reason: null };
    }
    // A channel can name a workspace we were not told about; trust the channel.
    const effectiveWorkspaceId = workspaceId ?? mount.workspaceId;
    return {
      path: await resolveWorkspaceLocalRoot(effectiveWorkspaceId),
      zone: "workspace-local",
      source: "workspace-local",
      reason: mount.reason ?? null,
    };
  }

  if (workspaceId) {
    const mount = await resolveWorkspaceMount(workspaceId);
    if (mount.mountedPath) {
      return { path: mount.mountedPath, zone: "mounted", source: "workspace", reason: null };
    }
    return {
      path: await resolveWorkspaceLocalRoot(workspaceId),
      zone: "workspace-local",
      source: "workspace-local",
      reason: mount.reason ?? null,
    };
  }

  return {
    path: await resolveWorkspaceLocalRoot(null),
    zone: "workspace-local",
    source: "workspace-local",
    reason: null,
  };
}

/** `resolveEffectiveRoot` plus the panel-facing extras (Zone A sibling, label). */
export async function resolveMountScope(input: {
  workspaceId?: string | null;
  channelId?: string | null;
}): Promise<MountScope> {
  const [effective, workspaceRoot] = await Promise.all([
    resolveEffectiveRoot(input),
    resolveWorkspaceLocalRoot(input.workspaceId),
  ]);
  return {
    ...effective,
    workspaceRoot,
    displayName: path.basename(effective.path) || effective.path,
  };
}

export async function attachWorkspaceMount(workspaceId: string, folderPath: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  // C3 local-first: the registry is truth when no DATABASE_URL.
  if (!isDatabaseConfigured()) {
    const { saveWorkspaceRecord } = await import("../workspace/workspace-gate.js");
    const record = await getWorkspaceRecord(workspaceId).catch(() => null);
    if (!record) return { ok: false, error: "Workspace not found" };
    if (folderPath === null || folderPath.trim() === "") {
      // Clear = no Zone B mount. Zone A (`rootPath`) is untouched: it is the
      // workspace's own directory and was never a mount target.
      record.mountPath = null;
      await saveWorkspaceRecord(record);
      return { ok: true };
    }
    const v = await validateMountPath(folderPath, record.id);
    if (!v.valid) return { ok: false, error: v.error! };
    // Zone B only — writing this into `rootPath` made `initialize()` create the
    // CrowdOS workspace sectors inside the user's repository.
    record.mountPath = v.resolved!.replace(/\\/g, "/");
    await saveWorkspaceRecord(record);
    return { ok: true };
  }
  const db = getDb();
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) return { ok: false, error: "Workspace not found" };

  const currentMeta = (ws.metadata as Record<string, unknown>) || {};

  if (folderPath === null || folderPath.trim() === "") {
    // Clear the Zone B mount only. `rootPath` stays whatever Zone A already is.
    await db.update(workspaces).set({
      metadata: { ...currentMeta, customMountPath: null },
      updatedAt: new Date(),
    }).where(eq(workspaces.id, workspaceId));
    return { ok: true };
  }

  const v = await validateMountPath(folderPath, ws.id);
  if (!v.valid) return { ok: false, error: v.error! };

  await db.update(workspaces).set({
    metadata: { ...currentMeta, customMountPath: v.resolved! },
    updatedAt: new Date(),
  }).where(eq(workspaces.id, workspaceId));
  return { ok: true };
}

export async function resolveChannelMount(channelId: string): Promise<MountInfo> {
  // C3 local-first: channelGate branches to files when no DATABASE_URL.
  const channel = await channelGate.get(channelId).catch(() => null);
  if (!channel) return { workspaceId: null, mountedPath: null, source: "none" };

  // A configured-but-unusable path at any level is reported when nothing
  // resolves, so the panel can explain why it is empty.
  let channelMountReason: string | null = null;

  // Start category + workspace lookups early so they run alongside the channel fs check.
  const catPromise = channel.categoryId
    ? channelGate.getCategory(channel.categoryId).catch(() => null)
    : Promise.resolve(null);
  const wsPromise: Promise<MountInfo | null> = channel.workspaceId
    ? resolveWorkspaceMount(channel.workspaceId)
    : Promise.resolve(null);

  // 1. Channel-level mount
  if (channel.folderPath) {
    const v = await validateMountPath(channel.folderPath, channel.workspaceId);
    if (v.valid) {
      return {
        workspaceId: channel.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "channel",
      };
    }
    channelMountReason = v.error ?? "Channel mount path is unusable";
  }

  // 2. Category-level mount
  const [cat, wsMount] = await Promise.all([catPromise, wsPromise]);
  if (cat?.folderPath) {
    const v = await validateMountPath(cat.folderPath, cat.workspaceId);
    if (v.valid) {
      return {
        workspaceId: channel.workspaceId ?? cat.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "category",
      };
    }
    if (!channelMountReason) channelMountReason = v.error ?? "Category mount path is unusable";
  }

  // 3. Workspace-level mount
  if (wsMount?.mountedPath) {
    return {
      workspaceId: channel.workspaceId ?? null,
      mountedPath: wsMount.mountedPath,
      source: "workspace",
    };
  }

  return {
    workspaceId: channel.workspaceId ?? null,
    mountedPath: null,
    source: "none",
    reason: channelMountReason ?? wsMount?.reason ?? null,
  };
}

export async function resolveCategoryMount(categoryId: string): Promise<MountInfo> {
  // C3 local-first: channelGate branches to files when no DATABASE_URL.
  const cat = await channelGate.getCategory(categoryId).catch(() => null);
  if (!cat) return { workspaceId: null, mountedPath: null, source: "none" };
  let categoryMountReason: string | null = null;
  if (cat.folderPath) {
    const v = await validateMountPath(cat.folderPath, cat.workspaceId);
    if (v.valid) {
      return {
        workspaceId: cat.workspaceId ?? null,
        mountedPath: v.resolved!,
        source: "category",
      };
    }
    categoryMountReason = v.error ?? "Category mount path is unusable";
  }
  // Inherit workspace-level mount if category has no folder
  if (cat.workspaceId) {
    const wsMount = await resolveWorkspaceMount(cat.workspaceId);
    if (wsMount.mountedPath) {
      return {
        workspaceId: cat.workspaceId,
        mountedPath: wsMount.mountedPath,
        source: "workspace",
      };
    }
    if (!categoryMountReason) categoryMountReason = wsMount.reason ?? null;
  }
  return {
    workspaceId: cat.workspaceId ?? null,
    mountedPath: null,
    source: "none",
    reason: categoryMountReason,
  };
}

export async function attachChannelMount(channelId: string, folderPath: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const channel = await channelGate.get(channelId).catch(() => null);
  if (!channel) return { ok: false, error: "Channel not found" };
  if (folderPath === null || folderPath.trim() === "") {
    await channelGate.update(channelId, { folderPath: null } as any).catch(() => null);
    return { ok: true };
  }
  const v = await validateMountPath(folderPath, channel.workspaceId);
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
  const v = await validateMountPath(folderPath, cat.workspaceId);
  if (!v.valid) return { ok: false, error: v.error! };
  await channelGate.updateCategory(categoryId, { folderPath: v.resolved! }).catch(() => null);
  return { ok: true };
}

export async function browseFs(targetPath?: string, workspaceId?: string | null): Promise<{
  path: string;
  parent: string | null;
  entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; path: string }>;
  allowedRoots: string[];
}> {
  const allowedRoots = await getAllowedRoots(workspaceId);
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
    // Same rule the Repo tree uses (Filesystem/entry-visibility.ts): repo
    // markers stay visible, other dotfiles stay hidden. Previously each
    // surface had its own answer for the same directory.
    .filter((e) => isVisibleEntryName(e.name))
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

/** The jail this workspace actually enforces — one policy, one source. */
export async function getAllowedRootsList(workspaceId?: string | null): Promise<string[]> {
  return getAllowedRoots(workspaceId);
}

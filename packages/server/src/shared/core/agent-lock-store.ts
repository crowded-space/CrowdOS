/**
 * Agent Channel Lock Store — exempt Shared utility.
 * Any domain may import this directly (per Domain Facade Standard, Shared is exempt).
 * Used by Tools (lock_in/out) and Runtime (VisibilityMatrixMiddleware) without cross-gate coupling.
 *
 * DURABILITY + ISOLATION (CrowdOS §12 / §30): lock state is persisted per
 * WORKSPACE to a JSON file, not held in an in-process Map. The previous Map
 * was lost on restart and invisible to the bullmq worker process, so lock_in
 * silently did not apply there; a single global file filtered in memory would
 * also leak locks across workspaces that share a channel id.
 *
 * File layout: <localstore>/locks/<workspaceId>/locks.json where <localstore>
 * = resolveLocalStoreDir() — the same root as messages/, sequences.json and
 * outbox.jsonl. One file per workspace scope, so a shared channel id across
 * two workspaces can never collide. Object key format: <channelId>:<agentId>.
 * Values are { locked: true, lockedAt: ISO string }; a lock is only ever
 * written while locked and lockOut deletes the key.
 *
 * Workspace scoping: a channel's owning workspace is resolved through
 * channelGate.get(channelId).workspaceId — the same lookup Messages uses in
 * its workspaceOfChannel helper. When the workspace cannot be resolved (unknown
 * channel, dead gate, no DB) the lock falls back to the clearly-named
 * UNSCOPED_WORKSPACE ("__unscoped__") scope — documented, never a throw — so
 * enforcement still works on the local-first path where channel rows may not
 * exist yet.
 *
 * Every method is async because it touches the disk. Callers must await; the
 * middleware path awaits inside its own process(), so priority/lane behaviour
 * in context-pipeline-manager.ts is unchanged.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { mutateJsonObject, readJsonObject, resolveLocalStoreDir, withStoreLock } from "./local-file.js";

/** Lock key inside a workspace lock file: <channelId>:<agentId>. */
type LockKey = string;

interface LockRecord {
  locked: boolean;
  lockedAt: string;
}

const LOCKS_DIR = "locks";
const LOCKS_FILE = "locks.json";

/**
 * Fallback scope for locks whose channel has no resolvable workspace row.
 * Clearly named (never a real workspace id) and documented: it is the
 * local-first / pre-provisioning bucket, shared only by other unresolvable
 * channels — never merged into a real workspace's file.
 */
export const UNSCOPED_WORKSPACE = "__unscoped__";

// The workspace id is immutable after channel create, so a bounded memo is
// safe (same rule as Messages' channelWorkspaceCache). Worst case one extra
// gate read per first-seen channel per process.
const channelWorkspaceCache = new Map<string, string>();

/**
 * Resolve a channel's owning workspace via the Channels gate. Never throws:
 * an unknown channel or a failing gate resolves to UNSCOPED_WORKSPACE.
 */
async function workspaceOfChannel(channelId: string): Promise<string> {
  const hit = channelWorkspaceCache.get(channelId);
  if (hit !== undefined) return hit;
  let workspaceId: string | null = null;
  try {
    // Dynamic import keeps Shared free of a static gate edge and cycle-safe.
    const { channelGate } = await import("../../channels/channel-gate.js");
    const channel = await channelGate.get(channelId);
    workspaceId = channel?.workspaceId ?? null;
  } catch {
    workspaceId = null;
  }
  const resolved = workspaceId && workspaceId.trim() ? workspaceId : UNSCOPED_WORKSPACE;
  if (channelWorkspaceCache.size > 5000) channelWorkspaceCache.clear();
  channelWorkspaceCache.set(channelId, resolved);
  return resolved;
}

/** Scope directory name. Sanitized so an id can never escape the locks dir. */
function scopeDir(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe || "_";
}

/** Relative lock-file name for a scope, as passed to the shared file helpers. */
function locksFileName(workspaceId: string): string {
  return LOCKS_DIR + "/" + scopeDir(workspaceId) + "/" + LOCKS_FILE;
}

/** Explicit per-scope resolution for callers that already know the workspace. */
export function lockFileNameForWorkspace(workspaceId: string): string {
  return locksFileName(workspaceId);
}

/** Absolute path of a scope's lock file (diagnostics/tests). */
export function lockFilePathForWorkspace(workspaceId: string): string {
  return join(resolveLocalStoreDir(), locksFileName(workspaceId));
}

export interface AgentLockEntry {
  channelId: string;
  agentId: string;
  lockedAt: string;
}

// mutateJsonObject only mkdirs the localstore root; the per-workspace scope
// directory is this store's own concern.
async function ensureScopeDir(workspaceId: string): Promise<void> {
  await fs.mkdir(dirname(lockFilePathForWorkspace(workspaceId)), { recursive: true });
}

class AgentLockStore {
  private key(channelId: string, agentId: string): LockKey {
    return channelId + ":" + agentId;
  }

  /** Workspace scope owning this channel (falls back to UNSCOPED_WORKSPACE). */
  async scopeForChannel(channelId: string): Promise<string> {
    return workspaceOfChannel(channelId);
  }

  async lockIn(agentId: string, channelId: string): Promise<void> {
    const scope = await workspaceOfChannel(channelId);
    await ensureScopeDir(scope);
    await mutateJsonObject<LockRecord>(locksFileName(scope), (obj) => {
      obj[this.key(channelId, agentId)] = { locked: true, lockedAt: new Date().toISOString() };
    });
  }

  async lockOut(agentId: string, channelId: string): Promise<void> {
    const scope = await workspaceOfChannel(channelId);
    await ensureScopeDir(scope);
    await mutateJsonObject<LockRecord>(locksFileName(scope), (obj) => {
      delete obj[this.key(channelId, agentId)];
    });
  }

  async isLockedIn(agentId: string, channelId: string): Promise<boolean> {
    const scope = await workspaceOfChannel(channelId);
    const obj = await readJsonObject<LockRecord>(locksFileName(scope));
    return obj[this.key(channelId, agentId)]?.locked ?? false;
  }

  /** All locked channel ids for one agent inside one workspace scope. */
  async getLockedChannelsForAgent(agentId: string, workspaceId?: string): Promise<string[]> {
    const scope = workspaceId ?? UNSCOPED_WORKSPACE;
    const obj = await readJsonObject<LockRecord>(locksFileName(scope));
    const suffix = ":" + agentId;
    const out: string[] = [];
    for (const [key, record] of Object.entries(obj)) {
      if (!record?.locked) continue;
      if (!key.endsWith(suffix)) continue;
      out.push(key.slice(0, key.length - suffix.length));
    }
    return out;
  }

  /** Every lock row inside one workspace scope (diagnostics/tests). */
  async listAll(workspaceId?: string): Promise<AgentLockEntry[]> {
    const scope = workspaceId ?? UNSCOPED_WORKSPACE;
    const obj = await readJsonObject<LockRecord>(locksFileName(scope));
    const entries: AgentLockEntry[] = [];
    for (const [key, record] of Object.entries(obj)) {
      if (!record?.locked) continue;
      const sep = key.indexOf(":");
      if (sep <= 0) continue;
      entries.push({
        channelId: key.slice(0, sep),
        agentId: key.slice(sep + 1),
        lockedAt: record.lockedAt,
      });
    }
    return entries;
  }

  /**
   * Drop every lock in a workspace scope. Defaults to the unscoped scope so
   * diagnostics/tests stay total; workspace callers pass their own id so one
   * workspace's clear can never touch another's locks.
   */
  async clearAll(workspaceId?: string): Promise<void> {
    const scope = workspaceId ?? UNSCOPED_WORKSPACE;
    await ensureScopeDir(scope);
    await mutateJsonObject<LockRecord>(locksFileName(scope), (obj) => {
      for (const key of Object.keys(obj)) delete obj[key];
    });
  }

  /** Test-only: clear the in-process workspace memo so a re-read hits disk. */
  resetCacheForTests(): void {
    channelWorkspaceCache.clear();
  }

  /** Absolute path of a scope's lock file (diagnostics/tests). */
  pathForWorkspace(workspaceId: string): string {
    return lockFilePathForWorkspace(workspaceId);
  }

  /** Serialized read-modify-write escape hatch for callers needing both scopes. */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return withStoreLock("json:" + locksFileName(workspaceId), fn);
  }
}

export const agentLockStore = new AgentLockStore();


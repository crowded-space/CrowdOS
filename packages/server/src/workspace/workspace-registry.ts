// ─── Workspace Registry (Local File Persistence) ─────────────────────
// Manages workspace metadata and primary database URLs in <userData>/workspaces.json.
// Legacy per-workspace env keys remain secondary URL sources; workspace routing
// is separate from the process-wide database pool.
//
// Canon (mock-structure-polished): the global workspaces.json is the portal/hub
// index and wins for listing and startup. Every workspace also owns a
// display-name folder holding a per-folder copy of its own record
// (rootPath "."), rewritten from the global after every load and save:
//
//   <sandboxBase>/<folderName>/workspace.json
//   <sandboxBase>/<folderName>/vfs/...        <- see workspace-paths.ts

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TtlCache } from "../shared/core/ttl-cache.js";
import { invalidateWorkspacePathCaches } from "../shared/core/local-file.js";
import { parseWorkspaceDatabaseUrl, readWorkspaceDatabaseUrl } from "./workspace-database.js";
import {
  DEFAULT_ARTIFACT_DIR,
  normalizeArtifactDir,
  resolveWorkspaceFolderPath,
  sanitizeWorkspaceFolderName,
} from "./workspace-paths.js";

// ponytail: preference lookups ride the hot path (every tier decision) —
// 60s cache, invalidated on save/remove. Stale preference ≤60s is harmless
// (worst case one tier flip delay); file stays truth on every mutation.
const recordCache = new TtlCache<WorkspaceRecord | null>(60_000, 200);

/** Dual-boot storage preference. Absent = "default". */
export type StoragePreference = "default" | "local";

export type DbSyncState = "paired" | "conflict" | "importing" | "pushing";

/** DB pairing/sync state. Absent = never paired. */
export interface DbSyncInfo {
  /** Workspace id as known by the paired DB. */
  dbWorkspaceId: string | null;
  state: DbSyncState;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  icon: string;
  databaseUrl: string;
  /**
   * Display-name folder this workspace owns under the sandbox base. Absent =
   * derived from `name` (sanitized). Folder names may change on rename; the
   * `id` never does.
   */
  folderName?: string;
  /**
   * Folder-relative artifact directory. Absent = canon default "vfs/artifacts":
   * <folder>/vfs/artifacts/<runId>/<artifactId>.<ext>.
   */
  artifactDir?: string;
  /**
   * Zone A — workspace-local state (config, agent/roster ids, skills,
   * instructions, channel history, runtime state). Authority: L0 only.
   * `LocalFilesystem.initialize()` creates the workspace sectors here, so this
   * path must NEVER point at a user repository.
   */
  rootPath: string;
  /**
   * Zone B — the user's mounted repository, set from the mount picker.
   * Deliberately separate from `rootPath`: conflating the two made mounting a
   * repository write `.crowdos/` into the user's working tree, and made
   * workspace deletion `rm -rf` that repository.
   * null/absent = nothing mounted at this level (fall through to the parent).
   */
  mountPath?: string | null;
  /**
   * Per-workspace mount jail. Absent = default policy (workspace sandbox +
   * user home), so a real repository is mountable with no undocumented env var.
   * Present = this workspace accepts mounts only inside these roots.
   */
  allowedMountRoots?: string[];
  screenLockPinHash: string | null;
  storagePreference?: StoragePreference;
  dbSync?: DbSyncInfo | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  icon: string;
  screenLockEnabled: boolean;
  database: {
    configured: boolean;
    host: string;
    database: string;
    port: number | null;
  };
  storagePreference: StoragePreference;
  dbSync: DbSyncInfo | null;
  createdAt: string;
  updatedAt: string;
}

let cachedRegistryPath: string | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

export function resolveRegistryFilePath(): string {
  if (cachedRegistryPath) return cachedRegistryPath;
  const envOverride = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE?.trim();
  if (envOverride) {
    cachedRegistryPath = resolve(envOverride);
    return cachedRegistryPath;
  }
  const dataDir = process.env.CROWDOS_DATA_DIR?.trim() || process.env.WORKSPACE_DIR?.trim();
  if (dataDir) {
    cachedRegistryPath = resolve(dataDir, "workspaces.json");
    return cachedRegistryPath;
  }
  cachedRegistryPath = resolve(process.cwd(), "sandbox", "workspaces.json");
  return cachedRegistryPath;
}

/**
 * Zone A base directory — where workspace-local state lives.
 *
 * Single source for the `WORKSPACE_DIR`-or-`<cwd>/sandbox` decision. It used to
 * be re-derived in the workspace route, the mount jail, and the tool guard, so
 * the three could disagree about which directory was "the sandbox".
 */
export function resolveSandboxBase(): string {
  const configured = process.env.WORKSPACE_DIR?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), "sandbox");
}

/**
 * Display-name folder for a record: explicit `folderName`, else the sanitized
 * `name`, else the id. Pure — no I/O, so path resolution stays cheap.
 */
export function resolveRecordFolderName(record: Pick<WorkspaceRecord, "id" | "name" | "folderName">): string {
  const explicit = record.folderName?.trim();
  if (explicit) return sanitizeWorkspaceFolderName(explicit);
  return sanitizeWorkspaceFolderName(record.name) || record.id;
}

/** Folder-relative artifact dir for a record, canon-normalized. */
export function resolveRecordArtifactDir(record?: Pick<WorkspaceRecord, "artifactDir"> | null): string {
  return normalizeArtifactDir(record?.artifactDir ?? DEFAULT_ARTIFACT_DIR);
}

/**
 * Zone A root for one workspace: its registry `rootPath` when it has one, else
 * `<sandboxBase>/<folderName>` (display name, not the id). Never a mount target
 * — `LocalFilesystem.initialize()` creates the workspace sectors here.
 */
export async function resolveWorkspaceLocalRoot(workspaceId?: string | null): Promise<string> {
  const sandboxBase = resolveSandboxBase();
  if (!workspaceId) return sandboxBase;
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  const rootPath = record?.rootPath?.trim();
  if (rootPath) return resolve(rootPath);
  if (record) return resolveWorkspaceFolderPath(sandboxBase, resolveRecordFolderName(record));
  return join(sandboxBase, workspaceId);
}

/** Absolute folder a record owns (its `rootPath` when set, else derived). */
export async function resolveWorkspaceFolder(workspaceId?: string | null): Promise<string | null> {
  if (!workspaceId) return null;
  const record = await getWorkspaceRecord(workspaceId).catch(() => null);
  if (!record) return null;
  const rootPath = record.rootPath?.trim();
  if (rootPath) return resolve(rootPath);
  return resolveWorkspaceFolderPath(resolveSandboxBase(), resolveRecordFolderName(record));
}

/**
 * Rewrite a workspace's per-folder `workspace.json` copy.
 *
 * The global index is truth; this copy exists so the folder is self-contained
 * and browsable. `rootPath` is stored as "." because the file lives in the
 * folder it describes. Best-effort: a stalled filesystem must not fail a
 * registry write, because the global index already holds the record.
 */
export async function writeWorkspaceFolderCopy(record: WorkspaceRecord): Promise<void> {
  try {
    const folder = record.rootPath?.trim()
      ? resolve(record.rootPath)
      : resolveWorkspaceFolderPath(resolveSandboxBase(), resolveRecordFolderName(record));
    const copy: Record<string, unknown> = {
      ...record,
      folderName: resolveRecordFolderName(record),
      artifactDir: resolveRecordArtifactDir(record),
      rootPath: ".",
    };
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(join(folder, "workspace.json"), JSON.stringify(copy, null, 2), "utf8");
  } catch {
    // best-effort mirror; the global index remains truth
  }
}

export function setRegistryFilePathForTests(filePath: string | null): void {
  cachedRegistryPath = filePath ? resolve(filePath) : null;
  recordCache.clear();
}

export function sanitizeWorkspaceRecord(record: WorkspaceRecord): WorkspaceDescriptor {
  let dbDesc = { configured: false, host: "", database: "", port: null as number | null };
  try {
    const parsed = parseWorkspaceDatabaseUrl(record.databaseUrl);
    dbDesc = {
      configured: true,
      host: parsed.host,
      database: parsed.database,
      port: parsed.port,
    };
  } catch {}

  return {
    id: record.id,
    name: record.name,
    icon: record.icon,
    screenLockEnabled: typeof record.screenLockPinHash === "string" && record.screenLockPinHash.length > 0,
    database: dbDesc,
    storagePreference: record.storagePreference === "local" ? "local" : "default",
    dbSync: record.dbSync ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readAllRaw(): Promise<WorkspaceRecord[]> {
  const filePath = resolveRegistryFilePath();
  try {
    const data = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed as WorkspaceRecord[];
    if (parsed && Array.isArray(parsed.workspaces)) return parsed.workspaces as WorkspaceRecord[];
    return [];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    // WS-005: a corrupt registry must not read as empty (locks disabled,
    // records vanish). Surface the parse failure so callers fail closed
    // instead of operating on a phantom-empty workspace list.
    throw new Error(`Workspace registry at ${filePath} is unreadable: ${(err as Error)?.message ?? err}`);
  }
}

async function writeAllRaw(records: WorkspaceRecord[]): Promise<void> {
  const filePath = resolveRegistryFilePath();
  await fs.mkdir(dirname(filePath), { recursive: true });
  const payload = JSON.stringify({ workspaces: records }, null, 2);
  await fs.writeFile(filePath, payload, "utf8");
}

export async function listWorkspaceRecords(): Promise<WorkspaceRecord[]> {
  return readAllRaw();
}

export async function listWorkspaces(): Promise<WorkspaceDescriptor[]> {
  const records = await readAllRaw();
  return records.map(sanitizeWorkspaceRecord);
}

export async function getWorkspaceRecord(id: string): Promise<WorkspaceRecord | null> {
  const cached = recordCache.get(id);
  if (cached !== undefined) return cached;
  const records = await readAllRaw();
  const match = records.find((w) => w.id === id) || null;
  recordCache.set(id, match);
  return match;
}

export async function getWorkspaceDescriptor(id: string): Promise<WorkspaceDescriptor | null> {
  const record = await getWorkspaceRecord(id);
  return record ? sanitizeWorkspaceRecord(record) : null;
}

/**
 * Build a dual-boot TierContext using the same workspace URL precedence as
 * getWorkspaceDb: registry record first, then the matching per-workspace env
 * key. The process-wide DATABASE_URL is not a tenant URL.
 */
export async function tierContextFor(
  workspaceId?: string | null,
): Promise<{ workspaceId: string | null; databaseUrl?: string | null; storagePreference?: string | null }> {
  if (!workspaceId) return { workspaceId: null };
  const rec = await getWorkspaceRecord(workspaceId).catch(() => null);
  const databaseUrl = rec?.databaseUrl?.trim() || (await readWorkspaceDatabaseUrl(workspaceId))?.trim() || null;
  if (!rec) return { workspaceId, databaseUrl };
  // WS-004: conflict quarantine. A record whose dbSync state is conflict is
  // attached to an unrelated database — resolve local-only so dualWrite and
  // withStoreFallback never push rows into the wrong DB. (Was: only
  // drainOutbox checked the flag; writes continued.)
  if (rec.dbSync?.state === "conflict") {
    return { workspaceId, storagePreference: "local" };
  }
  return {
    workspaceId,
    databaseUrl,
    storagePreference: rec.storagePreference === "local" ? "local" : "default",
  };
}

export async function saveWorkspaceRecord(record: WorkspaceRecord): Promise<WorkspaceDescriptor> {
  const saved = await withLock(async () => {
    const records = await readAllRaw();
    const normalized: WorkspaceRecord = {
      ...record,
      folderName: resolveRecordFolderName(record),
      artifactDir: resolveRecordArtifactDir(record),
    };
    const existingIndex = records.findIndex((w) => w.id === normalized.id);
    let stored: WorkspaceRecord;
    if (existingIndex >= 0) {
      stored = { ...normalized, updatedAt: new Date().toISOString() };
      records[existingIndex] = stored;
    } else {
      stored = normalized;
      records.push(stored);
    }
    await writeAllRaw(records);
    recordCache.delete(normalized.id);
    // A new/changed record can change which folder a workspace resolves to,
    // so the local-store path caches must not serve the previous answer.
    invalidateWorkspacePathCaches();
    // Canon: keep the folder copy in step with the global index.
    await writeWorkspaceFolderCopy(stored);
    return stored;
  });
  return sanitizeWorkspaceRecord(saved);
}

export async function removeWorkspaceRecord(id: string): Promise<boolean> {
  return withLock(async () => {
    const records = await readAllRaw();
    const initialLen = records.length;
    const filtered = records.filter((w) => w.id !== id);
    if (filtered.length === initialLen) return false;
    await writeAllRaw(filtered);
    recordCache.delete(id);
    invalidateWorkspacePathCaches();
    return true;
  });
}

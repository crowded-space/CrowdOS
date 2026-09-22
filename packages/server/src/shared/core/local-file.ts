// ─── Local File Store IO (C3 local-first) ─────────────────────────────
// Shared, gate-exempt file helpers behind the domain local stores.
//
// Canon (mock-structure-polished): there is no global localstore. Every
// workspace owns its own files inside its display-name folder:
//
//   <workspaceFolder>/vfs/.crowdos/categories.json     ONLY place for categories
//   <workspaceFolder>/vfs/.crowdos/channels.json       ONLY place for channels
//   <workspaceFolder>/vfs/.crowdos/channel-settings.json
//   <workspaceFolder>/vfs/.crowdos/messages/<channelId>.jsonl
//   <workspaceFolder>/vfs/.crowdos/events/<channelId>.jsonl
//   <workspaceFolder>/vfs/.crowdos/{sequences,event-sequences,capabilities}.json
//   <workspaceFolder>/vfs/.crowdos/memories/<agentId>.jsonl
//   <workspaceFolder>/vfs/.crowdos/skills/<slug>.md
//   <workspaceFolder>/vfs/agents/<agentId>.json        one file per agent
//   <workspaceFolder>/vfs/artifacts/                   plain files, no index
//
// `vfs/` is a local config sandbox: never a mount target for user repositories.
// ponytail: single-process mutex via per-file promise chains (same shape as
// workspace-registry withLock). Multi-process writers (api+worker) need PG;
// local mode is inline single-process (desktop default).

import { existsSync, promises as fs, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TtlCache } from "./ttl-cache.js";

/** Scope used when a caller has no workspace id (legacy rows, "?? default"). */
export const DEFAULT_WORKSPACE_SCOPE = "default";

let testDirOverride: string | null = null;

/**
 * Test-only override for the SANDBOX BASE. The canon layout is then derived
 * per workspace exactly as in production — \`<base>/<workspaceId>/vfs/...\` —
 * so a test that scopes two workspaces gets two real folders instead of one
 * shared directory. That is what makes §30 isolation testable.
 */
export function setLocalStoreDirForTests(dir: string | null): void {
  testDirOverride = dir ? resolve(dir) : null;
  folderCache.clear();
}

/** Canon dirs for one workspace under the test base (or the real sandbox). */
export function localStoreDirsForTests(workspaceId?: string | null): {
  workspaceFolder: string;
  crowdos: string;
  agents: string;
  artifacts: string;
} {
  const folder = testDirOverride
    ? join(testDirOverride, workspaceId ?? DEFAULT_WORKSPACE_SCOPE)
    : resolveWorkspaceFolderSync(workspaceId);
  return {
    workspaceFolder: folder,
    crowdos: join(folder, "vfs", ".crowdos"),
    agents: join(folder, "vfs", "agents"),
    artifacts: join(folder, "vfs", "artifacts"),
  };
}

// ─── Folder resolution (sync, cached) ────────────────────────────────
// The registry file is tiny and local mode is single-process, so a short sync
// read keeps every store's path resolution synchronous (the previous API was
// sync and dozens of call sites depend on that).

const folderCache = new TtlCache<string | null>(2_000, 500);

/**
 * Drop the cached folder/scope resolution. The Workspace domain calls this on
 * create, rename, and delete so a brand-new workspace folder is visible to the
 * very next local-store lookup instead of waiting out the TTL.
 */
export function invalidateWorkspacePathCaches(): void {
  folderCache.clear();
}

function registryFilePath(): string {
  const envOverride = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE?.trim();
  if (envOverride) return resolve(envOverride);
  const dataDir = process.env.CROWDOS_DATA_DIR?.trim() || process.env.WORKSPACE_DIR?.trim();
  if (dataDir) return resolve(dataDir, "workspaces.json");
  return resolve(process.cwd(), "sandbox", "workspaces.json");
}

function sandboxBase(): string {
  const configured = process.env.WORKSPACE_DIR?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), "sandbox");
}

interface RegistryRowLike {
  id?: string;
  name?: string;
  folderName?: string;
  rootPath?: string;
}

/** Sync read of the global index (missing/corrupt reads as []). */
function readRegistryRows(): RegistryRowLike[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFilePath(), "utf8"));
    if (Array.isArray(parsed)) return parsed as RegistryRowLike[];
    if (parsed && Array.isArray(parsed.workspaces)) return parsed.workspaces as RegistryRowLike[];
    return [];
  } catch {
    return [];
  }
}

function sanitizeFolderName(name: string): string {
  const trimmed = (name ?? "").trim() || DEFAULT_WORKSPACE_SCOPE;
  let out = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  out = out.replace(/[. ]+$/g, "").trim();
  if (!out) out = DEFAULT_WORKSPACE_SCOPE;
  if (out.toLowerCase() === "workspaces.json") out = DEFAULT_WORKSPACE_SCOPE;
  return out;
}

/**
 * Absolute workspace folder for an id: its registry `rootPath`, else
 * `<sandboxBase>/<folderName>`. Unknown/absent ids fall back to a
 * `default` scope folder so legacy unscoped rows still have a home.
 */
export function resolveWorkspaceFolderSync(workspaceId?: string | null): string {
  if (testDirOverride) return join(testDirOverride, workspaceId ?? DEFAULT_WORKSPACE_SCOPE);
  const id = workspaceId && workspaceId.trim() ? workspaceId.trim() : null;
  const cacheKey = id ?? DEFAULT_WORKSPACE_SCOPE;
  const cached = folderCache.get(cacheKey);
  if (cached !== undefined && cached !== null) return cached;
  const rows = readRegistryRows();
  const row = id ? rows.find((r) => r.id === id) : undefined;
  let folder: string;
  if (row?.rootPath?.trim()) {
    const rootPath = row.rootPath.trim();
    folder = rootPath === "." ? join(sandboxBase(), sanitizeFolderName(row.folderName ?? row.name ?? "")) : resolve(rootPath);
  } else if (row) {
    folder = join(sandboxBase(), sanitizeFolderName(row.folderName ?? row.name ?? DEFAULT_WORKSPACE_SCOPE));
  } else {
    folder = join(sandboxBase(), id ?? DEFAULT_WORKSPACE_SCOPE);
  }
  folderCache.set(cacheKey, folder);
  return folder;
}

/** Canon runtime store dir for a workspace: <folder>/vfs/.crowdos. */
export function resolveLocalStoreDir(workspaceId?: string | null): string {
  // Documented outright override: point the whole store at one directory
  // (dev/CI escape hatch, and what the lock-store restart test relies on).
  // Wins over the canon layout so a caller can isolate a store completely.
  const outright = process.env.CROWDOS_LOCALSTORE_DIR?.trim();
  if (outright && !testDirOverride) return resolve(outright);
  return join(resolveWorkspaceFolderSync(workspaceId), "vfs", ".crowdos");
}

/** Canon agent dir for a workspace: <folder>/vfs/agents. */
export function resolveWorkspaceAgentsDir(workspaceId?: string | null): string {
  return join(resolveWorkspaceFolderSync(workspaceId), "vfs", "agents");
}

/** Canon artifact dir for a workspace: <folder>/vfs/artifacts. */
export function resolveWorkspaceArtifactsDir(workspaceId?: string | null): string {
  return join(resolveWorkspaceFolderSync(workspaceId), "vfs", "artifacts");
}

/** Every workspace id in the global index (for cross-workspace enumeration). */
export function listWorkspaceIds(): string[] {
  return readRegistryRows()
    .map((r) => (typeof r.id === "string" ? r.id : ""))
    .filter((id) => id.length > 0);
}

/**
 * Scopes to search when a caller has no workspace id: every registered
 * workspace, or the bare \`default\` scope when the index is empty (legacy
 * unscoped rows). Used by the get-by-id lookups that predate per-workspace
 * files — a row can live in any workspace, so they search them all.
 */
export function searchableWorkspaceScopes(): string[] {
  return candidateWorkspaceScopes();
}

/**
 * Every scope a lookup may need to visit, in priority order:
 *   1. ids in the global index (the portal/hub truth),
 *   2. workspace folders that exist on disk under the sandbox base,
 *   3. the documented \`default\` placeholder.
 *
 * (2) is what keeps an unscoped lookup honest after an index reset or in a test
 * that created folders without registering them: the folder IS the workspace.
 */
export function candidateWorkspaceScopes(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of listWorkspaceIds()) push(id);
  try {
    const base = testDirOverride ?? sandboxBase();
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      // Only a folder that actually holds the canon layout is a workspace;
      // anything else under the base (a stray dir, a sibling store) is not a
      // scope and must never be searched as one.
      const looksLikeWorkspace =
        existsSync(join(base, entry.name, "vfs")) || existsSync(join(base, entry.name, "workspace.json"));
      if (looksLikeWorkspace) push(entry.name);
    }
  } catch {
    // unreadable sandbox base: registry ids + default are still valid scopes
  }
  push(DEFAULT_WORKSPACE_SCOPE);
  return out;
 }

/**
 * Which workspace owns a channel. A channel belongs to exactly one workspace,
 * and its row lives in that workspace's channels.json, so the owner is found by
 * enumerating workspaces. Returns null when no workspace claims it.
 */
export async function resolveWorkspaceIdForChannel(channelId: string): Promise<string | null> {
  for (const id of candidateWorkspaceScopes()) {
    const rows = await readJsonArray<{ id?: string }>("channels.json", id).catch(() => []);
    if (rows.some((r) => r.id === channelId)) return id;
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which workspace owns a channel's per-channel log (messages/ or events/).
 *
 * The row lookup above needs a channels.json; this needs only the log file
 * itself, so it still resolves after the channel row is gone and for callers
 * that only ever had a channel id (the replay endpoint, agent context).
 */
export async function findWorkspaceIdForChannelLog(
  dirName: string,
  channelId: string,
): Promise<string | null> {
  const safe = channelId.replace(/[^A-Za-z0-9_-]/g, "_");
  for (const id of candidateWorkspaceScopes()) {
    const candidate = join(resolveLocalStoreDir(id), dirName, safe + ".jsonl");
    if (await fileExists(candidate)) return id;
  }
  return null;
}

const chains = new Map<string, Promise<unknown>>();

function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/** Public mutex for file-level read-modify-write outside the JSON helpers. */
export function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(key, fn);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

// ─── Path-addressed primitives (agents, enumeration, tests) ───────────

/** Read a JSON file by absolute path; missing/corrupt reads as null. */
export async function readJsonFile<T>(absolutePath: string): Promise<T | null> {
  const raw = await readText(absolutePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Locked write of a JSON file by absolute path (mkdir -p first). */
export async function writeJsonFile(absolutePath: string, value: unknown): Promise<void> {
  await withFileLock(`file:${absolutePath}`, async () => {
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, JSON.stringify(value, null, 2), "utf8");
  });
}

/** Locked delete of a file by absolute path; missing is a no-op. */
export async function deleteFile(absolutePath: string): Promise<void> {
  await withFileLock(`file:${absolutePath}`, async () => {
    try {
      await fs.unlink(absolutePath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  });
}

/** List `*.json` file names in a directory; missing dir reads as []. */
export async function listJsonFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

// ─── Workspace-scoped JSON helpers ───────────────────────────────────

/** Read a JSON array file; missing/corrupt reads as [] (registry parity). */
export async function readJsonArray<T>(name: string, workspaceId?: string | null): Promise<T[]> {
  const raw = await readText(join(resolveLocalStoreDir(workspaceId), name));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Locked read-modify-write over a workspace's JSON array file. */
export async function mutateJsonArray<T>(
  name: string,
  fn: (rows: T[]) => T[] | void,
  workspaceId?: string | null,
): Promise<T[]> {
  return withFileLock(`json:${workspaceId ?? DEFAULT_WORKSPACE_SCOPE}:${name}`, async () => {
    const dir = resolveLocalStoreDir(workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const rows = await readJsonArray<T>(name, workspaceId);
    const next = fn(rows) ?? rows;
    await fs.writeFile(join(dir, name), JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

/** Read a JSON object file; missing/corrupt reads as {}. */
export async function readJsonObject<V>(name: string, workspaceId?: string | null): Promise<Record<string, V>> {
  const raw = await readText(join(resolveLocalStoreDir(workspaceId), name));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, V>)
      : {};
  } catch {
    return {};
  }
}

/** Locked read-modify-write over a workspace's JSON object file. */
export async function mutateJsonObject<V>(
  name: string,
  fn: (obj: Record<string, V>) => Record<string, V> | void,
  workspaceId?: string | null,
): Promise<Record<string, V>> {
  return withFileLock(`json:${workspaceId ?? DEFAULT_WORKSPACE_SCOPE}:${name}`, async () => {
    const dir = resolveLocalStoreDir(workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const obj = await readJsonObject<V>(name, workspaceId);
    const next = fn(obj) ?? obj;
    await fs.writeFile(join(dir, name), JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

// ─── Workspace-scoped JSONL helpers ──────────────────────────────────

/** Channel-id → file-name stem. Shared by every per-channel JSONL log. */
function safeChannelFileId(channelId: string): string {
  return channelId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Append one JSON line to <dirName>/<channelId>.jsonl (locked per file).
 *
 * `repairTornTail` (opt-in, used by the §29 event log): if the file's last byte
 * is not a newline, the previous append died mid-write. Without a separator the
 * next line would be glued onto the fragment and BOTH records would be lost to
 * the reader. Writing the missing newline first keeps one line per record — the
 * torn line is skipped by the reader, and everything appended after it survives.
 */
async function appendJsonlLine(
  dirName: string,
  channelId: string,
  row: Record<string, unknown>,
  opts: { repairTornTail?: boolean; workspaceId?: string | null } = {},
): Promise<void> {
  const safe = safeChannelFileId(channelId);
  const scope = opts.workspaceId ?? DEFAULT_WORKSPACE_SCOPE;
  await withFileLock(`jsonl:${scope}:${dirName}:${safe}`, async () => {
    const dir = join(resolveLocalStoreDir(opts.workspaceId), dirName);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${safe}.jsonl`);
    if (opts.repairTornTail) await terminateTornTail(file);
    await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  });
}

/** Append a closing newline when the file ends mid-line. No-op when clean. */
async function terminateTornTail(file: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, "r+");
    const { size } = await handle.stat();
    if (size === 0) return;
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, size - 1);
    if (lastByte[0] !== 0x0a) await handle.write("\n", size);
  } catch (err: any) {
    if (err?.code === "ENOENT") return; // nothing to repair yet
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Read all JSON lines for a channel; missing file reads as []. */
async function readJsonlLines(
  dirName: string,
  channelId: string,
  workspaceId?: string | null,
): Promise<Array<Record<string, unknown>>> {
  const safe = safeChannelFileId(channelId);
  const raw = await readText(join(resolveLocalStoreDir(workspaceId), dirName, `${safe}.jsonl`));
  if (!raw) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      // skip torn trailing line
    }
  }
  return rows;
}

/** Append one JSON line to messages/<channelId>.jsonl (locked). */
export async function appendJsonl(
  channelId: string,
  row: Record<string, unknown>,
  workspaceId?: string | null,
): Promise<void> {
  return appendJsonlLine("messages", channelId, row, { workspaceId });
}

/** Read all JSON lines for a channel; missing file reads as []. */
export async function readJsonl(
  channelId: string,
  workspaceId?: string | null,
): Promise<Array<Record<string, unknown>>> {
  return readJsonlLines("messages", channelId, workspaceId);
}

/**
 * §29 local event log: append one JSON line to events/<channelId>.jsonl.
 * Same append-only + torn-tail-tolerant rules as the message log; the mutex is
 * per file (`jsonl:<ws>:events:<id>`), so event and message appends never block
 * each other for the same channel.
 */
export async function appendEventJsonl(
  channelId: string,
  row: Record<string, unknown>,
  workspaceId?: string | null,
): Promise<void> {
  return appendJsonlLine("events", channelId, row, { repairTornTail: true, workspaceId });
}

/** Read all event-log lines for a channel; missing file reads as []. */
export async function readEventJsonl(
  channelId: string,
  workspaceId?: string | null,
): Promise<Array<Record<string, unknown>>> {
  return readJsonlLines("events", channelId, workspaceId);
}

// ─── Local File Store IO (C3 local-first) ─────────────────────────────
// Shared, gate-exempt file helpers behind the domain local stores.
// Layout mirrors workspace-registry.ts path resolution:
//   <registryDir>/localstore/*.json + messages/<channelId>.jsonl
// where registryDir = dirname(workspaces.json).
// ponytail: single-process mutex via per-file promise chains (same shape
// as workspace-registry withLock). Multi-process writers (api+worker) need
// PG; local mode is inline single-process (desktop default).

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

let testDirOverride: string | null = null;

/** Test-only outright override for the localstore dir. */
export function setLocalStoreDirForTests(dir: string | null): void {
  testDirOverride = dir ? resolve(dir) : null;
}

function resolveRegistryFilePath(): string {
  const envOverride = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE?.trim();
  if (envOverride) return resolve(envOverride);
  const dataDir = process.env.CROWDOS_DATA_DIR?.trim() || process.env.WORKSPACE_DIR?.trim();
  if (dataDir) return resolve(dataDir, "workspaces.json");
  return resolve(process.cwd(), "sandbox", "workspaces.json");
}

export function resolveLocalStoreDir(): string {
  if (testDirOverride) return testDirOverride;
  const outright = process.env.CROWDOS_LOCALSTORE_DIR?.trim();
  if (outright) return resolve(outright);
  return join(dirname(resolveRegistryFilePath()), "localstore");
}

const chains = new Map<string, Promise<unknown>>();

function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Read a JSON array file; missing/corrupt reads as [] (registry parity). */
export async function readJsonArray<T>(name: string): Promise<T[]> {
  const raw = await readText(join(resolveLocalStoreDir(), name));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Locked read-modify-write over a JSON array file. */
export async function mutateJsonArray<T>(name: string, fn: (rows: T[]) => T[] | void): Promise<T[]> {
  return withFileLock(`json:${name}`, async () => {
    const dir = resolveLocalStoreDir();
    await fs.mkdir(dir, { recursive: true });
    const rows = await readJsonArray<T>(name);
    const next = fn(rows) ?? rows;
    await fs.writeFile(join(dir, name), JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

/** Read a JSON object file; missing/corrupt reads as {}. */
export async function readJsonObject<V>(name: string): Promise<Record<string, V>> {
  const raw = await readText(join(resolveLocalStoreDir(), name));
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

/** Locked read-modify-write over a JSON object file. */
export async function mutateJsonObject<V>(
  name: string,
  fn: (obj: Record<string, V>) => Record<string, V> | void,
): Promise<Record<string, V>> {
  return withFileLock(`json:${name}`, async () => {
    const dir = resolveLocalStoreDir();
    await fs.mkdir(dir, { recursive: true });
    const obj = await readJsonObject<V>(name);
    const next = fn(obj) ?? obj;
    await fs.writeFile(join(dir, name), JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

/** Append one JSON line to messages/<channelId>.jsonl (locked). */
export async function appendJsonl(channelId: string, row: Record<string, unknown>): Promise<void> {
  const safe = channelId.replace(/[^A-Za-z0-9_-]/g, "_");
  await withFileLock(`jsonl:${safe}`, async () => {
    const dir = join(resolveLocalStoreDir(), "messages");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(join(dir, `${safe}.jsonl`), JSON.stringify(row) + "\n", "utf8");
  });
}

/** Read all JSON lines for a channel; missing file reads as []. */
export async function readJsonl(channelId: string): Promise<Array<Record<string, unknown>>> {
  const safe = channelId.replace(/[^A-Za-z0-9_-]/g, "_");
  const raw = await readText(join(resolveLocalStoreDir(), "messages", `${safe}.jsonl`));
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

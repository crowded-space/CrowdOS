// ─── Local File Store IO (C3 local-first) ─────────────────────────────
// Shared, gate-exempt file helpers behind the domain local stores.
// Layout mirrors workspace-registry.ts path resolution:
//   <registryDir>/localstore/*.json + messages/<channelId>.jsonl
//                                    + events/<channelId>.jsonl (§29 log)
// where registryDir = dirname(workspaces.json).
// ponytail: single-process mutex via per-file promise chains (same shape
// as workspace-registry withLock). Multi-process writers (api+worker) need
// PG; local mode is inline single-process (desktop default).

import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

let vitestFallbackDir: string | null = null;

export function resolveLocalStoreDir(): string {
  if (testDirOverride) return testDirOverride;
  const outright = process.env.CROWDOS_LOCALSTORE_DIR?.trim();
  if (outright) return resolve(outright);
  // Test hygiene: unit tests must never read/write the developer's real
  // localstore (dual-write mirrors + union reads would leak across suites).
  // Explicit per-test dirs (setLocalStoreDirForTests) still win.
  if (process.env.VITEST && !vitestFallbackDir) {
    vitestFallbackDir = mkdtempSync(join(tmpdir(), "crowdos-test-store-"));
  }
  if (vitestFallbackDir) return vitestFallbackDir;
  return join(dirname(resolveRegistryFilePath()), "localstore");
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
  opts: { repairTornTail?: boolean } = {},
): Promise<void> {
  const safe = safeChannelFileId(channelId);
  await withFileLock(`jsonl:${dirName}:${safe}`, async () => {
    const dir = join(resolveLocalStoreDir(), dirName);
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
): Promise<Array<Record<string, unknown>>> {
  const safe = safeChannelFileId(channelId);
  const raw = await readText(join(resolveLocalStoreDir(), dirName, `${safe}.jsonl`));
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
export async function appendJsonl(channelId: string, row: Record<string, unknown>): Promise<void> {
  return appendJsonlLine("messages", channelId, row);
}

/** Read all JSON lines for a channel; missing file reads as []. */
export async function readJsonl(channelId: string): Promise<Array<Record<string, unknown>>> {
  return readJsonlLines("messages", channelId);
}

/**
 * §29 local event log: append one JSON line to events/<channelId>.jsonl.
 * Same append-only + torn-tail-tolerant rules as the message log; the mutex is
 * per file (`jsonl:events:<id>`), so event and message appends never block each
 * other for the same channel.
 */
export async function appendEventJsonl(channelId: string, row: Record<string, unknown>): Promise<void> {
  return appendJsonlLine("events", channelId, row, { repairTornTail: true });
}

/** Read all event-log lines for a channel; missing file reads as []. */
export async function readEventJsonl(channelId: string): Promise<Array<Record<string, unknown>>> {
  return readJsonlLines("events", channelId);
}

// ─── Workspace Registry (Local File Persistence) ─────────────────────
// Manages workspace metadata and database credentials in <userData>/workspaces.json.
// Decouples workspace definitions completely from .env and the global database.

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseWorkspaceDatabaseUrl } from "./workspace-database.js";

export interface WorkspaceRecord {
  id: string;
  name: string;
  icon: string;
  databaseUrl: string;
  rootPath: string;
  screenLockPinHash: string | null;
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

export function setRegistryFilePathForTests(filePath: string | null): void {
  cachedRegistryPath = filePath ? resolve(filePath) : null;
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
    return [];
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
  const records = await readAllRaw();
  const match = records.find((w) => w.id === id);
  return match || null;
}

export async function getWorkspaceDescriptor(id: string): Promise<WorkspaceDescriptor | null> {
  const record = await getWorkspaceRecord(id);
  return record ? sanitizeWorkspaceRecord(record) : null;
}

export async function saveWorkspaceRecord(record: WorkspaceRecord): Promise<WorkspaceDescriptor> {
  return withLock(async () => {
    const records = await readAllRaw();
    const existingIndex = records.findIndex((w) => w.id === record.id);
    if (existingIndex >= 0) {
      records[existingIndex] = { ...record, updatedAt: new Date().toISOString() };
    } else {
      records.push(record);
    }
    await writeAllRaw(records);
    return sanitizeWorkspaceRecord(record);
  });
}

export async function removeWorkspaceRecord(id: string): Promise<boolean> {
  return withLock(async () => {
    const records = await readAllRaw();
    const initialLen = records.length;
    const filtered = records.filter((w) => w.id !== id);
    if (filtered.length === initialLen) return false;
    await writeAllRaw(filtered);
    return true;
  });
}

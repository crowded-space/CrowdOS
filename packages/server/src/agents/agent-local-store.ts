// ─── Agent Local Store (C3 local-first) ─────────────────────────────────
// File truth for the agent roster when no DATABASE_URL is configured.
//
// Canon (mock-structure-polished): one file per agent, one object per file,
// filename matches the id:
//
//   <workspaceFolder>/vfs/agents/<agentId>.json
//
// Enumeration (list) reads the directory; get-by-id reads one file. There is no
// index file — the directory IS the roster. A workspace id scopes the read;
// without one, every registered workspace is searched, because a roster lookup
// by id has no other way to know which folder owns the agent.
//
// Module references are stored but never validated locally (spec 05 owns the
// module catalog; local mode runs the default provider config).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_SCOPE,
  deleteFile,
  listJsonFileNames,
  readJsonFile,
  searchableWorkspaceScopes,
  resolveWorkspaceAgentsDir,
  writeJsonFile,
  withStoreLock,
} from "../shared/core/local-file.js";

export interface LocalAgentRow {
  id: string;
  workspaceId?: string | null;
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: number;
  l3Subtype?: string;
  modelModuleId: string | null;
  instructionModuleId: string;
  toolkitModuleId?: string;
  constraintsModuleId?: string;
  capabilitiesModuleId?: string;
  memorySharingPolicy: string;
  isOmniscient: boolean;
  fallbackAgentId?: string;
  categoryPermissions: string[];
  permissions: { spawnAgents: boolean; patchRuntime: boolean; accessAllChannels: boolean };
  status: string;
  isTemplate: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  contextTokenCap?: number | null;
  createdAt: string;
  updatedAt: string;
}

function revive(row: LocalAgentRow): any {
  return {
    ...row,
    species: row.species ?? undefined,
    avatar: row.avatar ?? undefined,
    l3Subtype: row.l3Subtype ?? undefined,
    toolkitModuleId: row.toolkitModuleId ?? undefined,
    constraintsModuleId: row.constraintsModuleId ?? undefined,
    capabilitiesModuleId: row.capabilitiesModuleId ?? undefined,
    fallbackAgentId: row.fallbackAgentId ?? undefined,
    contextTokenCap: row.contextTokenCap ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
  };
}

/** Agent-id → file-name stem. Mirrors the channel-log rule. */
function safeAgentFileId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function agentFilePath(workspaceId: string | null | undefined, agentId: string): string {
  return join(resolveWorkspaceAgentsDir(workspaceId), `${safeAgentFileId(agentId)}.json`);
}

/** Every workspace folder a lookup should search when no scope was given. */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  return workspaceId && workspaceId.trim() ? [workspaceId] : searchableWorkspaceScopes();
}

/** Roster rows for one scope, read from that scope's vfs/agents dir. */
async function readScope(workspaceId: string | null): Promise<LocalAgentRow[]> {
  const dir = resolveWorkspaceAgentsDir(workspaceId);
  const names = await listJsonFileNames(dir);
  const rows: LocalAgentRow[] = [];
  for (const name of names) {
    const row = await readJsonFile<LocalAgentRow>(join(dir, name));
    if (row && typeof row.id === "string" && row.id.trim()) rows.push(row);
  }
  return rows;
}

/**
 * Raw (non-revived) roster rows for one workspace — the sync/pairing path.
 * Dates stay ISO strings because the rows are written straight to PG, where
 * the driver owns timestamp parsing.
 */
export async function localListAgentRows(workspaceId?: string | null): Promise<LocalAgentRow[]> {
  const scopes = scopesFor(workspaceId);
  const perScope = await Promise.all(scopes.map((scope) => readScope(scope).catch(() => [] as LocalAgentRow[])));
  const byId = new Map<string, LocalAgentRow>();
  for (const rows of perScope) {
    for (const row of rows) {
      if (workspaceId && row.workspaceId && row.workspaceId !== workspaceId) continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

export async function localListAgents(filters?: {
  workspaceId?: string | null;
  authorityLevel?: number;
  status?: string;
  isTemplate?: boolean;
  limit?: number;
  cursor?: string | null;
}): Promise<any[]> {
  const scopes = scopesFor(filters?.workspaceId);
  const perScope = await Promise.all(scopes.map((scope) => readScope(scope).catch(() => [] as LocalAgentRow[])));
  const byId = new Map<string, LocalAgentRow>();
  for (const rows of perScope) {
    for (const row of rows) {
      // Isolation: a scoped row is visible only in its own workspace; legacy
      // rows without a workspaceId stay visible everywhere until backfilled.
      if (filters?.workspaceId && row.workspaceId && row.workspaceId !== filters.workspaceId) continue;
      byId.set(row.id, row);
    }
  }
  let list = [...byId.values()].filter((r) => r.archivedAt === null);
  if (filters?.authorityLevel !== undefined) list = list.filter((r) => r.authorityLevel === filters.authorityLevel);
  if (filters?.status !== undefined) list = list.filter((r) => r.status === filters.status);
  if (filters?.isTemplate !== undefined) list = list.filter((r) => r.isTemplate === filters.isTemplate);
  list = list.slice().sort((a, b) => a.authorityLevel - b.authorityLevel || (a.name < b.name ? -1 : 1));
  const limit = filters?.limit != null ? Math.min(200, Math.max(1, filters.limit)) : 200;
  let offset = 0;
  if (filters?.cursor) {
    const parsed = Number(filters.cursor);
    if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
  }
  return list.slice(offset, offset + limit).map(revive);
}

/**
 * Read one agent by id. When a scope is known the read is a single file; else
 * every registered workspace is probed (the id is the only key the caller has).
 */
export async function localGetAgent(id: string, workspaceId?: string | null): Promise<any | null> {
  for (const scope of scopesFor(workspaceId)) {
    const row = await readJsonFile<LocalAgentRow>(agentFilePath(scope, id)).catch(() => null);
    if (row && row.id === id) return revive(row);
  }
  return null;
}

export async function localSetAgentStatus(id: string, status: string, workspaceId?: string | null): Promise<void> {
  await withStoreLock(`agents:${id}`, async () => {
    for (const scope of scopesFor(workspaceId)) {
      const path = agentFilePath(scope, id);
      const row = await readJsonFile<LocalAgentRow>(path).catch(() => null);
      if (!row || row.id !== id) continue;
      await writeJsonFile(path, { ...row, status, updatedAt: new Date().toISOString() });
      return;
    }
  });
}

export async function localUpsertAgent(input: {
  id?: string;
  workspaceId?: string | null;
  name: string;
  title: string;
  species?: string;
  avatar?: string;
  authorityLevel: number;
  modelModuleId?: string | null;
  instructionModuleId?: string;
  memorySharingPolicy?: string;
  status?: string;
  isTemplate?: boolean;
}): Promise<any> {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const scope = input.workspaceId ?? null;
  const path = agentFilePath(scope, id);
  let result: LocalAgentRow | null = null;
  await withStoreLock(`agents:${id}`, async () => {
    const existing = await readJsonFile<LocalAgentRow>(path).catch(() => null);
    if (existing && existing.id === id) {
      const next: LocalAgentRow = {
        ...existing,
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        name: input.name,
        title: input.title,
        authorityLevel: input.authorityLevel,
        status: input.status ?? existing.status,
        updatedAt: now,
      };
      await writeJsonFile(path, next);
      result = next;
      return;
    }
    const row: LocalAgentRow = {
      id,
      workspaceId: input.workspaceId ?? null,
      name: input.name,
      title: input.title,
      species: input.species,
      avatar: input.avatar,
      authorityLevel: input.authorityLevel,
      modelModuleId: input.modelModuleId ?? null,
      instructionModuleId: input.instructionModuleId ?? "instr-default",
      memorySharingPolicy: input.memorySharingPolicy ?? "full",
      isOmniscient: false,
      categoryPermissions: [],
      permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
      status: input.status ?? "offline",
      isTemplate: input.isTemplate ?? false,
      archivedAt: null,
      archivedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFile(path, row);
    result = row;
  });
  return revive(result!);
}

export async function localDeleteAgent(id: string, workspaceId?: string | null): Promise<boolean> {
  let removed = false;
  await withStoreLock(`agents:${id}`, async () => {
    for (const scope of scopesFor(workspaceId)) {
      const path = agentFilePath(scope, id);
      const row = await readJsonFile<LocalAgentRow>(path).catch(() => null);
      if (!row || row.id !== id) continue;
      await deleteFile(path);
      removed = true;
      return;
    }
  });
  return removed;
}

/**
 * Seed the default conversational agent for a fresh local workspace.
 * Idempotent: an existing live default-assistant in this workspace is returned
 * untouched, so repeated boots never duplicate the roster.
 */
export async function localSeedDefaultAgent(workspaceId?: string | null): Promise<any> {
  const existing = await localListAgents({ workspaceId: workspaceId ?? null });
  const found = existing.find((r: LocalAgentRow) => r.name === "default-assistant" && r.archivedAt === null);
  if (found) return found;
  return localUpsertAgent({
    id: "agent-default-assistant",
    workspaceId: workspaceId ?? null,
    name: "default-assistant",
    title: "Default Assistant",
    authorityLevel: 1,
    modelModuleId: null,
    instructionModuleId: "instr-default",
    memorySharingPolicy: "full",
    status: "idle",
    isTemplate: false,
  });
}

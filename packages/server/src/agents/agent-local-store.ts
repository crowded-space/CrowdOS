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

/** Defaults for optional agent fields on first write (mirror PG row defaults). */
function normalizeAgentInput(input: Record<string, any>) {
  return {
    // modelModuleId/instructionModuleId are part of the merged shape: dropping
    // them here silently reverted module assignments on every existing-row
    // update (they fell back to the existing row's values, null included).
    // AGT-009: null must survive normalization — a merged null is an explicit
    // clear (update path); only undefined keeps the stored value upstream.
    modelModuleId: input.modelModuleId,
    instructionModuleId: input.instructionModuleId ?? undefined,
    species: input.species ?? undefined,
    avatar: input.avatar ?? undefined,
    l3Subtype: input.l3Subtype ?? undefined,
    toolkitModuleId: input.toolkitModuleId ?? undefined,
    constraintsModuleId: input.constraintsModuleId ?? undefined,
    capabilitiesModuleId: input.capabilitiesModuleId ?? undefined,
    fallbackAgentId: input.fallbackAgentId ?? undefined,
    memorySharingPolicy: input.memorySharingPolicy ?? "full",
    isOmniscient: input.isOmniscient ?? false,
    categoryPermissions: input.categoryPermissions ?? [],
    contextTokenCap: input.contextTokenCap ?? undefined,
    permissions: input.permissions ?? {
      spawnAgents: false,
      patchRuntime: false,
      accessAllChannels: false,
    },
    isTemplate: input.isTemplate ?? false,
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
      // An explicit null scope mirrors the PG leg's `IS NULL` filter (rows
      // without a workspaceId); an undefined scope keeps the legacy fan-out.
      if (filters?.workspaceId === null) {
        if (row.workspaceId != null) continue;
      } else if (filters?.workspaceId && row.workspaceId && row.workspaceId !== filters.workspaceId) continue;
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

export async function localSetAgentStatus(id: string, status: string, workspaceId?: string | null): Promise<boolean> {
  let found = false;
  await withStoreLock(`agents:${id}`, async () => {
    for (const scope of scopesFor(workspaceId)) {
      const path = agentFilePath(scope, id);
      const row = await readJsonFile<LocalAgentRow>(path).catch(() => null);
      if (!row || row.id !== id) continue;
      await writeJsonFile(path, { ...row, status, updatedAt: new Date().toISOString() });
      found = true;
      return;
    }
  });
  return found;
}

export async function localUpsertAgent(input: {
  id?: string;
  workspaceId?: string | null;
  name: string;
  title: string;
  // Nullable-clearable: null clears, undefined keeps existing (update path).
  species?: string | null;
  avatar?: string | null;
  l3Subtype?: string | null;
  authorityLevel: number;
  modelModuleId?: string | null;
  instructionModuleId?: string;
  toolkitModuleId?: string | null;
  constraintsModuleId?: string | null;
  capabilitiesModuleId?: string | null;
  memorySharingPolicy?: string;
  isOmniscient?: boolean;
  fallbackAgentId?: string | null;
  categoryPermissions?: string[];
  permissions?: { spawnAgents: boolean; patchRuntime: boolean; accessAllChannels: boolean };
  status?: string;
  isTemplate?: boolean;
  // Nullable clears: null clears the field, ONLY undefined keeps existing.
  // (Callers type these as non-null; null flows through at runtime.)
  contextTokenCap?: number | null;
}): Promise<any> {
  if (input.id === undefined && (!input.workspaceId || !String(input.workspaceId).trim()) && process.env.VITEST === undefined) {
    // Tenant guard (QA audit 2026-09-23): a created agent without a scope
    // used to be filed under the "default" workspace folder. Fail loudly —
    // callers must name the workspace. Updates pass an id and keep their
    // existing scope (existing file wins), so only creation is gated here.
    // Unit tests are exempt: they build explicit per-test store fixtures
    // (setLocalStoreDirForTests) where unscoped upserts are the documented
    // fixture mechanism, not production traffic.
    throw new Error("localUpsertAgent: workspaceId is required when creating an agent (refusing to write to the 'default' scope)");
  }
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const scope = input.workspaceId ?? null;
  const path = agentFilePath(scope, id);
  let result: LocalAgentRow | null = null;
  await withStoreLock(`agents:${id}`, async () => {
    const existing = await readJsonFile<LocalAgentRow>(path).catch(() => null);
    // Tenant guard, create-side: the outer guard only fires when no id is
    // passed, but service create() always passes id=randomUUID() — so an
    // unscoped CREATE used to slip through to the "default" folder. Updates
    // (existing row, same id) keep their scope and are exempt.
    if ((!existing || existing.id !== id) && (!input.workspaceId || !String(input.workspaceId).trim()) && process.env.VITEST === undefined) {
      throw new Error("localUpsertAgent: workspaceId is required when creating an agent (refusing to write to the 'default' scope)");
    }
    if (existing && existing.id === id) {
      const next: LocalAgentRow = {
        ...existing,
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        name: input.name,
        title: input.title,
        authorityLevel: input.authorityLevel,
        // Null clears (NOT ?? existing): an explicit null must clear the
        // field, only undefined keeps the stored value.
        ...normalizeAgentInput({
          species: input.species !== undefined ? input.species : existing.species,
          avatar: input.avatar !== undefined ? input.avatar : existing.avatar,
          l3Subtype: input.l3Subtype !== undefined ? input.l3Subtype : existing.l3Subtype,
          // AGT-009: null clears, undefined keeps (mirror of the service merge).
          modelModuleId: input.modelModuleId !== undefined ? input.modelModuleId : existing.modelModuleId,
          instructionModuleId: input.instructionModuleId ?? existing.instructionModuleId,
          toolkitModuleId: input.toolkitModuleId !== undefined ? input.toolkitModuleId : existing.toolkitModuleId,
          constraintsModuleId: input.constraintsModuleId !== undefined ? input.constraintsModuleId : existing.constraintsModuleId,
          capabilitiesModuleId: input.capabilitiesModuleId !== undefined ? input.capabilitiesModuleId : existing.capabilitiesModuleId,
          fallbackAgentId: input.fallbackAgentId !== undefined ? input.fallbackAgentId : existing.fallbackAgentId,
          memorySharingPolicy: input.memorySharingPolicy ?? existing.memorySharingPolicy,
          isOmniscient: input.isOmniscient ?? existing.isOmniscient,
          categoryPermissions: input.categoryPermissions ?? existing.categoryPermissions,
          permissions: input.permissions ?? existing.permissions,
          isTemplate: input.isTemplate ?? existing.isTemplate,
          contextTokenCap: input.contextTokenCap !== undefined ? input.contextTokenCap : existing.contextTokenCap,
        }),
        status: input.status ?? existing.status,
        updatedAt: now,
      };
      await writeJsonFile(path, next);
      result = next;
      return;
    }
    // Filename collision: safeAgentFileId maps distinct ids (a/b vs a_b) to
    // one file. Blind overwrite would destroy the other agent's row.
    if (existing && existing.id !== id) {
      throw new Error(`localUpsertAgent: filename collision for id "${id}" (maps to another agent's file)`);
    }
    const normalized = normalizeAgentInput(input);
    const row: LocalAgentRow = {
      id,
      workspaceId: input.workspaceId ?? null,
      name: input.name,
      title: input.title,
      species: normalized.species,
      avatar: normalized.avatar,
      l3Subtype: normalized.l3Subtype,
      authorityLevel: input.authorityLevel,
      modelModuleId: input.modelModuleId ?? null,
      instructionModuleId: input.instructionModuleId ?? "instr-default",
      toolkitModuleId: normalized.toolkitModuleId,
      constraintsModuleId: normalized.constraintsModuleId,
      capabilitiesModuleId: normalized.capabilitiesModuleId,
      memorySharingPolicy: normalized.memorySharingPolicy,
      isOmniscient: normalized.isOmniscient,
      fallbackAgentId: normalized.fallbackAgentId,
      categoryPermissions: normalized.categoryPermissions,
      permissions: normalized.permissions,
      status: input.status ?? "offline",
      isTemplate: normalized.isTemplate,
      archivedAt: null,
      archivedReason: null,
      contextTokenCap: normalized.contextTokenCap ?? null,
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
 * AGT-016: the seed id is namespaced per workspace so two workspaces sharing
 * one PG database never collide on the agents.id PK.
 */
export async function localSeedDefaultAgent(workspaceId?: string | null): Promise<any> {
  if (!workspaceId || !String(workspaceId).trim()) {
    // Tenant guard (QA audit 2026-09-23): unscoped seeding used to file the
    // row under the "default" workspace folder. The default assistant is a
    // per-workspace row, so in production refuse to CREATE an unscoped one
    // (explicit workspace seeding is the only production path).
    const existingUnscoped = await localListAgents({ workspaceId: null });
    const foundUnscoped = existingUnscoped.find((r: LocalAgentRow) => r.name === "default-assistant" && r.archivedAt === null);
    if (foundUnscoped) return foundUnscoped;
    if (process.env.VITEST !== undefined) {
      // Unit tests: the store dir is an explicit per-test fixture
      // (setLocalStoreDirForTests), so an unscoped seed is the documented
      // fixture path - keep it working under vitest only.
      return localUpsertAgent({ id: "agent-default-assistant", workspaceId: null, name: "default-assistant", title: "Default Assistant", authorityLevel: 1, modelModuleId: null, instructionModuleId: "instr-default", memorySharingPolicy: "full", status: "idle", isTemplate: false });
    }
    throw new Error("localSeedDefaultAgent: workspaceId is required to seed a default agent (refusing to write to the 'default' scope)");
  }
  const existing = await localListAgents({ workspaceId: workspaceId ?? null });
  const found = existing.find((r: LocalAgentRow) => r.name === "default-assistant" && r.archivedAt === null);
  if (found) return found;
  return localUpsertAgent({
    // AGT-016: the PG agents PK is the global id; a literal seed id let two
    // workspaces sharing one database collide, and workspace-sync push then
    // upserted one workspace's seed over the other.
    id: `${workspaceId}:default-assistant`,
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

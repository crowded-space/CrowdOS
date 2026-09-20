// ─── Agent Local Store (C3 local-first) ─────────────────────────────────
// File truth for the agent roster when no DATABASE_URL is configured.
// agents.json rows mirror AgentProfile with ISO-string dates.
// ponytail: global file, O(n) scans — single-user local mode only.
// Module references are stored but never validated locally (spec 05 owns
// the module catalog; local mode runs the default provider config).

import { randomUUID } from "node:crypto";
import { mutateJsonArray, readJsonArray } from "../shared/core/local-file.js";

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

const AGENTS_FILE = "agents.json";

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

export async function localListAgents(filters?: {
  workspaceId?: string | null;
  authorityLevel?: number;
  status?: string;
  isTemplate?: boolean;
  limit?: number;
  cursor?: string | null;
}): Promise<any[]> {
  const rows = await readJsonArray<LocalAgentRow>(AGENTS_FILE);
  let list = rows.filter((r) => r.archivedAt === null);
  // Isolation: scoped rows visible only in their workspace; legacy null rows
  // (pre-migration) visible everywhere until backfilled.
  if (filters?.workspaceId !== undefined && filters.workspaceId !== null) {
    list = list.filter((r) => (r.workspaceId ?? null) === null || r.workspaceId === filters.workspaceId);
  }
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

export async function localGetAgent(id: string): Promise<any | null> {
  const rows = await readJsonArray<LocalAgentRow>(AGENTS_FILE);
  const found = rows.find((r) => r.id === id);
  return found ? revive(found) : null;
}

export async function localSetAgentStatus(id: string, status: string): Promise<void> {
  await mutateJsonArray<LocalAgentRow>(AGENTS_FILE, (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows[idx] = { ...rows[idx], status, updatedAt: new Date().toISOString() };
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
  let result: LocalAgentRow | null = null;
  await mutateJsonArray<LocalAgentRow>(AGENTS_FILE, (rows) => {
    if (input.id) {
      const idx = rows.findIndex((r) => r.id === input.id);
      if (idx !== -1) {
        rows[idx] = {
          ...rows[idx],
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          name: input.name,
          title: input.title,
          authorityLevel: input.authorityLevel,
          status: input.status ?? rows[idx].status,
          updatedAt: now,
        };
        result = rows[idx];
        return;
      }
    }
    const row: LocalAgentRow = {
      id: input.id ?? randomUUID(),
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
    rows.push(row);
    result = row;
  });
  return revive(result!);
}

export async function localDeleteAgent(id: string): Promise<boolean> {
  let removed = false;
  await mutateJsonArray<LocalAgentRow>(AGENTS_FILE, (rows) => {
    const next = rows.filter((r) => r.id !== id);
    removed = next.length !== rows.length;
    return next;
  });
  return removed;
}

/** Seed the default conversational agent for a fresh local workspace. */
export async function localSeedDefaultAgent(): Promise<any> {
  const existing = await readJsonArray<LocalAgentRow>(AGENTS_FILE);
  if (existing.some((r) => r.name === "default-assistant" && r.archivedAt === null)) {
    return revive(existing.find((r) => r.name === "default-assistant")!);
  }
  return localUpsertAgent({
    id: "agent-default-assistant",
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

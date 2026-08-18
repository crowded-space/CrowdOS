import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../Shared/config/database.js";
import {
  agents,
  capabilitiesModules,
  constraintsModules,
  instructionModules,
  modelModules,
  toolkitModules,
  runtimeStates,
} from "../db/schema.js";
import type {
  AgentAuthorityPermissions,
  AuthorityLevel,
  AgentProfile,
  AgentRegistryFilters,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
} from "./agentTypes.js";

const DEFAULT_PERMISSIONS: AgentAuthorityPermissions = {
  spawnAgents: false,
  patchRuntime: false,
  accessAllChannels: false,
};

function mapAgentProfile(row: typeof agents.$inferSelect): AgentProfile {
  return {
    ...row,
    authorityLevel: row.authorityLevel as AuthorityLevel,
    species: row.species ?? undefined,
    avatar: row.avatar ?? undefined,
    l3Subtype: row.l3Subtype ?? undefined,
    toolkitModuleId: row.toolkitModuleId ?? undefined,
    constraintsModuleId: row.constraintsModuleId ?? undefined,
    capabilitiesModuleId: row.capabilitiesModuleId ?? undefined,
    fallbackAgentId: row.fallbackAgentId ?? undefined,
    categoryPermissions: row.categoryPermissions ?? [],
  };
}

function normalizePermissions(
  permissions?: Partial<AgentAuthorityPermissions>,
  base: AgentAuthorityPermissions = DEFAULT_PERMISSIONS,
): AgentAuthorityPermissions {
  return {
    spawnAgents: permissions?.spawnAgents ?? base.spawnAgents,
    patchRuntime: permissions?.patchRuntime ?? base.patchRuntime,
    accessAllChannels: permissions?.accessAllChannels ?? base.accessAllChannels,
  };
}

export class AgentRegistry {
  async list(filters: AgentRegistryFilters = {}): Promise<AgentProfile[]> {
    const db = getDb();
    const whereClauses = [];

    if (filters.authorityLevel !== undefined) {
      whereClauses.push(eq(agents.authorityLevel, filters.authorityLevel));
    }

    if (filters.status !== undefined) {
      whereClauses.push(eq(agents.status, filters.status));
    }

    if (filters.isTemplate !== undefined) {
      whereClauses.push(eq(agents.isTemplate, filters.isTemplate));
    }

    const records = await db.query.agents.findMany({
      where: whereClauses.length > 0 ? and(...whereClauses) : undefined,
      orderBy: (table, { asc }) => [asc(table.authorityLevel), asc(table.name)],
    });

    return records.map(mapAgentProfile);
  }

  async getById(id: string): Promise<AgentProfile | null> {
    const db = getDb();
    const record = await db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    return record ? mapAgentProfile(record) : null;
  }

  async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    await this.ensureValidReferences(input);

    const now = new Date();
    const agentId = randomUUID();
    const db = getDb();

    await db.insert(agents).values({
      id: agentId,
      name: input.name,
      title: input.title,
      species: input.species ?? null,
      avatar: input.avatar ?? null,
      authorityLevel: input.authorityLevel,
      l3Subtype: input.l3Subtype ?? null,
      modelModuleId: input.modelModuleId,
      instructionModuleId: input.instructionModuleId,
      toolkitModuleId: input.toolkitModuleId ?? null,
      constraintsModuleId: input.constraintsModuleId ?? null,
      capabilitiesModuleId: input.capabilitiesModuleId ?? null,
      memorySharingPolicy: input.memorySharingPolicy,
      isOmniscient: input.isOmniscient ?? false,
      fallbackAgentId: input.fallbackAgentId ?? null,
      categoryPermissions: input.categoryPermissions ?? [],
      permissions: normalizePermissions(input.permissions),
      status: input.status ?? "offline",
      isTemplate: input.isTemplate ?? false,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(runtimeStates).values({
      sessionId: `session-${agentId}`,
      agentId,
      status: input.status === "offline" ? "offline" : "idle",
      lastHeartbeat: now,
      createdAt: now,
    });

    const created = await this.getById(agentId);
    if (!created) {
      throw new Error("Failed to create agent profile.");
    }

    return created;
  }

  async update(id: string, input: UpdateAgentProfileInput): Promise<AgentProfile | null> {
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    const merged: CreateAgentProfileInput = {
      name: input.name ?? existing.name,
      title: input.title ?? existing.title,
      species: input.species === null ? undefined : (input.species ?? existing.species),
      avatar: input.avatar === null ? undefined : (input.avatar ?? existing.avatar),
      authorityLevel: input.authorityLevel ?? existing.authorityLevel,
      l3Subtype: input.l3Subtype === null ? undefined : (input.l3Subtype ?? existing.l3Subtype),
      modelModuleId: input.modelModuleId ?? existing.modelModuleId,
      instructionModuleId: input.instructionModuleId ?? existing.instructionModuleId,
      toolkitModuleId: input.toolkitModuleId === null ? undefined : (input.toolkitModuleId ?? existing.toolkitModuleId),
      constraintsModuleId:
        input.constraintsModuleId === null ? undefined : (input.constraintsModuleId ?? existing.constraintsModuleId),
      capabilitiesModuleId:
        input.capabilitiesModuleId === null ? undefined : (input.capabilitiesModuleId ?? existing.capabilitiesModuleId),
      memorySharingPolicy: input.memorySharingPolicy ?? existing.memorySharingPolicy,
      isOmniscient: input.isOmniscient ?? existing.isOmniscient,
      fallbackAgentId: input.fallbackAgentId === null ? undefined : (input.fallbackAgentId ?? existing.fallbackAgentId),
      categoryPermissions: input.categoryPermissions ?? existing.categoryPermissions,
      permissions: normalizePermissions(input.permissions, existing.permissions),
      status: input.status ?? existing.status,
      isTemplate: input.isTemplate ?? existing.isTemplate,
    };

    await this.ensureValidReferences(merged, id);

    const db = getDb();
    await db
      .update(agents)
      .set({
        name: merged.name,
        title: merged.title,
        species: merged.species ?? null,
        avatar: merged.avatar ?? null,
        authorityLevel: merged.authorityLevel,
        l3Subtype: merged.l3Subtype ?? null,
        modelModuleId: merged.modelModuleId,
        instructionModuleId: merged.instructionModuleId,
        toolkitModuleId: merged.toolkitModuleId ?? null,
        constraintsModuleId: merged.constraintsModuleId ?? null,
        capabilitiesModuleId: merged.capabilitiesModuleId ?? null,
        memorySharingPolicy: merged.memorySharingPolicy,
        isOmniscient: merged.isOmniscient ?? false,
        fallbackAgentId: merged.fallbackAgentId ?? null,
        categoryPermissions: merged.categoryPermissions ?? [],
        permissions: merged.permissions ? normalizePermissions(merged.permissions) : existing.permissions,
        status: merged.status ?? existing.status,
        isTemplate: merged.isTemplate ?? false,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));

    await db
      .update(runtimeStates)
      .set({
        status: merged.status === "offline" ? "offline" : "idle",
        lastHeartbeat: new Date(),
      })
      .where(eq(runtimeStates.agentId, id));

    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const result = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
    return result.length > 0;
  }

  private async ensureValidReferences(input: CreateAgentProfileInput, currentAgentId?: string): Promise<void> {
    const db = getDb();

    if (input.l3Subtype && input.authorityLevel !== 3) {
      throw new Error("Only authority level 3 agents may define an l3Subtype.");
    }

    if (input.fallbackAgentId && input.fallbackAgentId === currentAgentId) {
      throw new Error("An agent cannot fallback to itself.");
    }

    const [modelModule, instructionModule, toolkitModule, constraintsModule, capabilitiesModule, fallbackAgent] =
      await Promise.all([
        db.query.modelModules.findFirst({ where: eq(modelModules.id, input.modelModuleId) }),
        db.query.instructionModules.findFirst({ where: eq(instructionModules.id, input.instructionModuleId) }),
        input.toolkitModuleId
          ? db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, input.toolkitModuleId) })
          : Promise.resolve(null),
        input.constraintsModuleId
          ? db.query.constraintsModules.findFirst({ where: eq(constraintsModules.id, input.constraintsModuleId) })
          : Promise.resolve(null),
        input.capabilitiesModuleId
          ? db.query.capabilitiesModules.findFirst({ where: eq(capabilitiesModules.id, input.capabilitiesModuleId) })
          : Promise.resolve(null),
        input.fallbackAgentId
          ? db.query.agents.findFirst({ where: eq(agents.id, input.fallbackAgentId) })
          : Promise.resolve(null),
      ]);

    if (!modelModule) {
      throw new Error(`ModelModule not found: ${input.modelModuleId}`);
    }

    if (!instructionModule) {
      throw new Error(`InstructionModule not found: ${input.instructionModuleId}`);
    }

    if (input.toolkitModuleId && !toolkitModule) {
      throw new Error(`ToolkitModule not found: ${input.toolkitModuleId}`);
    }

    if (input.constraintsModuleId && !constraintsModule) {
      throw new Error(`ConstraintsModule not found: ${input.constraintsModuleId}`);
    }

    if (input.capabilitiesModuleId && !capabilitiesModule) {
      throw new Error(`CapabilitiesModule not found: ${input.capabilitiesModuleId}`);
    }

    if (input.fallbackAgentId && !fallbackAgent) {
      throw new Error(`Fallback agent not found: ${input.fallbackAgentId}`);
    }
  }
}

export const agentRegistry = new AgentRegistry();

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb, dbScopeKey, withTransaction, runWithDb } from "../shared/config/database.js";
import { skillsGate } from "../skills/skills-gate.js";
import { forEachWorkspaceDb } from "../workspace/workspace-gate.js";
import { markAgentWorking, markAgentIdle } from "../shared/core/agent-heartbeat.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";
import type { RuntimeStatus } from "../types/runtime.types.js";
import { getCachedRoster, invalidateRosterCache } from "./agent-roster-cache.js";
import {
  agents,
  runtimeStates,
} from "../db/schema.js";
import type {
  AgentAuthorityPermissions,
  AuthorityLevel,
  AgentProfile,
  AgentRegistryFilters,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
} from "./agent-types.js";

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
    // contextTokenCap is managed via AgentProfile override; if column exists, map it, else derived fallback
    contextTokenCap: (row as any).contextTokenCap ?? (row as any).context_token_cap ?? null,
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
  async list(filters: AgentRegistryFilters = {}, dbOverride?: any): Promise<AgentProfile[]> {
    if (dbOverride) {
      return this.loadRoster(filters, dbOverride);
    }
    // ponytail: scope key by tenant handle — an unscoped key serves A's roster to B.
    return getCachedRoster(`${dbScopeKey()}:roster:${JSON.stringify(filters)}`, () => this.loadRoster(filters));
  }

  private async loadRoster(filters: AgentRegistryFilters, dbOverride?: any): Promise<AgentProfile[]> {
    const db = dbOverride || getDb();
    const whereClauses = [];

    whereClauses.push(isNull(agents.archivedAt));

    if (filters.authorityLevel !== undefined) {
      whereClauses.push(eq(agents.authorityLevel, filters.authorityLevel));
    }

    if (filters.status !== undefined) {
      whereClauses.push(eq(agents.status, filters.status));
    }

    if (filters.isTemplate !== undefined) {
      whereClauses.push(eq(agents.isTemplate, filters.isTemplate));
    }

    const limit = filters.limit != null ? Math.min(200, Math.max(1, filters.limit)) : 200;
    let offset = 0;
    if (filters.cursor) {
      const parsed = Number(filters.cursor);
      if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
    }

    const records = await db.query.agents.findMany({
      where: whereClauses.length > 0 ? and(...whereClauses) : undefined,
      orderBy: (table: any, { asc }: any) => [asc(table.authorityLevel), asc(table.name)],
      limit,
      offset,
    });

    return records.map(mapAgentProfile);
  }

  async getById(id: string, dbOverride?: any): Promise<AgentProfile | null> {
    const db = dbOverride || getDb();
    const record = await db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    return record ? mapAgentProfile(record) : null;
  }

  async create(input: CreateAgentProfileInput, dbOverride?: any): Promise<AgentProfile> {
    await this.ensureValidReferences(input, undefined, dbOverride);

    const now = new Date();
    const agentId = randomUUID();
    const db = dbOverride || getDb();

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

    const created = await this.getById(agentId, db);
    if (!created) {
      throw new Error("Failed to create agent profile.");
    }

    invalidateRosterCache();

    return created;
  }

  async update(id: string, input: UpdateAgentProfileInput, dbOverride?: any): Promise<AgentProfile | null> {
    const db = dbOverride || getDb();
    const existing = await this.getById(id, db);
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

    await this.ensureValidReferences(merged, id, db);

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

    if (input.toolkitModuleId !== undefined || input.permissions !== undefined) {
      skillsGate.invalidateAgentCaches(id);
    }

    await db
      .update(runtimeStates)
      .set({
        status: merged.status === "offline" ? "offline" : "idle",
        lastHeartbeat: new Date(),
      })
      .where(eq(runtimeStates.agentId, id));

    invalidateRosterCache();

    return this.getById(id);
  }

  async delete(id: string, dbOverride?: any): Promise<boolean> {
    const db = dbOverride || getDb();
    const result = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
    invalidateRosterCache();
    return result.length > 0;
  }

  /** Sole owner write for `agents.status` + `runtime_states`: atomic flip + heartbeat + `agent:status`. */
  async setStatus(
    agentId: string,
    status: RuntimeStatus,
    opts: { broker?: EventBroker; db?: any; errorInfo?: { code: string; message: string } } = {}
  ): Promise<void> {
    const write = async (tx: any) => {
      await tx.update(agents).set({ status }).where(eq(agents.id, agentId));
      await tx
        .update(runtimeStates)
        .set({
          status,
          lastHeartbeat: new Date(),
          ...(opts.errorInfo
            ? { errorInfo: { ...opts.errorInfo, timestamp: new Date().toISOString() } }
            : {}),
        })
        .where(eq(runtimeStates.agentId, agentId));
    };
    if (opts.db) await runWithDb(opts.db, () => withTransaction(write));
    else await withTransaction(write);

    if (status === "working") markAgentWorking(agentId);
    else markAgentIdle(agentId);

    opts.broker?.emit("agent:status", { agentId, status } as never);
  }

  /** Sole owner heartbeat touch for locally-active agents across workspace DBs. */
  async touchHeartbeat(agentIds: string[], dbOverride?: any): Promise<void> {
    if (agentIds.length === 0) return;
    const touch = async (db: any) => {
      try {
        await db.update(runtimeStates).set({ lastHeartbeat: new Date() }).where(inArray(runtimeStates.agentId, agentIds));
      } catch (err) {
        console.error("[Heartbeat] Failed to touch working agents:", (err as any)?.message || err);
      }
    };
    if (dbOverride) {
      await touch(dbOverride);
      return;
    }
    // ponytail: touch every database — a locally working agent may belong to
    // any workspace; row misses elsewhere are no-ops.
    await forEachWorkspaceDb(async (db) => {
      await touch(db);
    });
  }

  /** Sole owner orphan sweep: pause stale `working` rows whose heartbeat expired. Returns paused count. */
  async sweepOrphans(broker: EventBroker, opts: { orphanAfterMs?: number; isLive?: (agentId: string) => boolean } = {}): Promise<number> {
    const raw = opts.orphanAfterMs ?? Number(process.env.ORPHAN_AFTER_MS);
    const orphanAfterMs = Number.isFinite(raw) && (raw as number) >= 10_000 ? (raw as number) : 60_000;
    let paused = 0;
    await forEachWorkspaceDb(async (db, workspaceId) => {
      try {
        const cutoff = new Date(Date.now() - orphanAfterMs);
        const stale = await db
          .select()
          .from(runtimeStates)
          .where(and(eq(runtimeStates.status, "working"), lt(runtimeStates.lastHeartbeat, cutoff)))
          .orderBy(asc(runtimeStates.lastHeartbeat))
          .limit(50)
          .for("update", { skipLocked: true });

        for (const state of stale) {
          if (opts.isLive?.(state.agentId)) continue;
          console.warn(`[Heartbeat] Orphaned 'working' agent ${state.agentId} detected (no heartbeat since ${state.lastHeartbeat?.toISOString?.() ?? "never"}) — pausing.`);
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, state.agentId));
          await db
            .update(runtimeStates)
            .set({ status: "paused", errorInfo: { code: "ORPHANED", message: "Heartbeat expired; run presumed dead.", timestamp: new Date().toISOString() } })
            .where(eq(runtimeStates.agentId, state.agentId));
          // ponytail: tag the owning workspace so clients ignore foreign pauses.
          const wid = workspaceId ? { workspaceId } : {};
          broker.emit("agent:status", { agentId: state.agentId, status: "paused", ...wid } as never);
          broker.emit("agent:paused", { agentId: state.agentId, reason: "Heartbeat expired; run presumed dead.", ...wid } as never);
          paused++;
        }
      } catch (err) {
        console.error("[Heartbeat] Orphan sweep failed:", (err as any)?.message || err);
      }
    });
    return paused;
  }

  private async ensureValidReferences(input: CreateAgentProfileInput, currentAgentId?: string, dbOverride?: any): Promise<void> {
    const db = dbOverride || getDb();

    if (input.l3Subtype && input.authorityLevel !== 3) {
      throw new Error("Only authority level 3 agents may define an l3Subtype.");
    }

    if (input.fallbackAgentId && input.fallbackAgentId === currentAgentId) {
      throw new Error("An agent cannot fallback to itself.");
    }

    // Modules owns module rows: validate via gate (dynamic import avoids Agents↔Modules↔Runtime cycle).
    const { moduleGate } = await import("../modules/module-gate.js");
    await moduleGate.validateReferences(
      {
        modelModuleId: input.modelModuleId,
        instructionModuleId: input.instructionModuleId,
        toolkitModuleId: input.toolkitModuleId,
        constraintsModuleId: input.constraintsModuleId,
        capabilitiesModuleId: input.capabilitiesModuleId,
      },
      db,
    );

    if (input.fallbackAgentId) {
      const fallbackAgent = await db.query.agents.findFirst({ where: eq(agents.id, input.fallbackAgentId) });
      if (!fallbackAgent) {
        throw new Error(`Fallback agent not found: ${input.fallbackAgentId}`);
      }
    }
  }
}

export const agentRegistry = new AgentRegistry();

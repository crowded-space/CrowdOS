import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { getDb, dbScopeKey, withTransaction, runWithDb, dualWrite, resolveTier, isConnectionError } from "../shared/config/database.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import {
  localDeleteAgent,
  localGetAgent,
  localListAgents,
  localSetAgentStatus,
  localUpsertAgent,
} from "./agent-local-store.js";
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
    workspaceId: (row as unknown as { workspaceId?: string | null }).workspaceId ?? null,
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

/**
 * Dual-boot reads: explicit handle pins PG exactly; otherwise union both
 * tiers (local wins on id collision) so legacy PG rows and local rows coexist.
 * Thunk form — getDb() itself throws synchronously without a database.
 */
async function pgCatchNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function mergeRoster(pgRows: AgentProfile[], localRows: AgentProfile[]): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  for (const r of pgRows) byId.set(r.id, r);
  for (const r of localRows) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.authorityLevel - b.authorityLevel || (a.name < b.name ? -1 : 1));
}

export class AgentRegistry {
  async list(filters: AgentRegistryFilters = {}, dbOverride?: any): Promise<AgentProfile[]> {
    if (dbOverride) {
      return this.loadRoster(filters, dbOverride);
    }
    // ponytail: scope key by tenant handle — an unscoped key serves A's roster to B.
    // Union loader is cached like the old PG-only loader (same invalidation points).
    // Tenant isolation (2026-09-25 audit fix): inside a bound PG tenant handle
    // (runWithDb / request scope), the roster comes from that handle only —
    // merging the file tier here would leak OTHER workspaces' local agents
    // into every tenant's cached roster (the local store has no ALS awareness).
    // The local-first union stays for unbound callers (pure-local mode and
    // registry-only workspaces), which is where the file tier is truth.
    if (dbScopeKey() !== "global") {
      return getCachedRoster(`${dbScopeKey()}:roster:${JSON.stringify(filters)}`, async () =>
        this.loadRoster(filters),
      );
    }
    return getCachedRoster(`${dbScopeKey()}:roster:${JSON.stringify(filters)}`, async () => {
      const [pgRows, localRows] = await Promise.all([
        pgCatchNull(() => this.loadRoster(filters)).then((rows) => rows ?? []),
        localListAgents(filters as any).catch(() => [] as AgentProfile[]),
      ]);
      return mergeRoster(pgRows, localRows);
    });
  }

  private async loadRoster(filters: AgentRegistryFilters, dbOverride?: any): Promise<AgentProfile[]> {
    const db = dbOverride || getDb();
    const whereClauses = [];

    whereClauses.push(isNull(agents.archivedAt));
    // Isolation: scoped rows only in their workspace. Undefined = all rows
    // (legacy callers); set value = scoped + legacy-global rows.
    if (filters.workspaceId !== undefined && filters.workspaceId !== null) {
      whereClauses.push(or(eq(agents.workspaceId, filters.workspaceId), isNull(agents.workspaceId)));
    } else if (filters.workspaceId === null) {
      whereClauses.push(isNull(agents.workspaceId));
    }

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

  async getById(id: string, dbOverride?: any, workspaceId?: string | null): Promise<AgentProfile | null> {
    if (dbOverride) {
      const record = await dbOverride.query.agents.findFirst({
        where: eq(agents.id, id),
      });
      return record ? mapAgentProfile(record) : null;
    }
    // Tenant scope first: the local store resolves the row inside the caller's
    // workspace folder; PG only fills the gap when local has nothing. Without
    // this, duplicate ids across workspace folders resolve to the first match.
    const scoped = (await localGetAgent(id, workspaceId).catch(() => null)) as AgentProfile | null;
    if (scoped) return scoped;
    return (
      ((await localGetAgent(id).catch(() => null)) as AgentProfile | null) ??
      (await pgCatchNull(() =>
        getDb().query.agents.findFirst({
          where: eq(agents.id, id),
        }),
      ).then((record) => (record ? mapAgentProfile(record) : null)))
    );
  }

  async create(input: CreateAgentProfileInput, dbOverride?: any): Promise<AgentProfile> {
    const now = new Date();
    const agentId = randomUUID();
    const row = {
      id: agentId,
      workspaceId: input.workspaceId ?? null,
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
    };

    const localCreate = () =>
      localUpsertAgent({
        id: agentId,
        workspaceId: input.workspaceId ?? null,
        name: input.name,
        title: input.title,
        species: input.species,
        avatar: input.avatar,
        l3Subtype: input.l3Subtype,
        authorityLevel: input.authorityLevel,
        modelModuleId: input.modelModuleId ?? null,
        instructionModuleId: input.instructionModuleId,
        toolkitModuleId: input.toolkitModuleId,
        constraintsModuleId: input.constraintsModuleId,
        capabilitiesModuleId: input.capabilitiesModuleId,
        memorySharingPolicy: input.memorySharingPolicy,
        isOmniscient: input.isOmniscient,
        fallbackAgentId: input.fallbackAgentId,
        categoryPermissions: input.categoryPermissions,
        permissions: input.permissions
          ? normalizePermissions(input.permissions)
          : undefined,
        status: input.status ?? "offline",
        isTemplate: input.isTemplate ?? false,
      });

    // Explicit handle pins PG exactly (tests/seeds/replay) with full validation.
    if (dbOverride) {
      await this.ensureValidReferences(input, undefined, dbOverride);
      await dbOverride.insert(agents).values(row);
      await dbOverride.insert(runtimeStates).values({
        sessionId: `session-${agentId}`,
        agentId,
        status: input.status === "offline" ? "offline" : "idle",
        lastHeartbeat: now,
        createdAt: now,
      });
      const created = await this.getById(agentId, dbOverride);
      if (!created) throw new Error("Failed to create agent profile.");
      invalidateRosterCache();
      return created;
    }

    // Dual-boot: structural rules always; module rows validated only when PG
    // is actually written (they live in PG until spec 05).
    if (input.l3Subtype && input.authorityLevel !== 3) {
      throw new Error("Only authority level 3 agents may define an l3Subtype.");
    }
    const ctx = await tierContextFor(input.workspaceId ?? null);
    const tier = resolveTier(ctx).tier;
    if (tier === "local") {
      // C3: a fresh local workspace has no catalog. Resolve the referenced
      // module ids against the local store, seeding the canon defaults when
      // missing, so "Launch Assembly" works before any module is created.
      const { moduleGate, DEFAULT_INSTRUCTION_MODULE_ID } = await import("../modules/module-gate.js");
      await moduleGate.ensureDefaults(input.workspaceId ?? null);
      if (input.instructionModuleId === DEFAULT_INSTRUCTION_MODULE_ID || !(await moduleGate.instruction.get(input.instructionModuleId, input.workspaceId))) {
        input = { ...input, instructionModuleId: DEFAULT_INSTRUCTION_MODULE_ID };
      }
      if (input.modelModuleId && !(await moduleGate.model.get(input.modelModuleId, input.workspaceId))) {
        input = { ...input, modelModuleId: null };
      }
    }
    if (tier === "dual") {
      // Best-effort PG validation — skips itself when the database is gone.
      await this.ensureValidReferences(input, undefined).catch((err) => {
        if (!isConnectionError(err)) throw err;
      });
    }
    const created = await dualWrite({
      ctx,
      entity: "agent",
      op: "upsert",
      id: agentId,
      row: { ...row, createdAt: now.toISOString(), updatedAt: now.toISOString() },
      pgWrite: async () => {
        const db = getDb();
        await db.insert(agents).values(row);
        await db.insert(runtimeStates).values({
          sessionId: `session-${agentId}`,
          agentId,
          status: input.status === "offline" ? "offline" : "idle",
          lastHeartbeat: now,
          createdAt: now,
        });
      },
      localWrite: localCreate,
    });
    invalidateRosterCache();
    return created as AgentProfile;
  }

  async update(id: string, input: UpdateAgentProfileInput, dbOverride?: any, workspaceId?: string | null): Promise<AgentProfile | null> {
    // Scope-then-merge: when the caller names a tenant, the row must be
    // resolved and written inside that tenant, never the first folder that
    // happens to contain the same agent id.
    if (workspaceId !== undefined && workspaceId !== dbOverride) {
      input = { ...input, workspaceId: input.workspaceId ?? workspaceId };
    }
    const existing = await this.getById(id, dbOverride, workspaceId);
    if (!existing) {
      return null;
    }

    const merged: CreateAgentProfileInput = {
      workspaceId: input.workspaceId ?? existing.workspaceId ?? null,
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

    const pgSet = {
      workspaceId: merged.workspaceId ?? null,
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
    };

    const localApply = () =>
      localUpsertAgent({
        id,
        workspaceId: merged.workspaceId ?? null,
        name: merged.name,
        title: merged.title,
        species: merged.species,
        avatar: merged.avatar,
        l3Subtype: merged.l3Subtype,
        authorityLevel: merged.authorityLevel,
        modelModuleId: merged.modelModuleId,
        instructionModuleId: merged.instructionModuleId,
        toolkitModuleId: merged.toolkitModuleId,
        constraintsModuleId: merged.constraintsModuleId,
        capabilitiesModuleId: merged.capabilitiesModuleId,
        memorySharingPolicy: merged.memorySharingPolicy,
        isOmniscient: merged.isOmniscient,
        fallbackAgentId: merged.fallbackAgentId,
        categoryPermissions: merged.categoryPermissions,
        permissions: merged.permissions
          ? normalizePermissions(merged.permissions)
          : undefined,
        status: merged.status ?? existing.status,
        isTemplate: merged.isTemplate,
      });

    // Explicit handle pins PG exactly (tests/seeds/replay) with full validation.
    if (dbOverride) {
      await this.ensureValidReferences(merged, id, dbOverride);
      await dbOverride.update(agents).set(pgSet).where(eq(agents.id, id));
      if (input.toolkitModuleId !== undefined || input.permissions !== undefined) {
        skillsGate.invalidateAgentCaches(id);
      }
      await dbOverride
        .update(runtimeStates)
        .set({
          status: merged.status === "offline" ? "offline" : "idle",
          lastHeartbeat: new Date(),
        })
        .where(eq(runtimeStates.agentId, id));
      invalidateRosterCache();
      return this.getById(id, dbOverride);
    }

    // Dual-boot: validate against PG only when it will actually be written.
    const ctx = await tierContextFor(merged.workspaceId ?? null);
    if (resolveTier(ctx).tier === "dual") {
      await this.ensureValidReferences(merged, id).catch((err) => {
        if (!isConnectionError(err)) throw err;
      });
    }
    await dualWrite({
      ctx,
      entity: "agent",
      op: "upsert",
      id,
      row: { ...existing, ...merged, updatedAt: new Date().toISOString() },
      pgWrite: async () => {
        const db = getDb();
        await db.update(agents).set(pgSet).where(eq(agents.id, id));
        await db
          .update(runtimeStates)
          .set({
            status: merged.status === "offline" ? "offline" : "idle",
            lastHeartbeat: new Date(),
          })
          .where(eq(runtimeStates.agentId, id));
      },
      localWrite: localApply,
    });

    if (input.toolkitModuleId !== undefined || input.permissions !== undefined) {
      skillsGate.invalidateAgentCaches(id);
    }
    invalidateRosterCache();
    return this.getById(id, undefined, workspaceId);
  }

  async delete(id: string, dbOverride?: any): Promise<boolean> {
    if (dbOverride) {
      const result = await dbOverride.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
      invalidateRosterCache();
      return result.length > 0;
    }
    const existing = await this.getById(id);
    if (!existing) return false;
    // Tier context from the row itself: an agent belongs to a workspace, so
    // the delete/outbox must be attributed to that workspace — not the
    // global scope (which left outbox entries a drain could never route).
    const ctx = await tierContextFor(existing.workspaceId ?? null);
    const removed = await dualWrite({
      ctx,
      entity: "agent",
      op: "delete",
      id,
      row: null,
      pgWrite: async () => {
        const db = getDb();
        await db.delete(agents).where(eq(agents.id, id));
      },
      // Scope the local delete to the owning workspace folder: duplicate ids
      // across workspaces must not delete the first file that matches.
      localWrite: () => localDeleteAgent(id, existing.workspaceId ?? null),
    });
    invalidateRosterCache();
    return removed;
  }

  /** Sole owner write for `agents.status` + `runtime_states`: atomic flip + heartbeat + `agent:status`. */
  async setStatus(
    agentId: string,
    status: RuntimeStatus,
    opts: { broker?: EventBroker; db?: any; errorInfo?: { code: string; message: string } } = {}
  ): Promise<void> {
    // Explicit handle pins PG exactly (tests/seeds).
    if (opts.db) {
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
      await runWithDb(opts.db, () => withTransaction(write));
    } else {
      // Dual-boot: PG flip + local file flip (no runtime_states ledger locally).
      // Tier context from the agent row itself so the PG leg and any outbox
      // fallback are attributed to the owning workspace (CrowdOS §1).
      const agent = await this.getById(agentId).catch(() => null);
      const ctx = await tierContextFor(agent?.workspaceId ?? null);
      await dualWrite({
        ctx,
        entity: "agent",
        op: "upsert",
        id: agentId,
        // Status-only row: replay re-flips PG status (presence, not content).
        row: { status, updatedAt: new Date().toISOString() } as Record<string, unknown>,
        pgWrite: () =>
          withTransaction(async (tx: any) => {
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
          }),
        localWrite: () => localSetAgentStatus(agentId, status),
      });
    }

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

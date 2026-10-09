import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { getDb, dbScopeKey, withTransaction, runWithDb, dualWrite, resolveTier, isConnectionError, isSchemaMismatchError } from "../shared/config/database.js";
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
  agentInstructionStacks,
} from "../db/schema.js";
import type {
  AgentAuthorityPermissions,
  AuthorityLevel,
  AgentProfile,
  AgentRegistryFilters,
  CreateAgentProfileInput,
  L3Subtype,
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
  } catch (err) {
    console.warn("[agents] PG read failed, falling back:", err instanceof Error ? err.message : err);
    return null;
  }
}

function mergeRoster(pgRows: AgentProfile[], localRows: AgentProfile[]): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  for (const r of pgRows) byId.set(r.id, r);
  for (const r of localRows) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.authorityLevel - b.authorityLevel || (a.name < b.name ? -1 : 1));
}

function limitOf(filters: AgentRegistryFilters): number {
  return filters.limit != null ? Math.min(200, Math.max(1, filters.limit)) : 200;
}

/**
 * Update-merge shape: CreateAgentProfileInput plus explicit nulls on the
 * nullable-clearable fields (update schema .nullable()). A bare intersection
 * would NARROW away the null, so Omit-then-extend.
 */
type NullableAgentMerge = Omit<
  CreateAgentProfileInput,
  "species" | "avatar" | "l3Subtype" | "toolkitModuleId" | "constraintsModuleId" | "capabilitiesModuleId" | "fallbackAgentId"
> & {
  species?: string | null;
  avatar?: string | null;
  l3Subtype?: L3Subtype | null;
  toolkitModuleId?: string | null;
  constraintsModuleId?: string | null;
  capabilitiesModuleId?: string | null;
  fallbackAgentId?: string | null;
};

export class AgentRegistry {
  async list(filters: AgentRegistryFilters = {}, dbOverride?: any): Promise<AgentProfile[]> {
    if (dbOverride) {
      // IMPL-AGENTLIST500-001: an explicit handle (request.db) must degrade
      // like the bound ALS path — an unprovisioned/outage tenant PG leg
      // (42P01 class) falls back to the workspace-scoped local roster
      // instead of 500ing GET /api/agents.
      return this.loadBoundRoster(filters, dbOverride);
    }
    // ponytail: scope key by tenant handle — an unscoped key serves A's roster to B.
    // Union loader is cached like the old PG-only loader (same invalidation points).
    // Tenant isolation (2026-09-25 audit fix): inside a bound PG tenant handle
    // (runWithDb / request scope), the roster comes from that handle only —
    // merging the file tier here would leak OTHER workspaces' local agents
    // into every tenant's cached roster (the local store has no ALS awareness).
    // The local-first union stays for unbound callers (pure-local mode and
    // registry-only workspaces), which is where the file tier is truth.
    // AGT-002: the leak fix removed local merging entirely in tenant scope
    // instead of scoping local reads per tenant — a local-first create whose PG
    // leg failed (outboxed) stayed invisible inside request scope. The bound
    // loader now merges the workspace-scoped local read (the store already
    // supports scoping); an unscoped filters.workspaceId keeps the PG-only
    // read, since without a workspace there is no honest way to scope local
    // rows and the fan-out would re-open the cross-tenant leak.
    if (dbScopeKey() !== "global") {
      return getCachedRoster(`${dbScopeKey()}:roster:${JSON.stringify(filters)}`, () =>
        this.loadBoundRoster(filters),
      );
    }
    return getCachedRoster(`${dbScopeKey()}:roster:${JSON.stringify(filters)}`, async () => {
      const [pgRows, localRows] = await Promise.all([
        pgCatchNull(() => this.loadRoster(filters)).then((rows) => rows ?? []),
        localListAgents(filters as any).catch((err) => {
          console.warn("[agents] Local roster read failed:", err instanceof Error ? err.message : err);
          return [] as AgentProfile[];
        }),
      ]);
      // Union can hold up to 2x the per-tier pages — clamp to what was asked.
      return mergeRoster(pgRows, localRows).slice(0, limitOf(filters));
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

    const limit = limitOf(filters);
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

  /**
   * AGT-002: bound-handle roster — PG rows from the ALS handle plus the
   * workspace-scoped local rows. The 2026-09-25 leak fix stopped merging the
   * file tier here because an UNSCOPED local read fans out across workspace
   * folders; a named workspace can be read honestly (localListAgents already
   * scopes, including legacy-global null-workspace rows, mirroring loadRoster).
   * Unscoped filters (workspaceId undefined) keep the PG-only read.
   */
  private async loadBoundRoster(filters: AgentRegistryFilters, dbOverride?: any): Promise<AgentProfile[]> {
    const pgRows = await pgCatchNull(() => this.loadRoster(filters, dbOverride)).then((rows) => rows ?? []);
    if (filters.workspaceId === undefined) return pgRows;
    const localRows = await localListAgents(filters as any).catch((err) => {
      console.warn("[agents] Bound local roster read failed:", err instanceof Error ? err.message : err);
      return [] as AgentProfile[];
    });
    // Union can hold up to 2x the per-tier pages — clamp to what was asked.
    return mergeRoster(pgRows, localRows).slice(0, limitOf(filters));
  }

  /**
   * AGT-001: resolve the PG handle for a named workspace's replica leg.
   * Inside ALS (request scope) getDb() already returns the tenant handle, so
   * there is nothing to add; outside it (socket/worker scopes, RUN-007 class)
   * the ambient pool may be a different database in split-DB deployments, so
   * the owning workspace's record DB is resolved and bound for the write.
   * Null = no workspace context or no record DB (local-only tier).
   */
  private async pgHandleFor(workspaceId?: string | null): Promise<ReturnType<typeof getDb> | null> {
    if (workspaceId === undefined || workspaceId === null) return null;
    try {
      // Inside ALS (request scope) getDb() is already the tenant handle.
      if (dbScopeKey() !== "global") return null;
      // Dynamic import (runs-repository precedent): keeps this module loadable
      // under test fakes that replace database.js without the resolver.
      const mod = await import("../shared/config/database.js");
      if (typeof mod.dbForWorkspace !== "function") return null;
      return await mod.dbForWorkspace(workspaceId);
    } catch {
      return null;
    }
  }

  async getById(id: string, dbOverride?: any, workspaceId?: string | null): Promise<AgentProfile | null> {
    if (dbOverride) {
    try {
      // Explicit handle still honors a named tenant: duplicate ids across
      // workspaces must not resolve to the first row. Unscoped (undefined)
      // keeps legacy exact behavior for tests/seeds.
      const clauses = [eq(agents.id, id)];
      if (workspaceId !== undefined && workspaceId !== null) clauses.push(eq(agents.workspaceId, workspaceId));
      const record = await dbOverride.query.agents.findFirst({
        where: and(...clauses),
      });
      return record ? mapAgentProfile(record) : null;
    } catch (err) {
      // Unprovisioned tenant schema (stale BYODB): fall through to local-first.
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[agents] tenant PG schema missing; getById served locally`);
    }
    }
    // Tenant scope first: the local store resolves the row inside the caller's
    // workspace folder; PG only fills the gap when local has nothing. Without
    // this, duplicate ids across workspace folders resolve to the first match.
    // A caller that named a scope never falls back to the unscoped fan-out
    // read (scopesFor(undefined) probes every workspace folder) — that
    // fallback is how a foreign workspace's agent was read and then deleted.
    // Unscoped resolution stays for explicit legacy callers (workspaceId
    // undefined), where the scoped read above already fans out.
    const scoped = (await localGetAgent(id, workspaceId).catch((err) => {
      console.warn("[agents] Scoped local read failed:", err instanceof Error ? err.message : err);
      return null;
    })) as AgentProfile | null;
    if (scoped) return scoped;
    // PG leg honors the same tenant (scoped + legacy-global rows, mirroring
    // loadRoster); unscoped undefined keeps the legacy first-match read.
    const pgWhere =
      workspaceId !== undefined && workspaceId !== null
        ? and(eq(agents.id, id), or(eq(agents.workspaceId, workspaceId), isNull(agents.workspaceId)))
        : eq(agents.id, id);
    // AGT-001: a named scope's PG gap-fill must run on the workspace's own
    // record handle — the ambient pool (ALS-less socket/worker scopes) can be
    // a different database entirely in split-DB deployments.
    const pgHandle = await this.pgHandleFor(workspaceId);
    const pgRecord = await pgCatchNull(() =>
      (pgHandle ?? getDb()).query.agents.findFirst({
        where: pgWhere,
      }),
    );
    return pgRecord ? mapAgentProfile(pgRecord) : null;
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
      // AGT-008: same PG column as update's pgSet — without it a dual-tier
      // create dropped the cap on the PG tier (migration 0027).
      contextTokenCap: input.contextTokenCap ?? null,
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
        contextTokenCap: input.contextTokenCap,
      });

    // Explicit handle pins PG exactly (tests/seeds/replay) with full validation.
    if (dbOverride) {
      await this.ensureValidReferences(input, undefined, dbOverride);
      await runWithDb(dbOverride, () =>
        withTransaction(async (tx) => {
          await tx.insert(agents).values(row);
          await tx.insert(runtimeStates).values({
            sessionId: `session-${agentId}`,
            agentId,
            status: input.status === "offline" ? "offline" : "idle",
            lastHeartbeat: now,
            createdAt: now,
          });
        }),
      );
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
      // module ids against the local store, seeding the canon instruction
      // default when missing (no model default is seeded: zero providers by
      // contract), so "Launch Assembly" works before any module is created.
      const { moduleGate, DEFAULT_INSTRUCTION_MODULE_ID } = await import("../modules/module-gate.js");
      await moduleGate.ensureDefaults(input.workspaceId ?? null);
      if (input.instructionModuleId === DEFAULT_INSTRUCTION_MODULE_ID || !(await moduleGate.instruction.get(input.instructionModuleId, input.workspaceId))) {
        if (input.instructionModuleId !== DEFAULT_INSTRUCTION_MODULE_ID) {
          console.warn(`[agents] instruction module ${input.instructionModuleId} missing locally; falling back to ${DEFAULT_INSTRUCTION_MODULE_ID}`);
        }
        input = { ...input, instructionModuleId: DEFAULT_INSTRUCTION_MODULE_ID };
      }
      if (input.modelModuleId && !(await moduleGate.model.get(input.modelModuleId, input.workspaceId))) {
        console.warn(`[agents] model module ${input.modelModuleId} missing locally; clearing reference`);
        input = { ...input, modelModuleId: null };
      }
    }
    if (tier === "dual") {
      // Best-effort PG validation — skips itself when the database is gone.
      await this.ensureValidReferences(input, undefined).catch((err) => {
        if (!isConnectionError(err)) throw err;
        console.warn("[agents] PG unreachable during create validation; local write proceeds:", err.message);
      });
    }
    const created = await dualWrite({
      ctx,
      entity: "agent",
      op: "upsert",
      id: agentId,
      row: { ...row, createdAt: now.toISOString(), updatedAt: now.toISOString() },
      pgWrite: async () => {
        await withTransaction(async (tx) => {
          await tx.insert(agents).values(row);
          await tx.insert(runtimeStates).values({
            sessionId: `session-${agentId}`,
            agentId,
            status: input.status === "offline" ? "offline" : "idle",
            lastHeartbeat: now,
            createdAt: now,
          });
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
    if (workspaceId !== undefined) {
      input = { ...input, workspaceId: input.workspaceId ?? workspaceId };
    }
    const existing = await this.getById(id, dbOverride, workspaceId);
    if (!existing) {
      return null;
    }

    // Nullable clears (update schema .nullable()): null flows through merged
    // into pgSet (?? null persists the clear) and localApply (null = clear
    // in localUpsertAgent). Only undefined keeps the existing value.
    const merged: NullableAgentMerge = {
      workspaceId: input.workspaceId ?? existing.workspaceId ?? null,
      name: input.name ?? existing.name,
      title: input.title ?? existing.title,
      species: input.species !== undefined ? input.species : existing.species,
      avatar: input.avatar !== undefined ? input.avatar : existing.avatar,
      authorityLevel: input.authorityLevel ?? existing.authorityLevel,
      l3Subtype: input.l3Subtype !== undefined ? input.l3Subtype : existing.l3Subtype,
      // AGT-009: null clears, undefined keeps. (Was ?? which kept on null.)
      modelModuleId: input.modelModuleId !== undefined ? input.modelModuleId : existing.modelModuleId,
      instructionModuleId: input.instructionModuleId !== undefined ? input.instructionModuleId : existing.instructionModuleId,
      toolkitModuleId: input.toolkitModuleId !== undefined ? input.toolkitModuleId : existing.toolkitModuleId,
      constraintsModuleId:
        input.constraintsModuleId !== undefined ? input.constraintsModuleId : existing.constraintsModuleId,
      capabilitiesModuleId:
        input.capabilitiesModuleId !== undefined ? input.capabilitiesModuleId : existing.capabilitiesModuleId,
      memorySharingPolicy: input.memorySharingPolicy ?? existing.memorySharingPolicy,
      isOmniscient: input.isOmniscient ?? existing.isOmniscient,
      fallbackAgentId: input.fallbackAgentId !== undefined ? input.fallbackAgentId : existing.fallbackAgentId,
      categoryPermissions: input.categoryPermissions ?? existing.categoryPermissions,
      permissions: normalizePermissions(input.permissions, existing.permissions),
      status: input.status ?? existing.status,
      isTemplate: input.isTemplate ?? existing.isTemplate,
      contextTokenCap: input.contextTokenCap !== undefined ? input.contextTokenCap : existing.contextTokenCap,
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
      // AGT-008: persisted via migration 0027 (was local-only).
      contextTokenCap: merged.contextTokenCap ?? null,
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
        contextTokenCap: merged.contextTokenCap,
      });

    // Cross-field invariants are cheap and local: they run on EVERY update,
    // not just the dual tier (local tier previously skipped them entirely).
    // Reference-existence checks stay tier-gated below — they need PG/local
    // module stores and only matter where the merged row is written.
    this.assertInvariants(merged, id);

    // Explicit handle pins PG exactly (tests/seeds/replay) with full validation.
    if (dbOverride) {
      await this.ensureValidReferences(merged, id, dbOverride);
      const clauses = [eq(agents.id, id)];
      if (workspaceId !== undefined && workspaceId !== null) clauses.push(eq(agents.workspaceId, workspaceId));
      await runWithDb(dbOverride, () =>
        withTransaction(async (tx) => {
          await tx.update(agents).set(pgSet).where(and(...clauses));
          // AGT-014: presence belongs to setStatus. A title-only edit must
          // not flip a working agent to idle.
          if (input.status !== undefined) {
            await tx
              .update(runtimeStates)
              .set({
                status: merged.status === "offline" ? "offline" : "idle",
                lastHeartbeat: new Date(),
              })
              .where(eq(runtimeStates.agentId, id));
          }
        }),
      );
      if (input.toolkitModuleId !== undefined || input.permissions !== undefined) {
        skillsGate.invalidateAgentCaches(id);
      }
      invalidateRosterCache();
      return this.getById(id, dbOverride, workspaceId);
    }

    // Dual-boot: validate against PG only when it will actually be written.
    const ctx = await tierContextFor(merged.workspaceId ?? null);
    // AGT-001: outside ALS (socket/worker scopes) the ambient getDb() can be a
    // different database than the workspace's record DB — bind the owning
    // workspace's handle for the validation and replica legs. Inside ALS the
    // resolver returns null (getDb() is already the tenant handle).
    const pgHandle = await this.pgHandleFor(merged.workspaceId ?? null);
    if (resolveTier(ctx).tier === "dual") {
      await this.ensureValidReferences(merged, id, pgHandle ?? undefined).catch((err) => {
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
        const write = () =>
          withTransaction(async (tx) => {
            await tx.update(agents).set(pgSet).where(eq(agents.id, id));
            // AGT-014: same guard as the explicit-handle leg above.
            if (input.status !== undefined) {
              await tx
                .update(runtimeStates)
                .set({
                  status: merged.status === "offline" ? "offline" : "idle",
                  lastHeartbeat: new Date(),
                })
                .where(eq(runtimeStates.agentId, id));
            }
          });
        // AGT-001: the replica leg lands on the owning workspace's record DB
        // when one resolved; the ambient pool is the fallback only.
        await (pgHandle ? runWithDb(pgHandle, write) : write());
      },
      localWrite: localApply,
    });

    if (input.toolkitModuleId !== undefined || input.permissions !== undefined) {
      skillsGate.invalidateAgentCaches(id);
    }
    invalidateRosterCache();
    // AGT-001: re-read inside the owning workspace's scope (the caller may not
    // have named one) so the just-committed row is read back from the same
    // handle the replica leg wrote — never a stale ambient-pool read.
    return this.getById(id, undefined, workspaceId !== undefined ? workspaceId : (merged.workspaceId ?? null));
  }

  async delete(id: string, dbOverride?: any, workspaceId?: string | null): Promise<boolean> {
    if (dbOverride) {
      const clauses = [eq(agents.id, id)];
      if (workspaceId !== undefined && workspaceId !== null) clauses.push(eq(agents.workspaceId, workspaceId));
      const result = await runWithDb(dbOverride, () =>
        withTransaction(async (tx) => {
          const deleted = await tx.delete(agents).where(and(...clauses)).returning({ id: agents.id });
          // AGT-005: no in-tx catch. Swallowing a cascade failure inside the
          // transaction could roll back the agent delete itself or orphan
          // the ledger row with a success signal. Let it propagate.
          await tx
            .delete(runtimeStates)
            .where(eq(runtimeStates.agentId, id));
          return deleted;
        }),
      );
      invalidateRosterCache();
      return result.length > 0;
    }
    // Scoped read: duplicate ids across workspaces must delete the caller's row.
    const existing = await this.getById(id, undefined, workspaceId);
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
      pgWrite: () =>
        withTransaction(async (tx) => {
          await tx.delete(agents).where(eq(agents.id, id));
          // AGT-005: propagate (see explicit-handle leg above).
          await tx
            .delete(runtimeStates)
            .where(eq(runtimeStates.agentId, id));
        }),
      // Scope the local delete to the owning workspace folder: duplicate ids
      // across workspaces must not delete the first file that matches.
      localWrite: () => localDeleteAgent(id, existing.workspaceId ?? null),
    });
    invalidateRosterCache();
    return removed;
  }

  /** Sole owner write for `agents.status` + `runtime_states`: atomic flip + heartbeat + `agent:status`. */
  /**
   * XD-015: atomic instruction-stack replacement (sibling of SK-001).
   * The studio manifest path did route-owned delete+insert with no
   * transaction — a mid-write failure left the stack half-replaced.
   */
  async replaceInstructionStack(agentId: string, instructionModuleIds: string[]): Promise<void> {
    await withTransaction(async (tx: any) => {
      await tx.delete(agentInstructionStacks).where(eq(agentInstructionStacks.agentId, agentId));
      if (instructionModuleIds.length > 0) {
        const now = Date.now().toString(36);
        await tx.insert(agentInstructionStacks).values(
          instructionModuleIds.map((mid, i) => ({
            id: `ais_${agentId}_${i + 1}_${now}`,
            agentId,
            instructionModuleId: mid,
            priorityOrder: (i + 1) * 10,
            isEnabled: true,
          }))
        );
      }
    });
    invalidateRosterCache();
  }

  async setStatus(
    agentId: string,
    status: RuntimeStatus,
    opts: { broker?: EventBroker; db?: any; errorInfo?: { code: string; message: string }; workspaceId?: string | null } = {}
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
      const agent = await this.getById(agentId, opts.db, opts.workspaceId).catch((err) => {
        console.warn("[agents] Status context read failed:", err instanceof Error ? err.message : err);
        return null;
      });
      const ownerWorkspaceId = agent?.workspaceId ?? opts.workspaceId ?? null;
      const ctx = await tierContextFor(ownerWorkspaceId);
      // AGT-001: outside ALS (socket/worker scopes) the ambient getDb() can be
      // a different database than the owning workspace's record DB — bind that
      // handle for the PG flip so the replica row lands in the right DB.
      const pgHandle = await this.pgHandleFor(ownerWorkspaceId);
      await dualWrite({
        ctx,
        entity: "agent",
        op: "upsert",
        id: agentId,
        // Status-only row: replay re-flips PG status (presence, not content).
        row: { status, updatedAt: new Date().toISOString() } as Record<string, unknown>,
        pgWrite: () => {
          const write = () =>
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
            });
          return pgHandle ? runWithDb(pgHandle, write) : write();
        },
        localWrite: async () => {
          const ok = await localSetAgentStatus(agentId, status, ownerWorkspaceId);
          if (!ok) console.warn(`[agents] setStatus local flip missed: no file for ${agentId}`);
        },
      });
    }

    invalidateRosterCache(); // status flips must not serve 30s-stale rosters
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
          // Re-verify inside the UPDATE (status='working' AND heartbeat
          // expired): a heartbeat landing between the locked SELECT and this
          // write must not be stomped, and nothing downstream may emit.
          const pausedRows = await db
            .update(runtimeStates)
            .set({ status: "paused", errorInfo: { code: "ORPHANED", message: "Heartbeat expired; run presumed dead.", timestamp: new Date().toISOString() } })
            .where(
              and(
                eq(runtimeStates.agentId, state.agentId),
                eq(runtimeStates.status, "working"),
                lt(runtimeStates.lastHeartbeat, cutoff),
              ),
            )
            .returning({ agentId: runtimeStates.agentId });
          if (pausedRows.length === 0) continue;
          console.warn(`[Heartbeat] Orphaned 'working' agent ${state.agentId} detected (no heartbeat since ${state.lastHeartbeat?.toISOString?.() ?? "never"}) — pausing.`);
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, state.agentId));
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
    if (paused > 0) invalidateRosterCache(); // swept statuses must show immediately
    return paused;
  }

  /** Cross-field invariants: no DB, safe to run on every write (any tier). */
  private assertInvariants(input: CreateAgentProfileInput | NullableAgentMerge, currentAgentId?: string): void {
    if (input.l3Subtype && input.authorityLevel !== 3) {
      throw new Error("Only authority level 3 agents may define an l3Subtype.");
    }

    if (input.fallbackAgentId && input.fallbackAgentId === currentAgentId) {
      throw new Error("An agent cannot fallback to itself.");
    }
  }

  private async ensureValidReferences(input: CreateAgentProfileInput | NullableAgentMerge, currentAgentId?: string, dbOverride?: any, workspaceId?: string | null): Promise<void> {
    const db = dbOverride || getDb();

    this.assertInvariants(input, currentAgentId);

    // Modules owns module rows: validate via gate (dynamic import avoids Agents↔Modules↔Runtime cycle).
    // Workspace threads through so local-tier references validate against the
    // local store instead of throwing DATABASE_URL (see module-service).
    // Undefined (never null) preserves the legacy PG path for tests/seeds.
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
      workspaceId ?? input.workspaceId,
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

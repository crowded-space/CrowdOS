import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb, dbScopeKey, withTransaction } from "../shared/config/database.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import { skills, agentSkills, agents, toolkitModules } from "../db/schema.js";
import type { SkillDefinition, SkillWorkflowPattern, CreateSkillInput, UpdateSkillInput } from "./skill-types.js";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

type FewShotExample = NonNullable<SkillDefinition["promptLayer"]["fewShotExamples"]>[number];

function toFewShotExample(value: unknown): FewShotExample | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.scenario !== "string" || typeof v.thoughtProcess !== "string" || typeof v.expectedOutcome !== "string") {
    return null;
  }
  const actions: FewShotExample["actions"] = [];
  if (Array.isArray(v.actions)) {
    for (const raw of v.actions) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (typeof a.tool === "string" && a.args && typeof a.args === "object" && !Array.isArray(a.args)) {
        actions.push({ tool: a.tool, args: a.args as Record<string, unknown> });
      }
    }
  }
  return { scenario: v.scenario, thoughtProcess: v.thoughtProcess, actions, expectedOutcome: v.expectedOutcome };
}

function toPromptLayer(value: unknown): SkillDefinition["promptLayer"] {
  if (!value || typeof value !== "object") {
    return { systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] };
  }
  const v = value as Record<string, unknown>;
  return {
    systemPromptAdditions: asStringArray(v.systemPromptAdditions),
    executionGuidelines: asStringArray(v.executionGuidelines),
    fewShotExamples: Array.isArray(v.fewShotExamples)
      ? v.fewShotExamples.map(toFewShotExample).filter((e): e is FewShotExample => e !== null)
      : [],
  };
}

function mapSkill(row: typeof skills.$inferSelect): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category || "general",
    icon: row.icon || "⚡",
    promptLayer: toPromptLayer(row.promptLayer),
    requiredToolIds: row.requiredTools || [],
    optionalToolIds: row.optionalTools || [],
    recommendedModels: row.recommendedModels || [],
    workflowPattern: (row.workflowPattern as SkillWorkflowPattern) || "react",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SkillService {
  // Hot-path caches: these reads run multiple times per agent turn (context
  // assembly + every tool authorization). Short TTL + explicit invalidation on
  // any mutation keeps authorization fresh.
  private readonly agentSkillsCache = new TtlCache<SkillDefinition[]>(30_000, 500);
  private readonly resolvedToolsCache = new TtlCache<string[]>(30_000, 500);

  invalidateAgentCaches(agentId?: string): void {
    // Keys carry the tenant scope. The no-id clear is scope-agnostic and can
    // only cause extra misses, never stale reads.
    // SK-003: per-agent invalidation must NOT assume the writer shares the
    // reader's scope (workers/sockets run outside ALS; handles rotate) —
    // suffix-match across all scopes; extra misses beat stale authz for the
    // 30s TTL window.
      if (agentId) {
        // Resolved-tools keys carry the workspace scope between the tenant
        // scope and the agent id; match the id suffix across all scopes.
        const suffix = `:${agentId}`;
        this.agentSkillsCache.invalidateSuffix(suffix);
        this.resolvedToolsCache.invalidateSuffix(suffix);
      } else {
        this.agentSkillsCache.clear();
        this.resolvedToolsCache.clear();
      }
  }

  async list(filters?: { category?: string; limit?: number }): Promise<SkillDefinition[]> {
    const db = getDb();
    let whereClause = undefined;
    if (filters?.category) {
      whereClause = eq(skills.category, filters.category);
    }
    const limit = Math.min(Math.max(filters?.limit ?? 100, 1), 200);
    const rows = await db.query.skills.findMany({
      where: whereClause,
      orderBy: (table, { asc }) => [asc(table.name)],
      limit,
    });
    return rows.map(mapSkill);
  }

  async getById(id: string): Promise<SkillDefinition | null> {
    const db = getDb();
    const row = await db.query.skills.findFirst({
      where: eq(skills.id, id),
    });
    return row ? mapSkill(row) : null;
  }

  async create(input: CreateSkillInput): Promise<SkillDefinition> {
    const db = getDb();
    const id = `skill_${randomUUID()}`;
    const now = new Date();

    const [inserted] = await db.insert(skills).values({
      id,
      name: input.name,
      description: input.description,
      category: input.category || "general",
      icon: input.icon || "⚡",
      promptLayer: {
        systemPromptAdditions: input.promptLayer?.systemPromptAdditions || [],
        executionGuidelines: input.promptLayer?.executionGuidelines || [],
        fewShotExamples: input.promptLayer?.fewShotExamples || [],
      },
      requiredTools: input.requiredToolIds || [],
      optionalTools: input.optionalToolIds || [],
      recommendedModels: input.recommendedModels || [],
      workflowPattern: input.workflowPattern || "react",
      createdAt: now,
      updatedAt: now,
    }).returning();

    this.invalidateAgentCaches();
    return mapSkill(inserted);
  }

  async update(id: string, input: UpdateSkillInput): Promise<SkillDefinition | null> {
    const db = getDb();
    const existing = await this.getById(id);
    if (!existing) return null;

    const setValues: Record<string, any> = { updatedAt: new Date() };
    if (input.name !== undefined) setValues.name = input.name;
    if (input.description !== undefined) setValues.description = input.description;
    if (input.category !== undefined) setValues.category = input.category;
    if (input.icon !== undefined) setValues.icon = input.icon;
    if (input.promptLayer !== undefined) {
      setValues.promptLayer = {
        systemPromptAdditions: input.promptLayer.systemPromptAdditions ?? existing.promptLayer.systemPromptAdditions,
        executionGuidelines: input.promptLayer.executionGuidelines ?? existing.promptLayer.executionGuidelines,
        fewShotExamples: input.promptLayer.fewShotExamples ?? existing.promptLayer.fewShotExamples ?? [],
      };
    }
    if (input.requiredToolIds !== undefined) setValues.requiredTools = input.requiredToolIds;
    if (input.optionalToolIds !== undefined) setValues.optionalTools = input.optionalToolIds;
    if (input.recommendedModels !== undefined) setValues.recommendedModels = input.recommendedModels;
    if (input.workflowPattern !== undefined) setValues.workflowPattern = input.workflowPattern;

    const [updated] = await db.update(skills)
      .set(setValues)
      .where(eq(skills.id, id))
      .returning();

    this.invalidateAgentCaches();
    return updated ? mapSkill(updated) : null;
  }

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const result = await db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
    this.invalidateAgentCaches();
    return result.length > 0;
  }

  async getAgentSkills(agentId: string, workspaceId?: string | null): Promise<SkillDefinition[]> {
    const key = `${dbScopeKey()}:${agentId}`;
    const cached = this.agentSkillsCache.get(key);
    if (cached) return cached;

    // Local-only parity: without a database there are no database-backed
    // skill assignments; Markdown skills resolve through their own store.
    // Fail closed to empty rather than throwing past the tool path.
    try {
      const db = getDb();
      const links = await db.query.agentSkills.findMany({
        where: and(eq(agentSkills.agentId, agentId), eq(agentSkills.isEnabled, true)),
      });
      if (links.length === 0) {
        this.agentSkillsCache.set(key, []);
        return [];
      }

      const skillIds = links.map(l => l.skillId);
      const skillRows = await db.query.skills.findMany({
        where: (table, { inArray }) => inArray(table.id, skillIds),
      });

      const result = skillRows.map(mapSkill);
      this.agentSkillsCache.set(key, result);
      return result;
    } catch {
      return [];
    }
  }

  async assignSkill(agentId: string, skillId: string): Promise<void> {
    const db = getDb();
    const existing = await db.query.agentSkills.findFirst({
      where: and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)),
    });
    if (existing) {
      await db.update(agentSkills).set({ isEnabled: true }).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)));
    } else {
      try {
        await db.insert(agentSkills).values({
          agentId,
          skillId,
          isEnabled: true,
        });
      } catch (err) {
        // Concurrent assign race: PK already inserted — idempotent re-enable.
        if ((err as { code?: string })?.code === "23505") {
          await db.update(agentSkills).set({ isEnabled: true }).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)));
        } else {
          throw err;
        }
      }
    }
    this.invalidateAgentCaches(agentId);
  }

  async removeSkill(agentId: string, skillId: string): Promise<boolean> {
    const db = getDb();
    const result = await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId))).returning({ skillId: agentSkills.skillId });
    this.invalidateAgentCaches(agentId);
    return result.length > 0;
  }

  /**
   * SK-001: atomic all-or-nothing skill replacement. The studio manifest
   * path used to delete-then-insert from the route with no transaction, so
   * a mid-write failure wiped the agent's skill links. Route callers must
   * use this port instead of writing `agentSkills` directly.
   */
  async replaceAgentSkills(agentId: string, skillIds: string[]): Promise<void> {
    await withTransaction(async (tx: any) => {
      await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
      if (skillIds.length > 0) {
        await tx.insert(agentSkills).values(
          skillIds.map((skillId) => ({ agentId, skillId, isEnabled: true }))
        );
      }
    });
    this.invalidateAgentCaches(agentId);
  }

  async getResolvedToolsForAgent(agentId: string, workspaceId?: string | null): Promise<string[]> {
    const scope = workspaceId?.trim() || "default";
    const key = `${dbScopeKey()}:${scope}:${agentId}`;
    const cached = this.resolvedToolsCache.get(key);
    if (cached) return cached;

    const toolIds = new Set<string>();

    // 1. Direct grants from agent.toolkitModuleId. The ambient/bound handle
    // wins when one resolves (split-DB tenant scope binds it via runWithDb
    // and the executor passes the resolved workspace handle); otherwise
    // resolve the agent through the owning gate so Local-only callers
    // authorize without a database. Toolkit rows follow the same precedence
    // through the Modules gate.
    let toolkitModuleId: string | null | undefined;
    let db: ReturnType<typeof getDb> | null = null;
    try {
      db = getDb();
    } catch {
      db = null;
    }
    if (db) {
      try {
        const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
        toolkitModuleId = agent?.toolkitModuleId;
        if (toolkitModuleId) {
          const toolkit = await db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, toolkitModuleId) });
          const tools = (toolkit as { tools?: unknown } | null)?.tools;
          if (Array.isArray(tools)) {
            for (const t of tools) if (typeof t === "string") toolIds.add(t);
          }
        }
      } catch {
        db = null;
      }
    }
    if (!db) {
      // No database handle (Local-only): resolve through the owning gates.
      const { agentGate } = await import("../agents/agent-gate.js");
      const agent = await agentGate.getById(agentId, undefined, workspaceId).catch(() => null);
      toolkitModuleId = (agent as { toolkitModuleId?: string | null } | null)?.toolkitModuleId;
      if (toolkitModuleId) {
        try {
          const { moduleGate } = await import("../modules/module-gate.js");
          const toolkit = await moduleGate.toolkit.get(toolkitModuleId, workspaceId);
          const tools = (toolkit as { tools?: unknown } | null)?.tools;
          if (Array.isArray(tools)) {
            for (const t of tools) if (typeof t === "string") toolIds.add(t);
          }
        } catch {
          // Local miss: fall through to skills + universals.
        }
      }
    }

    // 2. Inherited tool requirements from active skills (required + optional)
    const activeSkills = await this.getAgentSkills(agentId, workspaceId);
    for (const skill of activeSkills) {
      if (skill.requiredToolIds) {
        for (const t of skill.requiredToolIds) toolIds.add(t);
      }
      if (skill.optionalToolIds) {
        for (const t of skill.optionalToolIds) toolIds.add(t);
      }
    }

    // 3. Universal tools, filtered through the live registry when available.
    // Fail-open with warn when the registry cannot be reached (offline/boot):
    // granting the verbs is safe — per-call authorization still enforced in
    // ToolExecutor — while advertising vapor tools is not.
    // SK-008: single source of truth lives in tools-gate (UNIVERSAL_TOOL_IDS).
    // SK-008: single source of truth lives in tools-gate (UNIVERSAL_TOOL_IDS).
    // Lazy dynamic import: a static import creates a skills->tools import
    // cycle that breaks suites loading mention-parser->socket->registry.
    let UNIVERSAL_TOOLS: string[];
    try {
      const mod = await import("../tools/tools-gate.js");
      UNIVERSAL_TOOLS = (mod as { UNIVERSAL_TOOL_IDS?: string[] }).UNIVERSAL_TOOL_IDS ?? [
        "open_memory",
        "discard_memory_from_context",
        "remember",
        "lock_in",
        "lock_out",
        "open_detail",
        "load_skill",
      ];
    } catch {
      UNIVERSAL_TOOLS = [
        "open_memory",
        "discard_memory_from_context",
        "remember",
        "lock_in",
        "lock_out",
        "open_detail",
        "load_skill",
      ];
    }
    try {
      const { toolsGate } = await import("../tools/tools-gate.js");
      for (const t of UNIVERSAL_TOOLS) {
        try {
          if (toolsGate.has(t)) toolIds.add(t);
        } catch {
          toolIds.add(t);
        }
      }
    } catch (err) {
      console.warn("[skillService] tools registry unavailable, granting universals fail-open:", (err as Error)?.message ?? err);
      for (const t of UNIVERSAL_TOOLS) toolIds.add(t);
    }

    const result = Array.from(toolIds);
    this.resolvedToolsCache.set(key, result);
    return result;
  }
}

export const skillService = new SkillService();

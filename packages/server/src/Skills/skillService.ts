import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { TtlCache } from "../Shared/core/ttlCache.js";
import { skills, agentSkills, agents, toolkitModules } from "../db/schema.js";
import type { SkillDefinition, CreateSkillInput, UpdateSkillInput } from "./skillTypes.js";

function mapSkill(row: any): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category || "general",
    icon: row.icon || "⚡",
    promptLayer: row.promptLayer || { systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] },
    requiredToolIds: row.requiredTools || [],
    optionalToolIds: row.optionalTools || [],
    recommendedModels: row.recommendedModels || [],
    workflowPattern: (row.workflowPattern as any) || "react",
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
    if (agentId) {
      this.agentSkillsCache.delete(agentId);
      this.resolvedToolsCache.delete(agentId);
    } else {
      this.agentSkillsCache.clear();
      this.resolvedToolsCache.clear();
    }
  }

  async list(filters?: { category?: string }): Promise<SkillDefinition[]> {
    const db = getDb();
    let whereClause = undefined;
    if (filters?.category) {
      whereClause = eq(skills.category, filters.category);
    }
    const rows = await db.query.skills.findMany({
      where: whereClause,
      orderBy: (table, { asc }) => [asc(table.name)],
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
    const id = `skill_${randomUUID().slice(0, 8)}`;
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
        systemPromptAdditions: input.promptLayer.systemPromptAdditions || existing.promptLayer.systemPromptAdditions,
        executionGuidelines: input.promptLayer.executionGuidelines || existing.promptLayer.executionGuidelines,
        fewShotExamples: input.promptLayer.fewShotExamples || existing.promptLayer.fewShotExamples,
      };
    }
    if (input.requiredToolIds !== undefined) setValues.requiredTools = input.requiredToolIds;
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

  async getAgentSkills(agentId: string): Promise<SkillDefinition[]> {
    const cached = this.agentSkillsCache.get(agentId);
    if (cached) return cached;

    const db = getDb();
    const links = await db.query.agentSkills.findMany({
      where: and(eq(agentSkills.agentId, agentId), eq(agentSkills.isEnabled, true)),
    });
    if (links.length === 0) {
      this.agentSkillsCache.set(agentId, []);
      return [];
    }

    const skillIds = links.map(l => l.skillId);
    const skillRows = await db.query.skills.findMany({
      where: (table, { inArray }) => inArray(table.id, skillIds),
    });

    const result = skillRows.map(mapSkill);
    this.agentSkillsCache.set(agentId, result);
    return result;
  }

  async assignSkill(agentId: string, skillId: string): Promise<void> {
    const db = getDb();
    const existing = await db.query.agentSkills.findFirst({
      where: and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)),
    });
    if (existing) {
      await db.update(agentSkills).set({ isEnabled: true }).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)));
    } else {
      await db.insert(agentSkills).values({
        agentId,
        skillId,
        isEnabled: true,
      });
    }
    this.invalidateAgentCaches(agentId);
  }

  async removeSkill(agentId: string, skillId: string): Promise<void> {
    const db = getDb();
    await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)));
    this.invalidateAgentCaches(agentId);
  }

  async getResolvedToolsForAgent(agentId: string): Promise<string[]> {
    const cached = this.resolvedToolsCache.get(agentId);
    if (cached) return cached;

    const db = getDb();
    const toolIds = new Set<string>();

    // 1. Direct grants from agent.toolkitModuleId
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (agent?.toolkitModuleId) {
      const toolkit = await db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, agent.toolkitModuleId) });
      if (toolkit?.tools) {
        for (const t of toolkit.tools) toolIds.add(t);
      }
    }

    // 2. Inherited tool requirements from active skills
    const activeSkills = await this.getAgentSkills(agentId);
    for (const skill of activeSkills) {
      if (skill.requiredToolIds) {
        for (const t of skill.requiredToolIds) toolIds.add(t);
      }
    }

    // 3. Universal memory tools
    toolIds.add("open_memory");
    toolIds.add("discard_memory_from_context");
    toolIds.add("remember");

    // 4. Universal context-awareness tools (always available for tool-capable runtimes)
    toolIds.add("lock_in");
    toolIds.add("lock_out");

    const result = Array.from(toolIds);
    this.resolvedToolsCache.set(agentId, result);
    return result;
  }
}

export const skillService = new SkillService();

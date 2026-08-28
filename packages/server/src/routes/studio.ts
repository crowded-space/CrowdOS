import type { FastifyInstance } from "fastify";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import {
  agents,
  agentInstructionStacks,
  agentSkills,
  modelModules,
  toolkitModules,
  constraintsModules,
} from "../db/schema.js";
import { skillsGate } from "../Skills/skillsGate.js";
import { toolsGate } from "../tools/toolsGate.js";
import { contextPipeline, runtimeGate } from "../runtime/contextGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";
import { redactSecrets, redactApiKeyFields } from "../Shared/core/redact.js";
import { authGate } from "../Shared/auth/authGate.js";

export async function studioRoutes(app: FastifyInstance) {
  // SEC-1: every /api/studio/* route requires an admin API key (strict mode).
  app.addHook("preHandler", authGate.requireAdmin);

  // GET /api/studio/agents/:id/manifest
  app.get<{ Params: { id: string } }>(
    "/api/studio/agents/:id/manifest",
    async (request, reply) => {
      const db = getDb();
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, request.params.id),
      });

      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      // 1. Model Slot — redact apiKey before returning (P0-2)
      let modelModule: any = null;
      if (agent.modelModuleId) {
        const raw = await db.query.modelModules.findFirst({
          where: eq(modelModules.id, agent.modelModuleId),
        });
        modelModule = raw ? redactApiKeyFields(raw as Record<string, unknown>) : null;
      }

      // 2. Instruction Stack
      const stackLinks = await db.query.agentInstructionStacks.findMany({
        where: and(
          eq(agentInstructionStacks.agentId, agent.id),
          eq(agentInstructionStacks.isEnabled, true)
        ),
        orderBy: [asc(agentInstructionStacks.priorityOrder)],
        with: {
          instructionModule: true,
        },
      });

      const instructionStack = stackLinks.map(l => ({
        id: l.id,
        moduleId: l.instructionModuleId,
        priorityOrder: l.priorityOrder,
        module: l.instructionModule,
      }));

      // 3. Active Skills
      const activeSkills = await skillsGate.getAgentSkills(agent.id);

      // 4. Resolved Tools
      const resolvedToolIds = await skillsGate.getResolvedToolsForAgent(agent.id);
      const tools = resolvedToolIds.map(tid => toolsGate.get(tid)).filter(Boolean);

      // 5. Constraints
      let constraintsModule = null;
      if (agent.constraintsModuleId) {
        constraintsModule = await db.query.constraintsModules.findFirst({
          where: eq(constraintsModules.id, agent.constraintsModuleId),
        });
      }

      // 6. Toolkit Module
      let toolkitModule = null;
      if (agent.toolkitModuleId) {
        toolkitModule = await db.query.toolkitModules.findFirst({
          where: eq(toolkitModules.id, agent.toolkitModuleId),
        });
      }

      return {
        identity: {
          id: agent.id,
          name: agent.name,
          title: agent.title,
          species: agent.species,
          avatar: agent.avatar,
          authorityLevel: agent.authorityLevel,
          l3Subtype: agent.l3Subtype,
          status: agent.status,
          isTemplate: agent.isTemplate,
          memorySharingPolicy: agent.memorySharingPolicy,
        },
        slots: {
          model: modelModule,
          instructionStack,
          skills: activeSkills,
          tools,
          toolkit: toolkitModule,
          constraints: constraintsModule,
        },
      };
    }
  );

  // PUT /api/studio/agents/:id/manifest
  app.put<{
    Params: { id: string };
    Body: {
      modelModuleId?: string;
      instructionModuleIds?: string[];
      skillIds?: string[];
      toolkitModuleId?: string;
      constraintsModuleId?: string;
    };
  }>(
    "/api/studio/agents/:id/manifest",
    async (request, reply) => {
      const db = getDb();
      const agentId = request.params.id;
      const { modelModuleId, instructionModuleIds, skillIds, toolkitModuleId, constraintsModuleId } = request.body;

      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      // 1. Update Agent FKs
      const agentUpdates: Record<string, any> = { updatedAt: new Date() };
      if (modelModuleId !== undefined) agentUpdates.modelModuleId = modelModuleId;
      if (toolkitModuleId !== undefined) agentUpdates.toolkitModuleId = toolkitModuleId;
      if (constraintsModuleId !== undefined) agentUpdates.constraintsModuleId = constraintsModuleId;

      await db.update(agents).set(agentUpdates).where(eq(agents.id, agentId));

      // 2. Update Instruction Stack if provided
      if (instructionModuleIds && Array.isArray(instructionModuleIds)) {
        await db.delete(agentInstructionStacks).where(eq(agentInstructionStacks.agentId, agentId));
        for (let i = 0; i < instructionModuleIds.length; i++) {
          await db.insert(agentInstructionStacks).values({
            id: `ais_${agentId}_${i + 1}_${Date.now().toString(36)}`,
            agentId,
            instructionModuleId: instructionModuleIds[i],
            priorityOrder: (i + 1) * 10,
            isEnabled: true,
          });
        }
      }

      // 3. Update Skills if provided
      if (skillIds && Array.isArray(skillIds)) {
        await db.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
        for (const skillId of skillIds) {
          await db.insert(agentSkills).values({
            agentId,
            skillId,
            isEnabled: true,
          });
        }
      }

      // Invalidate hot-path caches after direct manifest mutation (toolkit/skill/model refs)
      skillsGate.invalidateAgentCaches(agentId);
      runtimeGate.invalidateModelModuleCache();

      globalBroker?.emit("workspace:sync", {});
      return { success: true, message: "Agent manifest updated successfully." };
    }
  );

  // POST /api/studio/inspect-prompt
  app.post<{
    Body: {
      agentId: string;
      channelId?: string;
      userInput?: string;
      runtimeType?: any;
    };
  }>(
    "/api/studio/inspect-prompt",
    {
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const db = getDb();
      const { agentId, channelId = "general", userInput = "Hello, what is your current plan?", runtimeType = "agentic" } = request.body;

      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      const compiled = await contextPipeline.assemble({
        agent: agent as any,
        channelId,
        workspaceId: "default",
        userInput,
        runtimeType,
      });

      const totalChars = (compiled.systemPrompt?.length || 0) + (compiled.userInput?.length || 0);
      const tokenEstimate = Math.ceil(totalChars / 4);

      // Redact secrets from modelConfig and any leaked tokens (P0-2)
      const safeModelConfig = redactSecrets(compiled._modelConfig as unknown as Record<string, unknown>);
      return {
        agentName: agent.name,
        systemPrompt: compiled.systemPrompt,
        userPrompt: compiled.userInput,
        history: compiled.history,
        tools: compiled.tools,
        memoryPreviewBlock: compiled.memoryPreviewBlock,
        modelConfig: safeModelConfig,
        tokenEstimate,
      };
    }
  );
}

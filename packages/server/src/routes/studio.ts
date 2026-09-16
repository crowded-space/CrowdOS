import type { FastifyInstance } from "fastify";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import {
  agents,
  agentInstructionStacks,
  agentSkills,
  modelModules,
  toolkitModules,
  constraintsModules,
} from "../db/schema.js";
import { skillsGate } from "../skills/skills-gate.js";
import { toolsGate } from "../tools/tools-gate.js";
import { contextPipeline, runtimeGate } from "../runtime/context-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";
import { redactSecrets, redactApiKeyFields } from "../shared/core/redact.js";

export async function studioRoutes(app: FastifyInstance) {
  // Local-first: loopback is the trust boundary; no role gates (single user).

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

      // Manifest slots are independent once the agent row is known, so fetch them in one batch.
      const [rawModel, stackLinks, activeSkills, resolvedToolIds, constraintsModule, toolkitModule] = await Promise.all([
        agent.modelModuleId
          ? db.query.modelModules.findFirst({ where: eq(modelModules.id, agent.modelModuleId) })
          : Promise.resolve(null),
        db.query.agentInstructionStacks.findMany({
          where: and(
            eq(agentInstructionStacks.agentId, agent.id),
            eq(agentInstructionStacks.isEnabled, true)
          ),
          orderBy: [asc(agentInstructionStacks.priorityOrder)],
          with: { instructionModule: true },
        }),
        skillsGate.getAgentSkills(agent.id),
        skillsGate.getResolvedToolsForAgent(agent.id),
        agent.constraintsModuleId
          ? db.query.constraintsModules.findFirst({ where: eq(constraintsModules.id, agent.constraintsModuleId) })
          : Promise.resolve(null),
        agent.toolkitModuleId
          ? db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, agent.toolkitModuleId) })
          : Promise.resolve(null),
      ]);

      // 1. Model Slot — redact apiKey before returning (P0-2)
      const modelModule = rawModel ? redactApiKeyFields(rawModel as Record<string, unknown>) : null;

      // 2. Instruction Stack
      const instructionStack = stackLinks.map(l => ({
        id: l.id,
        moduleId: l.instructionModuleId,
        priorityOrder: l.priorityOrder,
        module: l.instructionModule,
      }));

      // 3 + 4. Skills resolved above; tool lookup is a sync registry read (no extra trip).
      const tools = resolvedToolIds.map(tid => toolsGate.get(tid)).filter(Boolean);

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
        if (instructionModuleIds.length > 0) {
          const now = Date.now().toString(36);
          await db.insert(agentInstructionStacks).values(
            instructionModuleIds.map((mid, i) => ({
              id: `ais_${agentId}_${i + 1}_${now}`,
              agentId,
              instructionModuleId: mid,
              priorityOrder: (i + 1) * 10,
              isEnabled: true,
            })),
          );
        }
      }

      // 3. Update Skills if provided
      if (skillIds && Array.isArray(skillIds)) {
        await db.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
        if (skillIds.length > 0) {
          await db.insert(agentSkills).values(
            skillIds.map((skillId) => ({
              agentId,
              skillId,
              isEnabled: true,
            })),
          );
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
      bodyLimit: 16_384,
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const db = getDb();
      const { agentId, channelId = "general", userInput = "Hello, what is your current plan?", runtimeType = "agentic" } = request.body;

      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      let compiled;
      try {
        compiled = await contextPipeline.assemble({
          agent: agent as any,
          channelId,
          workspaceId: "default",
          userInput,
          runtimeType,
          abortSignal: AbortSignal.timeout(15_000),
        });
      } catch (err: any) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          return reply.status(503).send({ statusCode: 503, error: "Service Unavailable", message: "Prompt inspection timed out" });
        }
        throw err;
      }

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

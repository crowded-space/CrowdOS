import type { FastifyInstance } from "fastify";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { agentInstructionStacks } from "../db/schema.js";
import { skillsGate } from "../skills/skills-gate.js";
import { agentGate } from "../agents/agent-gate.js";
import { moduleGate } from "../modules/module-gate.js";
import { toolsGate } from "../tools/tools-gate.js";
import { contextPipeline, runtimeGate } from "../runtime/context-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";
import { redactSecrets, redactApiKeyFields } from "../shared/core/redact.js";

function workspaceIdFrom(request: any): string | null {
  const workspaceId = request.workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

export async function studioRoutes(app: FastifyInstance) {
  // Local-first: loopback is the trust boundary; no role gates (single user).

  // GET /api/studio/agents/:id/manifest
  app.get<{ Params: { id: string } }>(
    "/api/studio/agents/:id/manifest",
    async (request, reply) => {
      const requestedWorkspaceId = workspaceIdFrom(request);
      const agent = await agentGate.getById(request.params.id, (request as any).db, requestedWorkspaceId);

      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      const db = (request as any).db ?? getDb();
      const workspaceId = requestedWorkspaceId ?? agent.workspaceId ?? null;

      // Manifest slots are independent once the agent row is known, so fetch them in one batch.
      // Module slots go through moduleGate (tier-aware, workspace-scoped to the agent).
      const [rawModel, stackLinks, activeSkills, resolvedToolIds, constraintsModule, toolkitModule] = await Promise.all([
        agent.modelModuleId
          ? moduleGate.model.get(agent.modelModuleId, workspaceId)
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
          ? moduleGate.constraints.get(agent.constraintsModuleId, workspaceId)
          : Promise.resolve(null),
        agent.toolkitModuleId
          ? moduleGate.toolkit.get(agent.toolkitModuleId, workspaceId)
          : Promise.resolve(null),
      ]);

      // 1. Model Slot — redact apiKey before returning (P0-2)
      const modelModule = rawModel ? redactApiKeyFields(rawModel as Record<string, unknown>) : null;

      // 2. Instruction Stack
      const instructionStack = stackLinks.map((l: any) => ({
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
      const agentId = request.params.id;
      const { modelModuleId, instructionModuleIds, skillIds, toolkitModuleId, constraintsModuleId } = request.body;
      const workspaceId = workspaceIdFrom(request);
      const db = (request as any).db ?? getDb();

      const agent = await agentGate.getById(agentId, (request as any).db, workspaceId);
      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      // 1. Update Agent FKs through the gate: reference validation plus
      // roster-cache invalidation belong to Agents (direct agents-table
      // writes from other domains are forbidden).
      const agentUpdates: { modelModuleId?: string; toolkitModuleId?: string; constraintsModuleId?: string } = {};
      if (modelModuleId !== undefined) agentUpdates.modelModuleId = modelModuleId;
      if (toolkitModuleId !== undefined) agentUpdates.toolkitModuleId = toolkitModuleId;
      if (constraintsModuleId !== undefined) agentUpdates.constraintsModuleId = constraintsModuleId;

      if (Object.keys(agentUpdates).length > 0) {
        await agentGate.update(agentId, agentUpdates, db, workspaceId);
      }

      // 2. Update Instruction Stack if provided
      if (instructionModuleIds && Array.isArray(instructionModuleIds)) {
        // XD-015: atomic replace through the Agents gate (all-or-nothing).
        // No direct agentInstructionStacks writes from the route.
        await agentGate.replaceInstructionStack(agentId, instructionModuleIds);
      }

      // 3. Update Skills if provided
      if (skillIds && Array.isArray(skillIds)) {
        // SK-001: atomic replace through the Skills gate (all-or-nothing in
        // one transaction + cache invalidation owned by the domain). No
        // direct agentSkills writes from the route.
        await skillsGate.replaceAgentSkills(agentId, skillIds);
      }

      // Invalidate remaining hot-path caches after manifest mutation
      // (toolkit/model refs; skill caches already cleared by the gate port).
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
      const { agentId, channelId = "general", userInput = "Hello, what is your current plan?", runtimeType = "agentic" } = request.body;
      const requestedWorkspaceId = workspaceIdFrom(request);

      const agent = await agentGate.getById(agentId, (request as any).db, requestedWorkspaceId);
      if (!agent) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent not found" });
      }

      const workspaceId = requestedWorkspaceId ?? agent.workspaceId;
      if (!workspaceId) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Workspace context is required for prompt inspection",
        });
      }

      let compiled;
      try {
        compiled = await contextPipeline.assemble({
          agent: agent as any,
          channelId,
          workspaceId,
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

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  skillsGate,
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
  type CreateSkillBody,
  type UpdateSkillBody,
  type SkillParams,
} from "../skills/skills-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

function isForeignKeyViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23503");
}

const agentSkillParamsSchema = z.object({
  id: z.string().min(1),
  skillId: z.string().min(1),
});

export async function skillRoutes(app: FastifyInstance) {
  // GET /api/skills
  app.get<{ Querystring: { category?: string; limit?: number } }>(
    "/api/skills",
    {
      schema: {
        querystring: z.object({
          category: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (request) => {
      return skillsGate.list({ category: request.query.category, limit: request.query.limit });
    }
  );

  // GET /api/skills/:id
  app.get<{ Params: SkillParams }>(
    "/api/skills/:id",
    { schema: { params: skillParamsSchema } },
    async (request, reply) => {
      const skill = await skillsGate.getById(request.params.id);
      if (!skill) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Skill not found" });
      }
      return skill;
    }
  );

  // POST /api/skills
  app.post<{ Body: CreateSkillBody }>(
    "/api/skills",
    { schema: { body: createSkillSchema } },
    async (request, reply) => {
      try {
        const skill = await skillsGate.create(request.body);
        emitWorkspaceSync();
        return reply.status(201).send(skill);
      } catch (err: any) {
        return reply.status(400).send({ statusCode: 400, error: "Bad Request", message: err.message });
      }
    }
  );

  // PUT /api/skills/:id
  app.put<{ Params: SkillParams; Body: UpdateSkillBody }>(
    "/api/skills/:id",
    { schema: { params: skillParamsSchema, body: updateSkillSchema } },
    async (request, reply) => {
      try {
        const skill = await skillsGate.update(request.params.id, request.body);
        if (!skill) {
          return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Skill not found" });
        }
        emitWorkspaceSync();
        return skill;
      } catch (err: any) {
        return reply.status(400).send({ statusCode: 400, error: "Bad Request", message: err.message });
      }
    }
  );

  // DELETE /api/skills/:id
  app.delete<{ Params: SkillParams }>(
    "/api/skills/:id",
    { schema: { params: skillParamsSchema } },
    async (request, reply) => {
      const deleted = await skillsGate.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Skill not found" });
      }
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // GET /api/agents/:id/skills
  app.get<{ Params: SkillParams }>(
    "/api/agents/:id/skills",
    { schema: { params: skillParamsSchema } },
    async (request) => {
      return skillsGate.getAgentSkills(request.params.id);
    }
  );

  // POST /api/agents/:id/skills/:skillId
  app.post<{ Params: z.infer<typeof agentSkillParamsSchema> }>(
    "/api/agents/:id/skills/:skillId",
    { schema: { params: agentSkillParamsSchema } },
    async (request, reply) => {
      try {
        await skillsGate.assignSkill(request.params.id, request.params.skillId);
      } catch (err: any) {
        // FK violations (unknown agent or skill) surface as a clean 404,
        // not a raw 500; anything else is a real failure and propagates.
        if (isForeignKeyViolation(err)) {
          return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent or skill not found" });
        }
        throw err;
      }
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // DELETE /api/agents/:id/skills/:skillId
  app.delete<{ Params: z.infer<typeof agentSkillParamsSchema> }>(
    "/api/agents/:id/skills/:skillId",
    { schema: { params: agentSkillParamsSchema } },
    async (request, reply) => {
      try {
        await skillsGate.removeSkill(request.params.id, request.params.skillId);
      } catch (err: any) {
        if (isForeignKeyViolation(err)) {
          return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Agent or skill not found" });
        }
        throw err;
      }
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

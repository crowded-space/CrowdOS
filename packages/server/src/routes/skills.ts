import type { FastifyInstance } from "fastify";
import {
  skillsGate,
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
  type CreateSkillBody,
  type UpdateSkillBody,
  type SkillParams,
} from "../Skills/skillsGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

export async function skillRoutes(app: FastifyInstance) {
  // GET /api/skills
  app.get<{ Querystring: { category?: string } }>(
    "/api/skills",
    async (request) => {
      return skillsGate.list({ category: request.query.category });
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
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/skills",
    async (request) => {
      return skillsGate.getAgentSkills(request.params.id);
    }
  );

  // POST /api/agents/:id/skills/:skillId
  app.post<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skills/:skillId",
    async (request, reply) => {
      await skillsGate.assignSkill(request.params.id, request.params.skillId);
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // DELETE /api/agents/:id/skills/:skillId
  app.delete<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skills/:skillId",
    async (request, reply) => {
      await skillsGate.removeSkill(request.params.id, request.params.skillId);
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

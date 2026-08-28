import type { FastifyInstance } from "fastify";
import { artifactsGate } from "../Artifacts/artifactsGate.js";

export async function artifactsRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async (request, reply) => {
    const query = request.query as { runId?: string; workspaceId?: string };
    if (query.runId) {
      const rows = await artifactsGate.listByRun(query.runId);
      return reply.send({ artifacts: rows });
    }
    if (query.workspaceId) {
      const rows = await artifactsGate.listByWorkspace(query.workspaceId);
      return reply.send({ artifacts: rows });
    }
    return reply.status(400).send({ error: "runId or workspaceId query required" });
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await artifactsGate.getById(id);
    if (!row) return reply.status(404).send({ error: "artifact not found" });
    return reply.send({ artifact: row });
  });

  app.get("/api/runs/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rows = await artifactsGate.listByRun(id);
    return reply.send({ runId: id, artifacts: rows });
  });
}

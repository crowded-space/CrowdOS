import type { FastifyInstance } from "fastify";
import { artifactsGate } from "../Artifacts/artifactsGate.js";

export async function artifactsRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async (request, reply) => {
    const query = request.query as { runId?: string; workspaceId?: string; limit?: string; cursor?: string; offset?: string };
    const limit = query.limit != null ? Number(query.limit) : undefined;
    const cursor = query.cursor ?? query.offset;
    const offset = cursor != null ? Number(cursor) : undefined;
    const opts = { limit, offset: Number.isFinite(offset as number) ? offset as number : undefined };
    if (query.runId) {
      const rows = await artifactsGate.listByRun(query.runId, opts);
      return reply.send({ artifacts: rows });
    }
    if (query.workspaceId) {
      const rows = await artifactsGate.listByWorkspace(query.workspaceId, opts);
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
    const q = request.query as { limit?: string; cursor?: string; offset?: string };
    const limit = q.limit != null ? Number(q.limit) : undefined;
    const cursor = q.cursor ?? q.offset;
    const offset = cursor != null ? Number(cursor) : undefined;
    const rows = await artifactsGate.listByRun(id, { limit, offset: Number.isFinite(offset as number) ? offset as number : undefined });
    return reply.send({ runId: id, artifacts: rows });
  });
}

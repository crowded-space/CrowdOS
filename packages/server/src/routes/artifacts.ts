import type { FastifyInstance } from "fastify";
import { artifactsGate } from "../Artifacts/artifactsGate.js";
import { runsGate } from "../Runs/runsGate.js";
import { workspaceGate } from "../Workspace/workspaceGate.js";

export async function artifactsRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async (request, reply) => {
    const query = request.query as { runId?: string; workspaceId?: string; limit?: string; cursor?: string; offset?: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    // The query param never authorizes the tenant: it must match the resolved workspace.
    if (query.workspaceId && query.workspaceId !== workspaceId) {
      return reply.status(403).send({ error: "Artifact workspace does not match this workspace" });
    }
    const limit = query.limit != null ? Number(query.limit) : undefined;
    const cursor = query.cursor ?? query.offset;
    const offset = cursor != null ? Number(cursor) : undefined;
    const opts = { limit, offset: Number.isFinite(offset as number) ? offset as number : undefined };
    if (query.runId) {
      const run = await runsGate.getById(query.runId);
      if (!run || run.workspaceId !== workspaceId) {
        return reply.status(403).send({ error: "Run does not belong to this workspace" });
      }
      const rows = await artifactsGate.listByRun(query.runId, opts);
      return reply.send({ artifacts: rows });
    }
    if (query.workspaceId) {
      const rows = await artifactsGate.listByWorkspace(workspaceId, opts);
      return reply.send({ artifacts: rows });
    }
    return reply.status(400).send({ error: "runId or workspaceId query required" });
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const row = await artifactsGate.getById(id);
    if (!row) return reply.status(404).send({ error: "artifact not found" });
    if ((row as { workspaceId?: string | null }).workspaceId !== workspaceId) {
      return reply.status(403).send({ error: "Artifact does not belong to this workspace" });
    }
    return reply.send({ artifact: row });
  });

  app.get("/api/runs/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (run.workspaceId !== workspaceId) {
      return reply.status(403).send({ error: "Run does not belong to this workspace" });
    }
    const q = request.query as { limit?: string; cursor?: string; offset?: string };
    const limit = q.limit != null ? Number(q.limit) : undefined;
    const cursor = q.cursor ?? q.offset;
    const offset = cursor != null ? Number(cursor) : undefined;
    const rows = await artifactsGate.listByRun(id, { limit, offset: Number.isFinite(offset as number) ? offset as number : undefined });
    return reply.send({ runId: id, artifacts: rows });
  });
}

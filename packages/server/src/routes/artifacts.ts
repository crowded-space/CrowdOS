import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { artifactsGate } from "../artifacts/artifacts-gate.js";

const artifactsQuerySchema = z.object({
  runId: z.string().optional(),
  workspaceId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const artifactParamsSchema = z.object({
  id: z.string().min(1),
});

const runArtifactsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function toOffset(cursor: string | number | undefined, fallback: number | undefined): number | undefined {
  const raw = cursor ?? fallback;
  if (raw == null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(10000, Math.max(0, Math.floor(n)));
}

export async function artifactsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: z.infer<typeof artifactsQuerySchema> }>("/api/artifacts", { schema: { querystring: artifactsQuerySchema } }, async (request, reply) => {
    const query = request.query as { runId?: string; workspaceId?: string; limit?: number; cursor?: string; offset?: number };
    const limit = query.limit;
    const offset = toOffset(query.cursor, query.offset);
    const opts = { limit, offset };
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

  app.get<{ Params: z.infer<typeof artifactParamsSchema> }>("/api/artifacts/:id", { schema: { params: artifactParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await artifactsGate.getById(id);
    if (!row) return reply.status(404).send({ error: "artifact not found" });
    return reply.send({ artifact: row });
  });

  app.get<{ Params: z.infer<typeof artifactParamsSchema>; Querystring: z.infer<typeof runArtifactsQuerySchema> }>("/api/runs/:id/artifacts", { schema: { params: artifactParamsSchema, querystring: runArtifactsQuerySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { limit?: number; cursor?: string; offset?: number };
    const limit = q.limit;
    const offset = toOffset(q.cursor, q.offset);
    const rows = await artifactsGate.listByRun(id, { limit, offset });
    return reply.send({ runId: id, artifacts: rows });
  });
}

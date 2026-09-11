import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGate } from "../shared/auth/auth-gate.js";
import { queueGate } from "../queue/queue-gate.js";

const failedJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function queueRoutes(app: FastifyInstance) {
  app.get("/api/queue/failed", { preHandler: authGate.requireAdmin, schema: { querystring: failedJobsQuery } }, async (request, reply) => {
    if (queueGate.mode() !== "bullmq") {
      return reply.send({ jobs: [], mode: "inline", note: "queue disabled in inline mode" });
    }
    try {
      const { limit } = failedJobsQuery.parse((request as any).query);
      const jobs = await queueGate.getFailedJobs(limit);
      return reply.send({ jobs, mode: "bullmq", count: jobs.length });
    } catch (err) {
      request.log.error({ err }, "[queue] failed to fetch DLQ jobs");
      return reply.status(500).send({ error: "Failed to fetch failed jobs", jobs: [] });
    }
  });

  app.get("/api/queue/health", async (request, reply) => {
    try {
      const health = await queueGate.healthCheck();
      return reply.send(health);
    } catch (err) {
      return reply.status(500).send({ mode: queueGate.mode(), connected: false, waiting: 0, failed: 0 });
    }
  });
}

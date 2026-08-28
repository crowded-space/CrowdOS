import type { FastifyInstance } from "fastify";
import { authGate } from "../Shared/auth/authGate.js";
import { queueGate } from "../Queue/queueGate.js";

export async function queueRoutes(app: FastifyInstance) {
  app.get("/api/queue/failed", { preHandler: authGate.requireAdmin }, async (request, reply) => {
    if (queueGate.mode() !== "bullmq") {
      return reply.send({ jobs: [], mode: "inline", note: "queue disabled in inline mode" });
    }
    try {
      const jobs = await queueGate.getFailedJobs(100);
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

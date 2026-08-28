import type { FastifyInstance } from "fastify";
import { queueGate } from "../Queue/queueGate.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    let queue: { mode: string; connected: boolean; waiting: number; failed: number } | null = null;
    try {
      queue = await queueGate.healthCheck();
    } catch {
      queue = { mode: queueGate.mode(), connected: false, waiting: 0, failed: 0 };
    }
    return {
      status: "ok",
      service: "community-agent-server",
      queue,
    };
  });

  app.get("/api/health", async () => {
    let queue: { mode: string; connected: boolean; waiting: number; failed: number } | null = null;
    try {
      queue = await queueGate.healthCheck();
    } catch {
      queue = { mode: queueGate.mode(), connected: false, waiting: 0, failed: 0 };
    }
    return {
      status: "ok",
      service: "community-agent-server",
      queue,
    };
  });
}

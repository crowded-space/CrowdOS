import type { FastifyInstance } from "fastify";
import { queueGate } from "../queue/queue-gate.js";

type QueueHealth = { mode: string; connected: boolean; waiting: number; failed: number };

// ponytail: 5s in-memory cache, upgrade to shared cache if multi-instance skew matters
let cachedAt = 0;
let cached: QueueHealth | null = null;
const CACHE_MS = 5_000;

async function readinessProbe(): Promise<QueueHealth> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  const probe = (async (): Promise<QueueHealth> => {
    try {
      return await queueGate.healthCheck();
    } catch {
      return { mode: queueGate.mode(), connected: false, waiting: 0, failed: 0 };
    }
  })();
  const timeout = new Promise<QueueHealth>((resolve) => {
    const t = setTimeout(
      () => resolve(cached ?? { mode: queueGate.mode(), connected: false, waiting: 0, failed: 0 }),
      500,
    );
    probe.then(
      () => clearTimeout(t),
      () => clearTimeout(t),
    );
  });
  const result = await Promise.race([probe, timeout]);
  cached = result;
  cachedAt = Date.now();
  return result;
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", service: "community-agent-server" };
  });

  app.get("/api/health", async () => {
    const queue = await readinessProbe();
    return {
      status: "ok",
      service: "community-agent-server",
      queue,
    };
  });
}

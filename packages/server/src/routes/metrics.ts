import type { FastifyInstance } from "fastify";

import { authGate } from "../Shared/auth/authGate.js";
import { getMetricsSnapshot } from "../Shared/core/perfMetrics.js";

/**
 * OBS-1: GET /metrics — perfMetrics latency snapshot (p50/p95 per stage).
 * Flag: METRICS_ENABLED=false disables the route entirely (rollback switch);
 * default is enabled. Auth: the global requireAuth hook already applies
 * (token model via AUTH_TOKEN/API_KEY; open in dev when unset). When
 * WORKSPACE_ADMIN_TOKEN is configured, authGate.requireAdmin additionally
 * enforces it. Real role enforcement arrives with SEC-1.
 */
export async function metricsRoutes(app: FastifyInstance) {
  if (process.env.METRICS_ENABLED === "false") return;

  const adminPreHandler = process.env.WORKSPACE_ADMIN_TOKEN ? authGate.requireAdmin : undefined;

  app.get("/metrics", { preHandler: adminPreHandler }, async () => {
    return { metrics: getMetricsSnapshot() };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { observabilityGate } from "../observability/observability-gate.js";
import { authGate } from "../shared/auth/auth-gate.js";

const traceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const costQuerySchema = z.object({
  runId: z.string().optional(),
  channelId: z.string().optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/**
 * SCL-3: OTel + cost ledger routes.
 * - GET /api/observability/trace/:runId — reconstruct trace for a run (assemble/llm/tool/persist spans)
 * - GET /api/observability/traces — list recent traces
 * - GET /api/observability/cost/ledger — per-run cost ledger (token_usage_log × cost_per_1k)
 * - GET /api/observability/cost/dashboard — aggregated dashboard
 * - GET /api/observability/cost/verify — ledger accuracy check (±1%)
 */
export async function observabilityRoutes(app: FastifyInstance) {
  const adminPreHandler = process.env.WORKSPACE_ADMIN_TOKEN ? authGate.requireAdmin : undefined;

  // Trace reconstruction (keyed by runId)
  app.get("/api/observability/trace/:runId", { preHandler: adminPreHandler }, async (request) => {
    const { runId } = request.params as { runId: string };
    const spans = observabilityGate.getTrace(runId);
    return { runId, spans, count: spans.length };
  });

  app.get("/api/observability/traces", { preHandler: adminPreHandler }, async (request) => {
    const query = traceQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    const traces = observabilityGate.getAllTraces(query.limit ?? 50);
    const stats = observabilityGate.getTraceStats();
    return { traces, stats };
  });

  // Cost ledger — single fetch; the rollup is derived pure from the same rows.
  app.get("/api/observability/cost/ledger", { preHandler: adminPreHandler }, async (request) => {
    const query = costQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    const ledger = await observabilityGate.getPerRunCostLedger({
      runId: query.runId ?? null,
      channelId: query.channelId ?? null,
      agentId: query.agentId ?? null,
      limit: query.limit ?? 100,
    });
    const rollup = observabilityGate.rollupFromEntries(ledger);
    return { ledger, rollup, count: ledger.length };
  });

  app.get("/api/observability/cost/dashboard", { preHandler: adminPreHandler }, async () => {
    const dashboard = await observabilityGate.getCostDashboard({ limit: 500 });
    return dashboard;
  });

  app.get("/api/observability/cost/verify", { preHandler: adminPreHandler }, async () => {
    const result = await observabilityGate.verifyLedgerAccuracy();
    return result;
  });
}

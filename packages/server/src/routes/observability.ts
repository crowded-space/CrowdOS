import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { observabilityGate, clampObsLimit, OBS_LIMIT_MAX } from "../observability/observability-gate.js";
import type { CostDashboard, CostLedgerEntry, PerRunCostRollup } from "../observability/observability-gate.js";
import { authGate } from "../shared/auth/auth-gate.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { resolveTier, isConnectionError, isSchemaMismatchError, NO_DATABASE_CODE } from "../shared/config/database.js";

const traceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(OBS_LIMIT_MAX).optional(),
});

const costQuerySchema = z.object({
  runId: z.string().optional(),
  channelId: z.string().optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(OBS_LIMIT_MAX).optional(),
});

// ─── Local-tier / outage honesty for cost reads ─────────────────────────
// The ledger is derived from `token_usage_log` × `model_modules.cost_per_1k` —
// both PG-only. Two shapes have no ledger rows to read, and neither is a server
// fault:
//   1. A workspace with no record `databaseUrl` (local-first / offline). These
//      routes previously called `getDb()` unguarded, so a local-tier workspace
//      answered 500 on every poll while the honest answer was "zero spend".
//   2. A configured database that is momentarily unreachable. The telemetry
//      panel polls every 30s and keeps its last value on a non-OK response, so a
//      500 turned a transient outage into a permanently stale panel.
// Same boundary `local-mode-guard.ts` applies to modules/skills/providers:
// degrade explicitly instead of failing raw. Logic errors still propagate — a
// real defect must never be masked as "zero spend".

/** True when the targeted workspace resolves to the local (non-PG) tier. */
async function isLocalTierRead(request: {
  headers: Record<string, string | string[] | undefined>;
  workspaceId?: string;
}): Promise<boolean> {
  const wsIdHeader = request.headers["x-workspace-id"];
  const headerWsId = Array.isArray(wsIdHeader) ? wsIdHeader[0] : wsIdHeader;
  const workspaceId =
    request.workspaceId || (typeof headerWsId === "string" && headerWsId.trim() ? headerWsId.trim() : null);
  const ctx = await tierContextFor(workspaceId).catch(() => null);
  const { tier } = resolveTier(ctx ?? {});
  return tier === "local";
}

/**
 * Honest empty shapes: "no spend recorded", distinguishable from an error.
 * Typed against the gate's own contracts so the degraded answer is structurally
 * identical to a real one — the renderer must not be able to tell them apart.
 */
const emptyDashboard = (): CostDashboard & { localMode: true } => ({
  totalCostUsd: 0,
  totalTokens: 0,
  totalRuns: 0,
  byRun: [] as PerRunCostRollup[],
  byModel: [] as CostDashboard["byModel"],
  generatedAt: new Date(),
  localMode: true as const,
});

const emptyLedger = (): { ledger: CostLedgerEntry[]; rollup: PerRunCostRollup[]; count: number; localMode: true } => ({
  ledger: [] as CostLedgerEntry[],
  rollup: [] as PerRunCostRollup[],
  count: 0,
  localMode: true as const,
});

const emptyVerify = () => ({
  match: true,
  ledgerTotal: 0,
  recomputedTotal: 0,
  deltaPct: 0,
  localMode: true as const,
});

/** Degrade connection-class failures (outage) and unprovisioned-schema
 * failures (stale BYODB) — never genuine logic errors. */
async function withOutageDegradation<T>(run: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isSchemaMismatchError(err)) {
      console.warn("[observability] tenant PG schema missing; serving empty cost shape");
      return fallback();
    }
    if (isConnectionError(err) || (err as { code?: unknown })?.code === NO_DATABASE_CODE) {
      return fallback();
    }
    throw err;
  }
}

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

  // Trace reconstruction (keyed by runId). Spans are process-local memory, so
  // these reads never touch a database and need no degradation.
  app.get("/api/observability/trace/:runId", { preHandler: adminPreHandler }, async (request) => {
    const { runId } = request.params as { runId: string };
    const spans = observabilityGate.getTrace(runId);
    return { runId, spans, count: spans.length };
  });

  app.get("/api/observability/traces", { preHandler: adminPreHandler }, async (request) => {
    const query = traceQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    const traces = observabilityGate.getAllTraces(clampObsLimit(query.limit));
    const stats = observabilityGate.getTraceStats();
    return { traces, stats };
  });

  // Cost ledger — single fetch; the rollup is derived pure from the same rows.
  app.get("/api/observability/cost/ledger", { preHandler: adminPreHandler }, async (request) => {
    const query = costQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    if (await isLocalTierRead(request)) return emptyLedger();
    return withOutageDegradation(async () => {
      const ledger = await observabilityGate.getPerRunCostLedger({
        runId: query.runId ?? null,
        channelId: query.channelId ?? null,
        agentId: query.agentId ?? null,
        limit: clampObsLimit(query.limit),
      });
      const rollup = observabilityGate.rollupFromEntries(ledger);
      return { ledger, rollup, count: ledger.length };
    }, emptyLedger);
  });

  app.get("/api/observability/cost/dashboard", { preHandler: adminPreHandler }, async (request) => {
    const query = costQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    if (await isLocalTierRead(request)) return emptyDashboard();
    return withOutageDegradation(
      () => observabilityGate.getCostDashboard({ limit: clampObsLimit(query.limit) }),
      emptyDashboard,
    );
  });

  app.get("/api/observability/cost/verify", { preHandler: adminPreHandler }, async (request) => {
    if (await isLocalTierRead(request)) return emptyVerify();
    return withOutageDegradation(() => observabilityGate.verifyLedgerAccuracy(), emptyVerify);
  });
}

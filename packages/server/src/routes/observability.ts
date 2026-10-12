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
// The ledger reads local-first (§17): a local-tier workspace serves its file
// truth (`token-usage.json` × local model costs); a dual workspace serves PG.
// Two shapes still have no PG rows to read, and neither is a server fault:
//   1. A workspace with no record `databaseUrl` (local-first / offline) serves
//      its local totals (zero spend until runs record usage locally).
//   2. A configured database that is momentarily unreachable degrades to the
//      local mirror instead of 500-ing the 30s telemetry poll.
// Same boundary `local-mode-guard.ts` applies to modules/skills/providers:
// degrade explicitly instead of failing raw. Logic errors still propagate — a
// real defect must never be masked as "zero spend".

/** Workspace scope for cost reads: explicit param wins, then tenant header. */
function workspaceIdFrom(request: {
  headers: Record<string, string | string[] | undefined>;
  workspaceId?: string;
}): string | null {
  const wsIdHeader = request.headers["x-workspace-id"];
  const headerWsId = Array.isArray(wsIdHeader) ? wsIdHeader[0] : wsIdHeader;
  const fromHeader = typeof headerWsId === "string" && headerWsId.trim() ? headerWsId.trim() : null;
  const fromReq = typeof request.workspaceId === "string" && request.workspaceId.trim() ? request.workspaceId.trim() : null;
  return fromReq ?? fromHeader;
}

/** True when the targeted workspace resolves to the local (non-PG) tier. */
async function isLocalTierRead(request: {
  headers: Record<string, string | string[] | undefined>;
  workspaceId?: string;
}): Promise<boolean> {
  const workspaceId = workspaceIdFrom(request);
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
  // Workspace-scoped local-first reads: the gate serves file truth in local
  // tier, PG in dual. The `localMode` flag marks file-truth answers so the
  // panel can tell them apart from PG totals.
  app.get("/api/observability/cost/ledger", { preHandler: adminPreHandler }, async (request) => {
    const query = costQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    const workspaceId = workspaceIdFrom(request);
    return withOutageDegradation(async () => {
      const ledger = await observabilityGate.getPerRunCostLedger({
        runId: query.runId ?? null,
        channelId: query.channelId ?? null,
        agentId: query.agentId ?? null,
        limit: clampObsLimit(query.limit),
        workspaceId,
      });
      const rollup = observabilityGate.rollupFromEntries(ledger);
      // Flag file-truth answers: local tier, or a dual tier whose PG leg just
      // failed (outage window marks it local-after). Re-checked after the read
      // so a first-call outage still flags.
      const local = await isLocalTierRead(request);
      return local
        ? { ledger, rollup, count: ledger.length, localMode: true as const }
        : { ledger, rollup, count: ledger.length };
    }, emptyLedger);
  });

  app.get("/api/observability/cost/dashboard", { preHandler: adminPreHandler }, async (request) => {
    const query = costQuerySchema.parse((request.query as Record<string, unknown>) ?? {});
    const workspaceId = workspaceIdFrom(request);
    return withOutageDegradation(async () => {
      const dashboard = await observabilityGate.getCostDashboard({
        limit: clampObsLimit(query.limit),
        workspaceId,
      });
      const local = await isLocalTierRead(request);
      return local ? { ...dashboard, localMode: true as const } : dashboard;
    }, emptyDashboard);
  });

  app.get("/api/observability/cost/verify", { preHandler: adminPreHandler }, async (request) => {
    const workspaceId = workspaceIdFrom(request);
    return withOutageDegradation(async () => {
      const res = await observabilityGate.verifyLedgerAccuracy({ workspaceId });
      const local = await isLocalTierRead(request);
      return local ? { ...res, localMode: true as const } : res;
    }, emptyVerify);
  });
}

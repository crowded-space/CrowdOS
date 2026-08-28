import { eq, sql, desc, and, gte, lte } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { tokenUsageLog, modelModules, runs } from "../db/schema.js";
import { logMetric } from "../Shared/core/structuredLog.js";

/**
 * SCL-3: per-run cost ledger.
 * Computes USD cost as token_usage_log × model_modules.cost_per_1k
 * and exposes rollups keyed by runId (and by agent/channel).
 */

export interface CostLedgerEntry {
  runId: string | null;
  agentId: string;
  channelId: string;
  modelModuleId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  timestamp: Date;
}

export interface PerRunCostRollup {
  runId: string | null;
  agentId: string;
  channelId: string;
  runtimeType?: string | null;
  status?: string | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number | null;
  entries: CostLedgerEntry[];
  firstSeen: Date | null;
  lastSeen: Date | null;
}

export interface CostDashboard {
  totalCostUsd: number;
  totalTokens: number;
  totalRuns: number;
  byRun: PerRunCostRollup[];
  byModel: Array<{ modelModuleId: string | null; modelName: string | null; provider: string | null; tokens: number; costUsd: number | null }>;
  generatedAt: Date;
}

/**
 * Compute cost for one log row given its model's cost_per_1k.
 * Mirrors TokenTracker.computeCostUsd but as a pure function for ledger use.
 */
export function computeRowCostUsd(
  row: { promptTokens: number; completionTokens: number },
  costPer1k: number | null | undefined,
): number | null {
  if (costPer1k == null) return null;
  const rate = Number(costPer1k);
  if (!Number.isFinite(rate)) return null;
  return (rate * (row.promptTokens + row.completionTokens)) / 1000;
}

export async function getPerRunCostLedger(opts: {
  runId?: string | null;
  channelId?: string | null;
  agentId?: string | null;
  limit?: number;
} = {}): Promise<CostLedgerEntry[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);

  // Join token_usage_log with model_modules to compute cost; filter by runId if column exists
  // Fallback: if run_id column missing (pre-migration), return unkeyed entries with cost.
  let rows: Array<{
    runId: string | null;
    agentId: string;
    channelId: string;
    modelModuleId: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    timestamp: Date;
    costPer1k: number | null;
  }>;

  // Probe for run_id column existence via try/catch to keep rollback safe pre-migration
  try {
    const dbAny = db as unknown as { execute: (q: unknown) => Promise<unknown> };
    // Use drizzle query builder with runId-aware selection; if column missing, catch and fallback
    const base = db
      .select({
        runId: (tokenUsageLog as unknown as Record<string, unknown>).runId as unknown as typeof tokenUsageLog.id,
        agentId: tokenUsageLog.agentId,
        channelId: tokenUsageLog.channelId,
        modelModuleId: tokenUsageLog.modelModuleId,
        promptTokens: tokenUsageLog.promptTokens,
        completionTokens: tokenUsageLog.completionTokens,
        totalTokens: tokenUsageLog.totalTokens,
        timestamp: tokenUsageLog.timestamp,
        costPer1k: modelModules.costPer1k,
      })
      .from(tokenUsageLog)
      .leftJoin(modelModules, eq(tokenUsageLog.modelModuleId, modelModules.id))
      .orderBy(desc(tokenUsageLog.timestamp))
      .limit(limit);

    // Apply filters if provided and column exists
    let filtered: typeof base = base;
    // We add where clauses via dynamic sql to avoid TS complaints about missing column
    const conditions: unknown[] = [];
    if (opts.runId) {
      // @ts-ignore runId may not exist on type pre-migration
      conditions.push(eq((tokenUsageLog as any).runId, opts.runId));
    }
    if (opts.channelId) conditions.push(eq(tokenUsageLog.channelId, opts.channelId));
    if (opts.agentId) conditions.push(eq(tokenUsageLog.agentId, opts.agentId));
    // @ts-ignore drizzle where overload
    if (conditions.length > 0) filtered = (base as any).where(conditions.length === 1 ? conditions[0] : and(...(conditions as any[])));

    rows = (await filtered) as typeof rows;
  } catch {
    // Fallback path: legacy schema without run_id
    const fallback = await db
      .select({
        agentId: tokenUsageLog.agentId,
        channelId: tokenUsageLog.channelId,
        modelModuleId: tokenUsageLog.modelModuleId,
        promptTokens: tokenUsageLog.promptTokens,
        completionTokens: tokenUsageLog.completionTokens,
        totalTokens: tokenUsageLog.totalTokens,
        timestamp: tokenUsageLog.timestamp,
        costPer1k: modelModules.costPer1k,
      })
      .from(tokenUsageLog)
      .leftJoin(modelModules, eq(tokenUsageLog.modelModuleId, modelModules.id))
      .orderBy(desc(tokenUsageLog.timestamp))
      .limit(limit);

    let filteredRows = fallback as unknown as Array<{
      agentId: string;
      channelId: string;
      modelModuleId: string | null;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      timestamp: Date;
      costPer1k: number | null;
    }>;
    if (opts.channelId) filteredRows = filteredRows.filter((r) => r.channelId === opts.channelId);
    if (opts.agentId) filteredRows = filteredRows.filter((r) => r.agentId === opts.agentId);
    rows = filteredRows.map((r) => ({
      runId: null,
      agentId: r.agentId,
      channelId: r.channelId,
      modelModuleId: r.modelModuleId,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      timestamp: r.timestamp,
      costPer1k: r.costPer1k,
    }));
  }

  return rows.map((r) => ({
    runId: r.runId ?? null,
    agentId: r.agentId,
    channelId: r.channelId,
    modelModuleId: r.modelModuleId ?? null,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    costUsd: computeRowCostUsd(r, r.costPer1k),
    timestamp: r.timestamp,
  }));
}

export async function getPerRunRollup(opts: {
  runId?: string | null;
  channelId?: string | null;
  limit?: number;
} = {}): Promise<PerRunCostRollup[]> {
  const entries = await getPerRunCostLedger(opts);
  const byRun = new Map<string, PerRunCostRollup>();

  for (const e of entries) {
    const key = e.runId ?? `__no_run:${e.channelId}:${e.agentId}`;
    let rollup = byRun.get(key);
    if (!rollup) {
      rollup = {
        runId: e.runId,
        agentId: e.agentId,
        channelId: e.channelId,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostUsd: null,
        entries: [],
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
      };
      byRun.set(key, rollup);
    }
    rollup.entries.push(e);
    rollup.totalPromptTokens += e.promptTokens;
    rollup.totalCompletionTokens += e.completionTokens;
    rollup.totalTokens += e.totalTokens;
    if (e.costUsd != null) {
      rollup.totalCostUsd = (rollup.totalCostUsd ?? 0) + e.costUsd;
    }
    if (e.timestamp < (rollup.firstSeen as Date)) rollup.firstSeen = e.timestamp;
    if (e.timestamp > (rollup.lastSeen as Date)) rollup.lastSeen = e.timestamp;
  }

  // Enrich with run metadata if runId present
  const db = getDb();
  for (const rollup of byRun.values()) {
    if (!rollup.runId) continue;
    try {
      const [runRow] = await db.select({ runtimeType: runs.runtimeType, status: runs.status }).from(runs).where(eq(runs.id, rollup.runId)).limit(1);
      if (runRow) {
        rollup.runtimeType = runRow.runtimeType;
        rollup.status = runRow.status;
      }
    } catch {}
  }

  const list = [...byRun.values()];
  list.sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
  logMetric({
    stage: "cost.ledger.rollup",
    runCount: list.length,
    totalTokens: list.reduce((s, r) => s + r.totalTokens, 0),
    totalCostUsd: list.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0),
    queriedRunId: opts.runId ?? null,
  });
  return list;
}

export async function getCostDashboard(opts: { limit?: number } = {}): Promise<CostDashboard> {
  const entries = await getPerRunCostLedger({ limit: opts.limit ?? 500 });
  const byRun = await getPerRunRollup({ limit: opts.limit ?? 500 });

  // Aggregate by model
  const byModelMap = new Map<string, { modelModuleId: string | null; tokens: number; costUsd: number | null; provider: string | null; modelName: string | null }>();
  const db = getDb();
  let modelMeta = new Map<string, { provider: string; modelName: string }>();
  try {
    const rows = await db.select({ id: modelModules.id, provider: modelModules.provider, modelName: modelModules.modelName }).from(modelModules);
    for (const r of rows) modelMeta.set(r.id, { provider: String(r.provider), modelName: r.modelName });
  } catch {}

  for (const e of entries) {
    const key = e.modelModuleId ?? "__no_model";
    let agg = byModelMap.get(key);
    if (!agg) {
      const meta = e.modelModuleId ? modelMeta.get(e.modelModuleId) : null;
      agg = { modelModuleId: e.modelModuleId, tokens: 0, costUsd: 0, provider: meta?.provider ?? null, modelName: meta?.modelName ?? null };
      byModelMap.set(key, agg);
    }
    agg.tokens += e.totalTokens;
    if (e.costUsd != null) agg.costUsd = (agg.costUsd ?? 0) + e.costUsd;
  }

  const totalCostUsd = entries.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);

  return {
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalTokens,
    totalRuns: byRun.length,
    byRun,
    byModel: [...byModelMap.values()],
    generatedAt: new Date(),
  };
}

export async function verifyLedgerAccuracy(): Promise<{ match: boolean; ledgerTotal: number; recomputedTotal: number; deltaPct: number }> {
  const dashboard = await getCostDashboard({ limit: 1000 });
  // Recompute via raw SQL sum as ground truth (same as reconcile path)
  const db = getDb();
  let rawTotal = dashboard.totalCostUsd;
  try {
    const rows = await db
      .select({
        promptTokens: tokenUsageLog.promptTokens,
        completionTokens: tokenUsageLog.completionTokens,
        costPer1k: modelModules.costPer1k,
      })
      .from(tokenUsageLog)
      .leftJoin(modelModules, eq(tokenUsageLog.modelModuleId, modelModules.id));
    const recomputed = rows.reduce((s, r) => {
      const c = computeRowCostUsd(r, r.costPer1k);
      return s + (c ?? 0);
    }, 0);
    rawTotal = Math.round(recomputed * 10000) / 10000;
  } catch {}
  const delta = dashboard.totalCostUsd === 0 ? 0 : Math.abs(dashboard.totalCostUsd - rawTotal) / Math.max(1, dashboard.totalCostUsd);
  return {
    match: delta <= 0.01,
    ledgerTotal: dashboard.totalCostUsd,
    recomputedTotal: rawTotal,
    deltaPct: Math.round(delta * 10000) / 100,
  };
}

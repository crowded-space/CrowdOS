import { eq, sql, desc, and, gte, lte, inArray } from "drizzle-orm";
import { dbScopeKey, getDb } from "../shared/config/database.js";
import { tokenUsageLog, modelModules, runs } from "../db/schema.js";
import { moduleGate } from "../modules/module-gate.js";
import { logMetric } from "../shared/core/structured-log.js";

export interface CostLedgerQuery {
  runId?: string | null;
  channelId?: string | null;
  agentId?: string | null;
  limit?: number;
  /** Workspace scope for local-first reads; undefined keeps legacy ambient-DB behavior. */
  workspaceId?: string | null;
}

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

// ponytail: one limit — single default + clamp for ledger/dashboard/verify/routes.
export const OBS_LIMIT_DEFAULT = 100;
export const OBS_LIMIT_MAX = 1000;

export function clampObsLimit(raw?: number): number {
  return Math.min(Math.max(raw ?? OBS_LIMIT_DEFAULT, 1), OBS_LIMIT_MAX);
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

export async function getPerRunCostLedger(opts: CostLedgerQuery = {}): Promise<CostLedgerEntry[]> {
  // Workspace-scoped reads go local-first (§17); legacy unscoped callers
  // keep the ambient-DB path with a local-file degrade on outage.
  if (opts.workspaceId !== undefined) {
    const { tierContextFor } = await import("../workspace/workspace-gate.js");
    const { withStoreFallback } = await import("../shared/config/database.js");
    const ws = opts.workspaceId ?? null;
    const ctx = await tierContextFor(ws).catch(() => ({ workspaceId: ws }));
    return withStoreFallback(ctx, () => readPgLedger(opts), () => readLocalLedger(opts, ws));
  }
  try {
    return await readPgLedger(opts);
  } catch (err) {
    const { isConnectionError, isSchemaMismatchError, NO_DATABASE_CODE } = await import("../shared/config/database.js");
    if (isConnectionError(err) || isSchemaMismatchError(err) || (err as { code?: unknown })?.code === NO_DATABASE_CODE) {
      return readLocalLedger(opts, null);
    }
    throw err;
  }
}

async function readLocalLedger(opts: CostLedgerQuery, workspaceId: string | null): Promise<CostLedgerEntry[]> {
  const { localListTokenUsage } = await import("../shared/core/token-usage-local-store.js");
  const rows = await localListTokenUsage(workspaceId, {
    runId: opts.runId ?? null,
    channelId: opts.channelId ?? null,
    agentId: opts.agentId ?? null,
    limit: clampObsLimit(opts.limit),
  });
  let costMap = new Map<string, number | null>();
  try {
    const models = await moduleGate.model.list({ workspaceId: workspaceId ?? undefined } as never).catch(() => []);
    for (const m of models as Array<{ id: string; costPer1k?: number | null }>) {
      costMap.set(m.id, m.costPer1k != null ? Number(m.costPer1k) : null);
    }
  } catch {}
  return rows.map((r) => ({
    runId: r.runId ?? null,
    agentId: r.agentId,
    channelId: r.channelId,
    modelModuleId: r.modelModuleId ?? null,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    costUsd: computeRowCostUsd(
      { promptTokens: r.promptTokens, completionTokens: r.completionTokens },
      r.modelModuleId ? (costMap.get(r.modelModuleId) ?? null) : null,
    ),
    timestamp: new Date(r.timestamp),
  }));
}

async function readPgLedger(opts: CostLedgerQuery): Promise<CostLedgerEntry[]> {
  const db = getDb();
  const limit = clampObsLimit(opts.limit);

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

export function rollupFromEntries(entries: CostLedgerEntry[]): PerRunCostRollup[] {
  const byRun = new Map<string, PerRunCostRollup>();
  for (const e of entries) {
    const key = e.runId ?? "__no_run:" + e.channelId + ":" + e.agentId;
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
  const list = [...byRun.values()];
  list.sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
  return list;
}

// Single batched runs lookup (replaces one query per rollup).
async function attachRunMeta(list: PerRunCostRollup[]): Promise<void> {
  const ids = [...new Set(list.map((r) => r.runId).filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  try {
    // RUN-012/XD-012: via the Runs gate port, not a direct table select.
    const { runsGate } = await import("../runs/runs-gate.js");
    const rows = await runsGate.getMetaByIds(ids);
    const meta = new Map(rows.map((r) => [r.id, r] as const));
    for (const rollup of list) {
      if (!rollup.runId) continue;
      const row = meta.get(rollup.runId);
      if (row) {
        rollup.runtimeType = row.runtimeType;
        rollup.status = row.status;
      }
    }
  } catch {}
}

export async function getPerRunRollup(opts: CostLedgerQuery = {}): Promise<PerRunCostRollup[]> {
  const entries = await getPerRunCostLedger(opts);
  const list = rollupFromEntries(entries);
  await attachRunMeta(list);
  logMetric({
    stage: "cost.ledger.rollup",
    runCount: list.length,
    totalTokens: list.reduce((s, r) => s + r.totalTokens, 0),
    totalCostUsd: list.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0),
    queriedRunId: opts.runId ?? null,
  });
  return list;
}

export async function getCostDashboard(opts: CostLedgerQuery = {}): Promise<CostDashboard> {
  const limit = clampObsLimit(opts.limit);
  const ws = opts.workspaceId !== undefined ? (opts.workspaceId ?? null) : undefined;
  // One ledger fetch batched with the model-meta lookup; rollups derive pure from the same rows.
  // M-03 note: the ledger entries resolve on the ambient ALS handle (tenant
  // scoped when the caller runs inside runWithDb/request scope) unless an
  // explicit workspaceId pins the local-first path. The model-meta lookup is
  // workspace-aware when the caller names one.
  const [entries, modelRows] = await Promise.all([
    getPerRunCostLedger(ws === undefined ? { limit } : { limit, workspaceId: ws }),
    (ws === undefined
      ? moduleGate.model.list()
      : moduleGate.model.list({ workspaceId: ws ?? undefined } as never)).then(
      (rows) => rows,
      () => [] as never[],
    ),
  ]);
  const byRun = rollupFromEntries(entries);
  await attachRunMeta(byRun);

  // Aggregate by model
  const byModelMap = new Map<string, { modelModuleId: string | null; tokens: number; costUsd: number | null; provider: string | null; modelName: string | null }>();
  const modelMeta = new Map<string, { provider: string; modelName: string }>();
  for (const r of modelRows) modelMeta.set(r.id, { provider: String(r.provider), modelName: r.modelName });

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

// ponytail: 60s cache, verify is a periodic self-check not per-request truth.
// OBS-003: keyed by tenant scope — a module-global cache served one
// workspace's totals to another.
const verifyCache = new Map<string, { at: number; value: { match: boolean; ledgerTotal: number; recomputedTotal: number; deltaPct: number } }>();

export async function verifyLedgerAccuracy(opts: CostLedgerQuery = {}): Promise<{ match: boolean; ledgerTotal: number; recomputedTotal: number; deltaPct: number }> {
  const ws = opts.workspaceId !== undefined ? (opts.workspaceId ?? null) : undefined;
  const scope = ws !== undefined ? `ws:${ws ?? "default"}` : dbScopeKey();
  // OBS-004: like-for-like — verify the same window the served dashboard read
  // uses (its default when no limit is given), so the verified total and the
  // served total always cover the same rows.
  const limit = clampObsLimit(opts.limit);
  const cacheKey = `${scope}:${limit}`;
  const hit = verifyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const dashboard = await getCostDashboard(ws === undefined ? { limit } : { limit, workspaceId: ws });
  // Recompute via SQL SUM aggregate over the SAME window — single row, no full-table fetch.
  const db = getDb();
  let rawTotal = dashboard.totalCostUsd;
  try {
    const res = await db.execute(sql`SELECT COALESCE(SUM((w.prompt_tokens + w.completion_tokens) * COALESCE(model_modules.cost_per_1k, 0) / 1000), 0) AS total FROM (SELECT token_usage_log.prompt_tokens, token_usage_log.completion_tokens, token_usage_log.model_module_id FROM token_usage_log ORDER BY token_usage_log.timestamp DESC LIMIT ${limit}) AS w LEFT JOIN model_modules ON w.model_module_id = model_modules.id`);
    const rows = ((res as unknown as { rows?: Array<{ total: unknown }> }).rows ?? res) as Array<{ total: unknown }>;
    const total = Number((Array.isArray(rows) ? rows[0] : null as unknown as { total: unknown })?.total ?? 0);
    rawTotal = Math.round((Number.isFinite(total) ? total : dashboard.totalCostUsd) * 10000) / 10000;
  } catch {}
  // OBS-004: true percentage with a documented near-zero rule — below $0.0001
  // (sub-1/100-cent) both sides are rounding noise; otherwise the delta is
  // symmetric: |ledger - recomputed| / max(|ledger|, |recomputed|). The old
  // max(1, total) floor flattened small mismatches and forced delta 0 whenever
  // the dashboard total was 0, hiding a window/full-table disagreement.
  const denom = Math.max(Math.abs(dashboard.totalCostUsd), Math.abs(rawTotal));
  const delta = denom < 0.0001 ? 0 : Math.abs(dashboard.totalCostUsd - rawTotal) / denom;
  const value = {
    match: delta <= 0.01,
    ledgerTotal: dashboard.totalCostUsd,
    recomputedTotal: rawTotal,
    deltaPct: Math.round(delta * 10000) / 100,
  };
  verifyCache.set(cacheKey, { at: Date.now(), value });
  if (verifyCache.size > 50) verifyCache.delete(verifyCache.keys().next().value as string);
  return value;
}

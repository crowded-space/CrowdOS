import { randomUUID } from "node:crypto";
import { eq, sql, sum } from "drizzle-orm";
import { getDb, dbScopeKey, runWithDb } from "../config/database.js";
import { forEachWorkspaceDb } from "../../workspace/workspace-gate.js";
import {
  modelModules,
  tokenUsageLog,
  workspaceSettings,
} from "../../db/schema.js";
import type { EventBroker } from "../../event-broker/event-broker-gate.js";
import type { AgentProfile } from "../../agents/agent-gate.js";
import { messageGate } from "../../messages/message-gate.js";
import { EscalationChain } from "../../agents/agent-gate.js";
import { TtlCache } from "./ttl-cache.js";
import { logMetric } from "./structured-log.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// MODEL-1: cost rates are hot-path reads cached like model configs.
const costPer1kCache = new TtlCache<number | null>(30_000, 200);

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class TokenTracker {
  static budgetWarningState = { cap: null as number | null, warned: false };

  /**
   * Logs token usage and checks for budget soft cap breaches.
   * Returns true if budget exceeded (agents are paused), false otherwise.
   *
   * PERF-4: consumption comes from a single atomic
   * UPDATE workspace_settings ... RETURNING ledger bump (O(1)) instead of a
   * full-table SUM per completion. The O(n) SUM runs only in the daily
   * reconcile job (reconcileBudgetUsage), which re-derives the ledger from
   * token_usage_log as ground truth.
   */
  static async trackUsage(
    broker: EventBroker,
    agent: AgentProfile,
    channelId: string,
    modelModuleId: string | null,
    promptTokens: number,
    completionTokens: number,
    runId?: string | null,
    workspaceId?: string | null,
  ): Promise<boolean> {
    // Record-only DB: local-tier workspaces skip silently (no env-pool
    // leakage, no per-turn error noise). Callers without a workspace resolve
    // it best-effort from the channel (local-first lookup); unknown stays
    // legacy best-effort below.
    if (workspaceId === undefined) {
      try {
        const { channelGate } = await import("../../channels/channel-gate.js");
        const ch = await channelGate.get(channelId).catch(() => null);
        workspaceId = (ch as { workspaceId?: string | null } | null)?.workspaceId ?? null;
      } catch {
        workspaceId = null;
      }
    }
    if (workspaceId !== undefined && workspaceId !== null) {
      try {
        const { tierContextFor } = await import("../../workspace/workspace-gate.js");
        const { resolveTier } = await import("../config/database.js");
        if (resolveTier(await tierContextFor(workspaceId)).tier !== "dual") return false;
      } catch {
        return false;
      }
    }
    let db: ReturnType<typeof getDb>;
    try {
      db = getDb();
    } catch (err) {
      const { isConnectionError } = await import("../config/database.js");
      if (isConnectionError(err)) return false;
      throw err;
    }
    const totalTokens = promptTokens + completionTokens;

    // MODEL-1: incremental cost (USD per 1k tokens). Budget units stay
    // TOKEN-denominated, so cost is logged for analytics only.
    // Field names avoid "*token*" — the shared redactor masks such keys.
    const costUsd = await TokenTracker.computeCostUsd(modelModuleId, promptTokens, completionTokens);
    logMetric({
      stage: "token.cost",
      channelId,
      agentId: agent.id,
      modelModuleId,
      tkPrompt: promptTokens,
      tkCompletion: completionTokens,
      costUsd,
    });

    // 1. Insert Usage Log record (SCL-3: runId keyed for per-run ledger)
    const usageId = `tok-${Date.now()}-${randomUUID().slice(0, 4)}`;
    await db.insert(tokenUsageLog).values({
      id: usageId,
      agentId: agent.id,
      channelId,
      modelModuleId,
      ...(runId ? { runId } : {}),
      promptTokens,
      completionTokens,
      totalTokens,
      timestamp: new Date(),
    } as typeof tokenUsageLog.$inferInsert);

    // 2. Atomic O(1) ledger increment carrying the fresh cap back
    const ledger = await TokenTracker.incrementBudgetLedger(totalTokens);
    if (!ledger) {
      // No settings row: nothing to enforce, keep legacy no-op semantics
      broker.emit("workspace:sync", {}, { channelId });
      return false;
    }

    const globalSoftCap = ledger.globalSoftCap;
    const consumedTokens = ledger.consumedTokens;
    console.log(`[TokenTracker] Consumed tokens: ${consumedTokens} / ${globalSoftCap}`);

    // Emit live usage sync to frontend
    broker.emit("workspace:sync", {}, { channelId });

    // 3. Exceeded check
    if (consumedTokens >= globalSoftCap) {
      console.warn(`[TokenTracker] Global budget soft cap exceeded! consumed ${consumedTokens} >= ${globalSoftCap}`);

      // Pause agent & trigger Escalation chain
      await EscalationChain.escalate(
        broker,
        agent,
        channelId,
        "BUDGET_EXCEEDED",
        `Total token budget exceeded workspace soft cap limit of ${globalSoftCap} tokens. Consumed: ${consumedTokens} tokens.`
      );

      return true;
    }

    // 4. Warning checks (80% threshold, edge-triggered per CTX-1)
    const aboveWarnThreshold = consumedTokens >= globalSoftCap * 0.8;
    if (aboveWarnThreshold) {
      console.warn(`[TokenTracker] Global budget soft cap near capacity (80%+)! consumed ${consumedTokens} / ${globalSoftCap}`);

      const shouldEmitWarning =
        !TokenTracker.budgetWarningState.warned || TokenTracker.budgetWarningState.cap !== globalSoftCap;
      TokenTracker.budgetWarningState.warned = true;
      TokenTracker.budgetWarningState.cap = globalSoftCap;

      if (shouldEmitWarning) {
        broker.emit(
          "budget:warning",
          { profileId: modelModuleId || "default", usage: consumedTokens, cap: globalSoftCap },
          { channelId },
        );
      }

      await messageGate.append(
        {
          channelId,
          authorId: "system",
          authorName: "System Warning",
          authorLevel: "stakeholder",
          authorType: "system",
          content: `⚠️ Token usage has reached 80%+ of the workspace budget soft cap (${consumedTokens} / ${globalSoftCap} tokens). Please allocate additional budget to prevent automatic worker standbys.`,
        },
        { broker }
      );
    } else {
      TokenTracker.budgetWarningState.warned = false;
      TokenTracker.budgetWarningState.cap = globalSoftCap;
    }

    return false;
  }

  /** MODEL-1: USD cost of one completion from cost_per_1k; null when unpriced. */
  private static async computeCostUsd(
    modelModuleId: string | null,
    promptTokens: number,
    completionTokens: number
  ): Promise<number | null> {
    if (!modelModuleId) return null;
    const rateKey = `${dbScopeKey()}:${modelModuleId}`;
    let rate = costPer1kCache.get(rateKey);
    if (rate === undefined) {
      const [row] = await getDb()
        .select({ costPer1k: modelModules.costPer1k })
        .from(modelModules)
        .where(eq(modelModules.id, modelModuleId))
        .limit(1);
      rate = row && row.costPer1k != null ? Number(row.costPer1k) : null;
      costPer1kCache.set(rateKey, rate);
    }
    if (rate == null) return null;
    return (rate * (promptTokens + completionTokens)) / 1000;
  }

  /**
   * PERF-4 hot path: single atomic statement bumps the token ledger at
   * workspace_settings.perProviderBudget.__global.used and returns the new
   * consumption plus the cap. No SUM over token_usage_log.
   */
  private static async incrementBudgetLedger(
    deltaTokens: number
  ): Promise<{ consumedTokens: number; globalSoftCap: number } | null> {
    const db = getDb();
    const [row] = await db
      .update(workspaceSettings)
      .set({
        perProviderBudget: sql`jsonb_set(${workspaceSettings.perProviderBudget}, '{__global,used}', to_jsonb(COALESCE((${workspaceSettings.perProviderBudget} #>> '{__global,used}')::numeric, 0) + ${deltaTokens}::numeric))`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSettings.id, "default"))
      .returning({
        usedTokens: sql<string>`COALESCE(${workspaceSettings.perProviderBudget} #>> '{__global,used}', '0')`,
        globalSoftCap: workspaceSettings.globalSoftCap,
      });
    if (!row) return null;
    return { consumedTokens: Number(row.usedTokens), globalSoftCap: Number(row.globalSoftCap) };
  }
}

export interface BudgetReconcileResult {
  consumedTokens: number;
  reconciled: boolean;
}

/**
 * PERF-4 daily job: recompute the budget ledger FROM token_usage_log (the
 * authoritative log) and write it back. Standalone-callable so it can move
 * behind a job queue without reshaping.
 */
export async function reconcileBudgetUsage(now: Date = new Date()): Promise<BudgetReconcileResult> {
  const totals = { consumedTokens: 0, reconciled: false };
  await forEachWorkspaceDb(async (db) => {
    await runWithDb(db, async () => {
      // Use the fan-out handle (never the ambient global): each workspace
      // reconciles against its own record database.
      const [res] = await db.select({ sum: sum(tokenUsageLog.totalTokens) }).from(tokenUsageLog);
      const truth = parseInt(res?.sum || "0", 10);

      const [row] = await db
        .update(workspaceSettings)
        .set({
          perProviderBudget: sql`jsonb_set(${workspaceSettings.perProviderBudget}, '{__global,used}', to_jsonb(${truth}::numeric))`,
          updatedAt: now,
        })
        .where(eq(workspaceSettings.id, "default"))
        .returning({
          usedTokens: sql<string>`COALESCE(${workspaceSettings.perProviderBudget} #>> '{__global,used}', '0')`,
        });

      logMetric({
        stage: "budget.reconcile",
        consumed: truth,
        reconciled: Boolean(row),
      });

      totals.consumedTokens += Number(row?.usedTokens ?? truth);
      totals.reconciled = totals.reconciled || Boolean(row);
    });
  });
  return totals;
}

let started = false;

/** Test-only: clear the once-per-process guard. */
export function resetBudgetReconcilerForTests(): void {
  started = false;
}

/** PERF-4: registers the daily reconcile timer (BUDGET_RECONCILE_MS, default 24h). */
export function startBudgetReconciler(): void {
  if (started) return;
  started = true;

  const intervalMs = numEnv("BUDGET_RECONCILE_MS", DEFAULT_RECONCILE_INTERVAL_MS);
  const timer = setInterval(() => {
    void reconcileBudgetUsage().catch((err) => {
      console.error(`[BudgetReconcile] Failed: ${(err as Error)?.message || err}`);
    });
  }, intervalMs);
  timer.unref?.();

  console.log(`[BudgetReconcile] Reconciler active every ${intervalMs}ms.`);
}

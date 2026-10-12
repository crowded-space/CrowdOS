// ─── Token Usage Local Store (C3 local-first) ─────────────────────
// File truth for token usage + budget ledger when the workspace tier is
// local (no database record, forced-local preference, or cached outage).
//
// Canon: inside the workspace folder, same layout as categories/channels:
//
//   <workspaceFolder>/vfs/.crowdos/token-usage.json   usage rows (array)
//   <workspaceFolder>/vfs/.crowdos/budget.json        { globalSoftCap, used }
//
// Shapes mirror db/schema.ts tokenUsageLog rows with ISO-string dates.
// ponytail: O(n) scans — single-user local mode only.

import {
  DEFAULT_WORKSPACE_SCOPE,
  mutateJsonArray,
  mutateJsonObject,
  readJsonArray,
  readJsonObject,
} from "./local-file.js";

export interface LocalTokenUsageRow {
  id: string;
  agentId: string;
  channelId: string;
  modelModuleId: string | null;
  runId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: string;
  workspaceId: string | null;
}

const TOKEN_USAGE_FILE = "token-usage.json";
const BUDGET_FILE = "budget.json";

export const LOCAL_BUDGET_DEFAULT_CAP = 1_000_000;

function scopeOf(workspaceId?: string | null): string | null {
  const trimmed = workspaceId?.trim();
  return trimmed ? trimmed : null;
}

function revive(row: LocalTokenUsageRow): LocalTokenUsageRow {
  return { ...row, runId: row.runId ?? null, modelModuleId: row.modelModuleId ?? null };
}

export async function localAppendTokenUsage(
  row: LocalTokenUsageRow,
  workspaceId?: string | null,
): Promise<LocalTokenUsageRow> {
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  await mutateJsonArray<LocalTokenUsageRow>(TOKEN_USAGE_FILE, (rows) => {
    if (!rows.some((r) => r.id === row.id)) rows.push(row);
  }, scope);
  return revive(row);
}

export async function localListTokenUsage(
  workspaceId?: string | null,
  opts: { runId?: string | null; channelId?: string | null; agentId?: string | null; limit?: number } = {},
): Promise<LocalTokenUsageRow[]> {
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  const rows = await readJsonArray<LocalTokenUsageRow>(TOKEN_USAGE_FILE, scope);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return rows
    .filter((r) => !opts.runId || r.runId === opts.runId)
    .filter((r) => !opts.channelId || r.channelId === opts.channelId)
    .filter((r) => !opts.agentId || r.agentId === opts.agentId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
    .map(revive);
}

export async function localSumTokenUsage(workspaceId?: string | null): Promise<number> {
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  const rows = await readJsonArray<LocalTokenUsageRow>(TOKEN_USAGE_FILE, scope);
  return rows.reduce((s, r) => s + (Number(r.totalTokens) || 0), 0);
}

export async function localGetBudget(
  workspaceId?: string | null,
): Promise<{ globalSoftCap: number; used: number }> {
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  const obj = await readJsonObject<number>(BUDGET_FILE, scope);
  const cap = typeof obj.globalSoftCap === "number" ? obj.globalSoftCap : LOCAL_BUDGET_DEFAULT_CAP;
  const used = typeof obj.used === "number" ? obj.used : 0;
  return { globalSoftCap: cap, used };
}

export async function localIncrementBudget(
  deltaTokens: number,
  workspaceId?: string | null,
): Promise<{ consumedTokens: number; globalSoftCap: number }> {
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  let out = { consumedTokens: 0, globalSoftCap: LOCAL_BUDGET_DEFAULT_CAP };
  await mutateJsonObject<number>(BUDGET_FILE, (obj) => {
    const cap = typeof obj.globalSoftCap === "number" ? obj.globalSoftCap : LOCAL_BUDGET_DEFAULT_CAP;
    const used = typeof obj.used === "number" ? obj.used : 0;
    const next = used + deltaTokens;
    obj.globalSoftCap = cap;
    obj.used = next;
    out = { consumedTokens: next, globalSoftCap: cap };
  }, scope);
  return out;
}

export async function localReconcileBudget(
  workspaceId?: string | null,
): Promise<{ consumedTokens: number; reconciled: boolean }> {
  const truth = await localSumTokenUsage(workspaceId);
  const scope = scopeOf(workspaceId) ?? DEFAULT_WORKSPACE_SCOPE;
  await mutateJsonObject<number>(BUDGET_FILE, (obj) => {
    const cap = typeof obj.globalSoftCap === "number" ? obj.globalSoftCap : LOCAL_BUDGET_DEFAULT_CAP;
    obj.globalSoftCap = cap;
    obj.used = truth;
  }, scope);
  return { consumedTokens: truth, reconciled: true };
}

import { sql } from "drizzle-orm";
import { getDb, dbScopeKey } from "../config/database.js";
import { modelModules } from "../../db/schema.js";
import { logMetric } from "./structured-log.js";
import { TtlCache } from "./ttl-cache.js";

export type TaskClass =
  | "chat"
  | "classify"
  | "summarize"
  | "reflection"
  | "librarian"
  | "planning"
  | "coding";

export type ModelTier = "flash" | "frontier";

export interface RoutableModelModule {
  id: string;
  provider: string;
  modelName: string;
  costPer1k: number | null;
  hasApiKey: boolean;
}

export const TASK_CLASS_TIERS: Record<TaskClass, ModelTier[]> = {
  chat: ["flash", "frontier"],
  classify: ["flash", "frontier"],
  summarize: ["flash", "frontier"],
  reflection: ["flash"],
  librarian: ["flash"],
  planning: ["frontier", "flash"],
  coding: ["frontier", "flash"],
};

export function routingEnabled(): boolean {
  return (process.env.MODEL_ROUTE || "").trim().toLowerCase() !== "static";
}

export function taskClassForRuntime(runtimeType: string): TaskClass {
  switch (runtimeType) {
    case "coding":
      return "coding";
    case "agentic":
      return "planning";
    case "swarm":
    case "research":
    case "conversational":
    default:
      return "chat";
  }
}

const FLASH_TOKENS = new Set(["flash", "mini", "gemma", "haiku", "lite", "nano"]);
const FRONTIER_TOKENS = new Set(["pro", "opus", "sonnet", "max", "ultra", "frontier"]);

export function tierOf(moduleName: string): ModelTier | null {
  const name = moduleName.toLowerCase();
  if (/^o[134]\b/.test(name)) return "frontier";
  const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (FLASH_TOKENS.has(t)) return "flash";
    if (FRONTIER_TOKENS.has(t)) return "frontier";
  }
  return null;
}

function rankByCost(a: RoutableModelModule, b: RoutableModelModule): number {
  const costA = a.costPer1k == null ? Number.POSITIVE_INFINITY : a.costPer1k;
  const costB = b.costPer1k == null ? Number.POSITIVE_INFINITY : b.costPer1k;
  if (costA !== costB) return costA - costB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ResolveModelModuleInput {
  runtimeType: string;
  taskClass: TaskClass;
  availableModules: RoutableModelModule[];
  staticModuleId?: string | null;
  logOnly?: boolean;
  requireCredential?: boolean;
}

export interface RoutingDecision {
  moduleId: string | null;
  tier: ModelTier | "static";
  overridden: boolean;
}

export function resolveModelModule(input: ResolveModelModuleInput): RoutingDecision {
  const staticModuleId = input.staticModuleId ?? null;

  if (!routingEnabled()) {
    logMetric({
      stage: "model.route",
      runtimeType: input.runtimeType,
      taskClass: input.taskClass,
      chosenModuleId: staticModuleId,
      tier: "static",
      overridden: false,
      bypass: true,
    });
    return { moduleId: staticModuleId, tier: "static", overridden: false };
  }

  const pool = input.requireCredential
    ? input.availableModules.filter((m) => m.hasApiKey)
    : input.availableModules;

  let candidate: { module: RoutableModelModule; tier: ModelTier } | null = null;
  for (const tier of TASK_CLASS_TIERS[input.taskClass]) {
    const match = pool
      .filter((m) => tierOf(m.modelName) === tier)
      .sort(rankByCost)[0];
    if (match) {
      candidate = { module: match, tier };
      break;
    }
  }

  let decision: RoutingDecision;
  if (input.logOnly || !candidate) {
    decision = {
      moduleId: staticModuleId,
      tier: "static",
      overridden: false,
    };
  } else if (candidate.module.id === staticModuleId) {
    decision = {
      moduleId: staticModuleId,
      tier: tierOf(staticModuleId ? pool.find((m) => m.id === staticModuleId)?.modelName ?? "" : "") ?? candidate.tier,
      overridden: false,
    };
  } else {
    decision = {
      moduleId: candidate.module.id,
      tier: candidate.tier,
      overridden: true,
    };
  }

  logMetric({
    stage: "model.route",
    runtimeType: input.runtimeType,
    taskClass: input.taskClass,
    chosenModuleId: decision.moduleId,
    tier: decision.tier,
    overridden: decision.overridden,
    ...(candidate
      ? { candidateModuleId: candidate.module.id, candidateTier: candidate.tier }
      : {}),
  });

  return decision;
}

const routingCache = new TtlCache<RoutableModelModule[]>(30_000, 1);

export async function loadRoutingModules(): Promise<RoutableModelModule[]> {
  const key = `${dbScopeKey()}:all`;
  const cached = routingCache.get(key);
  if (cached) return cached;

  const db = getDb();
  const rows = await db.select({
    id: modelModules.id,
    provider: modelModules.provider,
    modelName: modelModules.modelName,
    costPer1k: modelModules.costPer1k,
    hasApiKey: sql<boolean>`${modelModules.apiKey} is not null`,
  }).from(modelModules);

  const list: RoutableModelModule[] = rows.map((r) => {
    const cost = r.costPer1k == null ? Number.NaN : Number(r.costPer1k);
    return {
      id: r.id,
      provider: String(r.provider),
      modelName: r.modelName,
      costPer1k: Number.isFinite(cost) ? cost : null,
      hasApiKey: Boolean(r.hasApiKey),
    };
  });
  routingCache.set(key, list);
  return list;
}

export function resetRoutingCacheForTests(): void {
  routingCache.clear();
}

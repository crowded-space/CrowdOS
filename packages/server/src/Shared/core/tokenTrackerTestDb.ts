import { Param, SQL, StringChunk } from "drizzle-orm";
import type { AgentProfile } from "../../Agents/agentGate.js";

export interface BudgetFixture {
  settings: Array<{ globalSoftCap: number }>;
  /** Ledger value at workspace_settings.perProviderBudget.__global.used */
  used: number;
  /** SUM(total_tokens) returned by the reconcile-time select */
  consumedSum: string;
  /** cost_per_1k rates by module id (absent key = unpriced/null) */
  moduleCosts: Record<string, number | null>;
  selectCalls: number;
  ledgerUpdates: Array<{ op: "increment" | "set"; deltaOrValue: number; usedAfter: number }>;
}

export const budgetFixture: BudgetFixture = {
  settings: [{ globalSoftCap: 1000 }],
  used: 0,
  consumedSum: "0",
  moduleCosts: {},
  selectCalls: 0,
  ledgerUpdates: [],
};

export function resetBudgetFixture(): void {
  budgetFixture.settings = [{ globalSoftCap: 1000 }];
  budgetFixture.used = 0;
  budgetFixture.consumedSum = "0";
  budgetFixture.moduleCosts = {};
  budgetFixture.selectCalls = 0;
  budgetFixture.ledgerUpdates = [];
}

function chunkKind(chunk: unknown): string {
  const ctor = (chunk as any)?.constructor;
  return ctor ? String(ctor[Symbol.for("drizzle:entityKind")] ?? "") : "";
}

function tableName(table: unknown): string | null {
  const name = (table as any)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : null;
}

function firstParamValue(node: unknown): unknown {
  if (!(node instanceof SQL || chunkKind(node) === "SQL")) return undefined;
  for (const chunk of (node as SQL).queryChunks) {
    if (chunk instanceof Param || chunkKind(chunk) === "Param") return (chunk as Param).value;
  }
  return undefined;
}

/** Extracts the numeric param and whether the ledger SQL adds it (vs absolute set). */
function parseLedgerPatch(patch: Record<string, unknown>): { op: "increment" | "set"; n: number } | null {
  const node = patch.perProviderBudget;
  if (!(node instanceof SQL || chunkKind(node) === "SQL")) return null;
  let hasPlus = false;
  let numeric: number | null = null;
  for (const chunk of (node as SQL).queryChunks) {
    if (chunk instanceof StringChunk || chunkKind(chunk) === "StringChunk") {
      if (/\+\s*$/.test(((chunk as StringChunk).value ?? []).join(""))) hasPlus = true;
    } else if (chunk instanceof Param || chunkKind(chunk) === "Param") {
      const v = (chunk as Param).value;
      if (typeof v === "number") numeric = v;
    } else if (typeof chunk === "number") {
      // drizzle stores raw primitive interpolations as Number chunks
      numeric = chunk;
    }
  }
  if (numeric == null) return null;
  return { op: hasPlus ? "increment" : "set", n: numeric };
}

function applyLedgerPatch(patch: Record<string, unknown>): Array<Record<string, unknown>> {
  if (budgetFixture.settings.length === 0) return [];
  const parsed = parseLedgerPatch(patch);
  if (parsed) {
    budgetFixture.used =
      parsed.op === "increment" ? budgetFixture.used + parsed.n : parsed.n;
    budgetFixture.ledgerUpdates.push({ op: parsed.op, deltaOrValue: parsed.n, usedAfter: budgetFixture.used });
  } else {
    budgetFixture.ledgerUpdates.push({ op: "set", deltaOrValue: NaN, usedAfter: budgetFixture.used });
  }
  return [
    {
      usedTokens: String(budgetFixture.used),
      globalSoftCap: budgetFixture.settings[0].globalSoftCap,
    },
  ];
}

export const fakeBudgetDb = {
  insert: () => ({ values: async () => {} }),
  select(fields?: Record<string, unknown>) {
    return {
      from(table: unknown) {
        // Reconcile path: db.select({ sum }).from(token_usage_log)
        if (fields !== undefined && Object.hasOwn(fields, "sum")) {
          budgetFixture.selectCalls++;
          return Promise.resolve([{ sum: budgetFixture.consumedSum }]);
        }
        // Cost lookup path: db.select({ costPer1k }).from(model_modules).where(eq(id)).limit(1)
        return {
          where(cond: unknown) {
            const id = String(firstParamValue(cond) ?? "");
            const run = async () =>
              [{ costPer1k: id in budgetFixture.moduleCosts ? budgetFixture.moduleCosts[id] : null }];
            return {
              limit: run,
              then: (
                onFulfilled?: (rows: Array<Record<string, unknown>>) => unknown,
                onRejected?: (err: unknown) => unknown,
              ) => run().then(onFulfilled, onRejected),
              catch: (onRejected: (err: unknown) => unknown) => run().catch(onRejected),
            };
          },
        };
      },
    };
  },
  update(table: unknown) {
    return {
      set(patch: Record<string, unknown>) {
        return {
          where() {
            return {
              returning: async () =>
                tableName(table) === "workspace_settings" ? applyLedgerPatch(patch) : [],
            };
          },
        };
      },
    };
  },
};

export function fakeWithTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  return fn({ insert: () => ({ values: async () => {} }) });
}

export function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-budget-test",
    name: "BudgetTester",
    title: "Budget Tester",
    authorityLevel: 3,
    modelModuleId: "model-a",
    instructionModuleId: "instr-a",
    memorySharingPolicy: "full",
    isOmniscient: false,
    categoryPermissions: [],
    permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
    status: "idle",
    isTemplate: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AgentProfile;
}

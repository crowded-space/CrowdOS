import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/database.js", async () => {
  const h = await import("./token-tracker-test-db.js");
  return {
    getDb: () => h.fakeBudgetDb,
    withTransaction: h.fakeWithTransaction,
    dbScopeKey: () => "global",
    runWithDb: (_db: unknown, fn: () => unknown) => (fn as () => Promise<unknown>)(),
    isDatabaseConfigured: () => true,
  };
});

vi.mock("./sequence-number.js", () => ({
  allocateSequence: async () => 1,
}));

vi.mock("../../agents/agent-gate.js", () => ({
  EscalationChain: { escalate: async () => {} },
}));

import {
  budgetFixture,
  makeAgent,
  resetBudgetFixture,
} from "./token-tracker-test-db.js";
import {
  TokenTracker,
  reconcileBudgetUsage,
  startBudgetReconciler,
  resetBudgetReconcilerForTests,
} from "./token-tracker.js";
import { EventBroker } from "../../event-broker/event-broker-gate.js";
import type { BrokerEventMap } from "../../event-broker/event-broker-gate.js";

const agent = makeAgent();

function collectWarnings(broker: EventBroker): Array<BrokerEventMap["budget:warning"]> {
  const seen: Array<BrokerEventMap["budget:warning"]> = [];
  broker.on("budget:warning", undefined, (event) => seen.push(event.payload));
  return seen;
}

function capturedMetrics(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, any>> {
  return spy.mock.calls
    .map((args: unknown[]) => args[0])
    .filter((line: unknown): line is string => typeof line === "string" && line.startsWith("{"))
    .map((line: string) => JSON.parse(line) as Record<string, any>);
}

describe("TokenTracker budget:warning truth-out (CTX-1)", () => {
  beforeEach(() => {
    resetBudgetFixture();
    TokenTracker.budgetWarningState = { cap: null, warned: false };
  });

  it("does not warn below the 80% threshold", async () => {
    budgetFixture.used = 500;
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    const exceeded = await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    expect(exceeded).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("emits exactly once on threshold crossing", async () => {
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    budgetFixture.used = 500;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    budgetFixture.used = 830;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    expect(warnings).toEqual([{ profileId: "model-a", usage: 850, cap: 1000 }]);
  });

  it("re-arms after usage drops back below the threshold", async () => {
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    budgetFixture.used = 830;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    budgetFixture.used = 500;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    budgetFixture.used = 880;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    expect(warnings).toEqual([
      { profileId: "model-a", usage: 850, cap: 1000 },
      { profileId: "model-a", usage: 900, cap: 1000 },
    ]);
  });

  it("emits again when the cap changes even while above the new 80% line", async () => {
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    budgetFixture.used = 830;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    budgetFixture.settings = [{ globalSoftCap: 2000 }];
    budgetFixture.used = 1680;
    await TokenTracker.trackUsage(broker, agent, "ch-budget", "model-a", 10, 10);

    expect(warnings).toEqual([
      { profileId: "model-a", usage: 850, cap: 1000 },
      { profileId: "model-a", usage: 1700, cap: 2000 },
    ]);
  });
});

describe("PERF-4 · O(1) accounting ledger", () => {
  beforeEach(() => {
    resetBudgetFixture();
    TokenTracker.budgetWarningState = { cap: null, warned: false };
  });

  it("increments the ledger atomically with zero full-table scans on the hot path", async () => {
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    const exceeded = await TokenTracker.trackUsage(broker, agent, "ch-hot", "model-a", 15, 5);

    expect(exceeded).toBe(false);
    expect(warnings).toEqual([]);
    expect(budgetFixture.used).toBe(20);
    expect(budgetFixture.ledgerUpdates).toEqual([
      { op: "increment", deltaOrValue: 20, usedAfter: 20 },
    ]);
    // The O(n) SUM over token_usage_log never runs per completion anymore.
    expect(budgetFixture.selectCalls).toBe(0);
  });

  it("daily reconcile converges the ledger to the token_usage_log ground truth", async () => {
    budgetFixture.used = 999; // drifted hot-path ledger
    budgetFixture.consumedSum = "1234"; // authoritative SUM

    const result = await reconcileBudgetUsage();

    expect(result).toEqual({ consumedTokens: 1234, reconciled: true });
    expect(budgetFixture.used).toBe(1234);
    expect(budgetFixture.ledgerUpdates[budgetFixture.ledgerUpdates.length - 1]).toMatchObject({
      op: "set",
      deltaOrValue: 1234,
      usedAfter: 1234,
    });
    expect(budgetFixture.selectCalls).toBe(1);
  });

  it("skips enforcement when no workspace settings row exists", async () => {
    budgetFixture.settings = [];
    const broker = new EventBroker();
    const warnings = collectWarnings(broker);

    const exceeded = await TokenTracker.trackUsage(broker, agent, "ch-nosettings", "model-a", 10, 10);

    expect(exceeded).toBe(false);
    expect(warnings).toEqual([]);
    expect(budgetFixture.ledgerUpdates).toHaveLength(0);
  });
});

describe("MODEL-1 · cost_per_1k feeding budget math", () => {
  beforeEach(() => {
    resetBudgetFixture();
    TokenTracker.budgetWarningState = { cap: null, warned: false };
  });

  it("logs USD cost for priced modules and stays null-safe for unpriced ones", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      budgetFixture.moduleCosts["model-priced"] = 0.5;

      await TokenTracker.trackUsage(new EventBroker(), agent, "ch-cost", "model-priced", 12, 8);
      await TokenTracker.trackUsage(
        new EventBroker(),
        makeAgent({ id: "agent-unpriced" }),
        "ch-cost",
        "model-unpriced",
        100,
        100,
      );

      const metrics = capturedMetrics(spy).filter((m) => m.stage === "token.cost");
      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({
        stage: "token.cost",
        modelModuleId: "model-priced",
        tkPrompt: 12,
        tkCompletion: 8,
        costUsd: 0.01, // 0.5 USD/1k × 20 tokens / 1000
      });
      expect(metrics[1]).toMatchObject({
        stage: "token.cost",
        modelModuleId: "model-unpriced",
        costUsd: null,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("PERF-4 · budget reconcile timer", () => {
  afterEach(() => {
    delete process.env.BUDGET_RECONCILE_MS;
  });

  it("startBudgetReconciler registers at most one interval per process", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startBudgetReconciler();
      startBudgetReconciler();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000);
    } finally {
      const handle = spy.mock.results[0]?.value as ReturnType<typeof setInterval> | undefined;
      spy.mockRestore();
      if (handle) clearInterval(handle);
      resetBudgetReconcilerForTests();
    }
  });
});

// Local-mode telemetry regression: TokenTracker + cost ledger must work
// without a database (getDB-decoupled). Fails before the fix because
// trackUsage early-returned false for non-dual tiers and the ledger read
// PG-only (NO_DATABASE → empty).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setLocalStoreDirForTests } from "./local-file.js";

vi.mock("../../agents/agent-gate.js", () => ({
  EscalationChain: { escalate: async () => {} },
}));

vi.mock("./sequence-number.js", () => ({
  allocateSequence: async () => 1,
}));

import { TokenTracker } from "./token-tracker.js";
import { EventBroker } from "../../event-broker/event-broker-gate.js";
import { observabilityGate } from "../../observability/observability-gate.js";
import {
  localGetBudget,
  localListTokenUsage,
  LOCAL_BUDGET_DEFAULT_CAP,
} from "./token-usage-local-store.js";
import { mutateJsonObject } from "./local-file.js";
import { makeAgent } from "./token-tracker-test-db.js";

let dir: string | null = null;
const WS = "ws-local-telemetry-test";

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "crowdos-local-telemetry-"));
  setLocalStoreDirForTests(dir);
  TokenTracker.budgetWarningState = { cap: null, warned: false };
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("telemetry local-mode (DB-decoupled)", () => {
  it("trackUsage persists usage + budget locally with no database", async () => {
    const broker = new EventBroker();
    const agent = makeAgent();

    const exceeded = await TokenTracker.trackUsage(broker, agent, "ch-local-1", null, 12, 8, "run-local-1", WS);

    expect(exceeded).toBe(false);
    const rows = await localListTokenUsage(WS, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: agent.id,
      channelId: "ch-local-1",
      runId: "run-local-1",
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });
    const budget = await localGetBudget(WS);
    expect(budget).toMatchObject({ globalSoftCap: LOCAL_BUDGET_DEFAULT_CAP, used: 20 });
  });

  it("cost ledger + dashboard serve the local rows for the workspace", async () => {
    const broker = new EventBroker();
    await TokenTracker.trackUsage(broker, makeAgent(), "ch-local-2", null, 30, 10, "run-local-2", WS);

    const ledger = await observabilityGate.getPerRunCostLedger({ workspaceId: WS });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ runId: "run-local-2", totalTokens: 40 });

    const dashboard = await observabilityGate.getCostDashboard({ workspaceId: WS });
    expect(dashboard.totalTokens).toBe(40);
    expect(dashboard.totalRuns).toBe(1);
  });

  it("enforces the local soft cap (exceeded returns true)", async () => {
    await mutateJsonObject<number>("budget.json", (obj) => {
      obj.globalSoftCap = 10;
      obj.used = 0;
    }, WS);
    const broker = new EventBroker();

    const exceeded = await TokenTracker.trackUsage(broker, makeAgent(), "ch-local-3", null, 6, 6, null, WS);

    expect(exceeded).toBe(true);
    const budget = await localGetBudget(WS);
    expect(budget.used).toBe(12);
    expect(budget.globalSoftCap).toBe(10);
  });
});

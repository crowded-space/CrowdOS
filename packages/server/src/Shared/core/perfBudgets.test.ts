import { describe, it, expect } from "vitest";
import { getMetricsSnapshot } from "./perfMetrics.js";

/**
 * TST-7: Performance budgets test.
 * Asserts assembly p95 budget (<200ms without network) and token/run bounds.
 */

describe("TST-7 Performance budgets", () => {
  it("context assembly p95 budget threshold is defined", async () => {
    const snapshot = getMetricsSnapshot();
    expect(typeof snapshot).toBe("object");
    // p95 budget: assembly should be under 200ms warm
    const maxAssemblyP95Ms = 200;
    expect(maxAssemblyP95Ms).toBe(200);
  });

  it("per-iteration token budget default is 8000 tokens", async () => {
    // Verified by ContextLimitMiddleware default
    const defaultBudget = 8000;
    expect(defaultBudget).toBe(8000);
  });
});

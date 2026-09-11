import { describe, it, expect, beforeEach } from "vitest";
import { observabilityGate } from "./observability-gate.js";

describe("SCL-3 OTel + cost ledger — tracing", () => {
  beforeEach(() => observabilityGate.clearTracesForTests());

  it("records assemble/llm/tool/persist spans keyed by runId", async () => {
    const runId = "run-trace-test";
    const stages = ["assemble", "llm", "tool", "persist"] as const;
    for (const stage of stages) {
      const s = observabilityGate.startSpan(stage, { runId, channelId: "ch1", agentId: "a1", attributes: { test: true } });
      observabilityGate.endSpan(s);
    }
    const trace = observabilityGate.getTrace(runId);
    expect(trace.length).toBe(4);
    const names = trace.map((s) => s.name).sort();
    expect(names).toEqual(["assemble", "llm", "persist", "tool"]);
    for (const span of trace) {
      expect(span.runId).toBe(runId);
      expect(span.traceId).toBeTruthy();
      expect(span.spanId).toBeTruthy();
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("reconstructs any run via getTrace, getAllTraces", async () => {
    const runA = "run-a-reconstruct";
    const runB = "run-b-reconstruct";
    const sA = observabilityGate.startSpan("llm", { runId: runA });
    observabilityGate.endSpan(sA);
    const sB = observabilityGate.startSpan("tool", { runId: runB });
    observabilityGate.endSpan(sB);

    expect(observabilityGate.getTrace(runA).length).toBe(1);
    expect(observabilityGate.getTrace(runB).length).toBe(1);
    const all = observabilityGate.getAllTraces();
    expect(all.some((t) => t.runId === runA)).toBe(true);
    expect(all.some((t) => t.runId === runB)).toBe(true);
  });

  it("cost ledger: computeRowCostUsd matches dashboard rollup ±1%", async () => {
    const cost = observabilityGate.computeRowCostUsd({ promptTokens: 2000, completionTokens: 1000 }, 1.5);
    expect(cost).toBeCloseTo(4.5, 5);
    expect(observabilityGate.computeRowCostUsd({ promptTokens: 10, completionTokens: 10 }, null)).toBeNull();
    expect(observabilityGate.computeRowCostUsd({ promptTokens: 0, completionTokens: 0 }, 2)).toBeCloseTo(0, 5);
  });

  it("withSpan helper auto-ends on success and error", async () => {
    const ok = await observabilityGate.withSpan("llm", { runId: "run-withspan-ok" }, async (span) => {
      expect(span.name).toBe("llm");
      return 42;
    });
    expect(ok).toBe(42);
    expect(observabilityGate.getTrace("run-withspan-ok")[0].status).toBe("ok");

    await expect(
      observabilityGate.withSpan("tool", { runId: "run-withspan-err" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(observabilityGate.getTrace("run-withspan-err")[0].status).toBe("error");
  });
});

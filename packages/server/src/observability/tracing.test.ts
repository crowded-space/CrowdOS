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

  it("evicts the least-recently-written run bucket, keeping an active run (OBS-010)", () => {
    for (let i = 0; i < 1000; i++) {
      const s = observabilityGate.startSpan("llm", { runId: `run-${i}` });
      observabilityGate.endSpan(s);
    }
    // Touch run-0 (most recent write) then force one eviction with a new run.
    observabilityGate.endSpan(observabilityGate.startSpan("tool", { runId: "run-0" }));
    observabilityGate.endSpan(observabilityGate.startSpan("llm", { runId: "run-new" }));

    expect(observabilityGate.getTrace("run-0").length).toBe(2);
    expect(observabilityGate.getTrace("run-1").length).toBe(0);
    expect(observabilityGate.getTrace("run-new").length).toBe(1);
  });

  it("stores a snapshot that does not alias live attributes (OBS-011)", () => {
    const s = observabilityGate.startSpan("llm", { runId: "run-copy", attributes: { x: 1 } });
    observabilityGate.endSpan(s);
    s.attributes.x = 99;
    expect(observabilityGate.getTrace("run-copy")[0].attributes.x).toBe(1);
  });

  it("bounds the live-span registry while parent lookup still resolves (OBS-001)", () => {
    const parent = observabilityGate.startSpan("llm", { runId: "run-registry" });
    const child = observabilityGate.startSpan("tool", { parentSpanId: parent.spanId, runId: "run-registry" });
    expect(child.traceId).toBe(parent.traceId);

    const ids: string[] = [];
    for (let i = 0; i < 10050; i++) ids.push(observabilityGate.startSpan("llm", { runId: "run-registry" }).spanId);

    // Registry capped at 10k: oldest entries evicted, newest still resolvable.
    expect(observabilityGate.getSpanById(parent.spanId)).toBeUndefined();
    expect(observabilityGate.getSpanById(ids[ids.length - 1])).toBeDefined();
    const recent = observabilityGate.startSpan("tool", { parentSpanId: ids[ids.length - 1], runId: "run-registry" });
    expect(recent.traceId).toBeTruthy();
  });

  it("closes a fast span via the pending OTel attach (OBS-002)", async () => {
    const ended: string[] = [];
    const fakeSpan = { end: () => ended.push("end"), setStatus: () => ended.push("status") };
    const fakeOtel = { trace: { getTracer: () => ({ startSpan: () => fakeSpan }) } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (globalThis as unknown as Record<string, unknown>).__OBS_OTEL_LOADER__ = async () => {
      await gate;
      return fakeOtel;
    };
    process.env.OTEL_ENABLED = "true";
    try {
      const fast = observabilityGate.startSpan("llm", { runId: "run-otel-fast" });
      observabilityGate.endSpan(fast); // ends before the import resolves
      const runless = observabilityGate.startSpan("tool", {});
      observabilityGate.endSpan(runless);
      expect(ended.length).toBe(0);
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(ended.length).toBe(2); // both fast spans received end()
    } finally {
      delete process.env.OTEL_ENABLED;
      delete (globalThis as unknown as Record<string, unknown>).__OBS_OTEL_LOADER__;
    }
  });

  it("drops run-less spans from every read — no __global bucket (OBS-007)", () => {
    const runless = observabilityGate.startSpan("tool", {});
    observabilityGate.endSpan(runless);
    // Lifecycle still completes on the returned span; only storage is skipped.
    expect(runless.durationMs).toBeGreaterThanOrEqual(0);
    expect(runless.status).toBe("ok");

    expect(observabilityGate.getTrace("__global")).toEqual([]);
    expect(observabilityGate.getAllTraces().some((t) => t.runId === "__global")).toBe(false);
    expect(observabilityGate.getTraceStats()).toEqual({ totalRuns: 0, totalSpans: 0 });

    observabilityGate.endSpan(observabilityGate.startSpan("llm", { runId: "run-obs-007" }));
    expect(observabilityGate.getAllTraces().map((t) => t.runId)).toEqual(["run-obs-007"]);
    expect(observabilityGate.getTraceStats()).toEqual({ totalRuns: 1, totalSpans: 1 });
  });
});

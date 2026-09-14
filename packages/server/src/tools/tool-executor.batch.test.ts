import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: {
    getResolvedToolsForAgent: async () => [
      "rwp_read_a",
      "rwp_read_b",
      "rwp_write_a",
      "rwp_write_b",
      "rwp_read_c",
      "rwp_write_c",
    ],
  },
}));

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({
    query: {
      agents: {
        findFirst: async () => ({
          id: "agent-probe",
          name: "probe-agent",
          authorityLevel: 3,
          isOmniscient: true,
        }),
      },
    },
  }),
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
}));

import { ToolExecutor, classifyToolEffect } from "./tool-executor.js";
import { toolRegistry } from "./tool-registry.js";
import type { ToolResult } from "./tool-types.js";

interface TraceEvent {
  tool: string;
  phase: "start" | "end";
  t: number;
}

const trace: TraceEvent[] = [];
let activeReads = 0;
let peakConcurrentReads = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function registerProbe(id: string, kind: "read" | "write", delayMs: number): void {
  toolRegistry.register({
    id,
    name: id,
    displayName: id,
    description: `PERF-8 probe (${kind}, ${delayMs}ms)`,
    category: "system",
    sourceType: "native",
    parameters: { type: "object", properties: {} },
    dangerLevel: "safe",
    effectClass: kind,
    handler: async (args) => {
      const isRead = kind === "read";
      if (isRead) {
        activeReads++;
        peakConcurrentReads = Math.max(peakConcurrentReads, activeReads);
      }
      trace.push({ tool: id, phase: "start", t: Date.now() });
      await sleep(delayMs);
      trace.push({ tool: id, phase: "end", t: Date.now() });
      if (isRead) activeReads--;
      const result: ToolResult = { success: true, output: String(args.marker ?? id) };
      return result;
    },
  });
}

beforeAll(() => {
  registerProbe("rwp_read_a", "read", 120);
  registerProbe("rwp_read_b", "read", 100);
  registerProbe("rwp_write_a", "write", 80);
  registerProbe("rwp_write_b", "write", 80);
  registerProbe("rwp_read_c", "read", 60);
  registerProbe("rwp_write_c", "write", 40);
});

afterAll(() => {
  for (const id of ["rwp_read_a", "rwp_read_b", "rwp_write_a", "rwp_write_b", "rwp_read_c", "rwp_write_c"]) {
    toolRegistry.unregister(id);
  }
});

function resetTrace(): void {
  trace.length = 0;
  activeReads = 0;
  peakConcurrentReads = 0;
}

function span(tool: string): { start: number; end: number } {
  const start = trace.find((e) => e.tool === tool && e.phase === "start")!.t;
  const end = trace.find((e) => e.tool === tool && e.phase === "end")!.t;
  return { start, end };
}

describe("PERF-8 · static classifier", () => {
  it("maps native tools read/write/side-effect and defaults unknown → write (conservative)", () => {
    expect(classifyToolEffect("read_file", toolRegistry.get("read_file"))).toBe("read");
    expect(classifyToolEffect("list_directory", toolRegistry.get("list_directory"))).toBe("read");
    expect(classifyToolEffect("web_search", toolRegistry.get("web_search"))).toBe("read");
    expect(classifyToolEffect("search_all_channels", toolRegistry.get("search_all_channels"))).toBe("read");
    expect(classifyToolEffect("open_memory", toolRegistry.get("open_memory"))).toBe("read");
    expect(classifyToolEffect("query_database", toolRegistry.get("query_database"))).toBe("read");
    expect(classifyToolEffect("write_file", toolRegistry.get("write_file"))).toBe("write");
    expect(classifyToolEffect("delete_file", toolRegistry.get("delete_file"))).toBe("write");
    expect(classifyToolEffect("remember", toolRegistry.get("remember"))).toBe("write");
    expect(classifyToolEffect("execute_bash", toolRegistry.get("execute_bash"))).toBe("side-effect");
    expect(classifyToolEffect("totally_unknown_tool")).toBe("write");
  });

  it("declared registration metadata wins over the name map", () => {
    expect(classifyToolEffect("anything", { effectClass: "read" })).toBe("read");
    expect(classifyToolEffect("read_file", { effectClass: "side-effect" })).toBe("side-effect");
  });
});

describe("PERF-8 · mixed-batch scheduling (TOOL_RWP on)", () => {
  const savedRwp = process.env.TOOL_RWP;

  beforeAll(() => {
    delete process.env.TOOL_RWP;
  });

  afterAll(() => {
    if (savedRwp === undefined) delete process.env.TOOL_RWP;
    else process.env.TOOL_RWP = savedRwp;
  });

  it("[read,write,read,write]: reads concurrent, writes ordered, results in request order", async () => {
    resetTrace();
    const started = Date.now();
    const results = await ToolExecutor.executeBatch("agent-probe", [
      { toolId: "rwp_read_a", args: { marker: "read:a" } },
      { toolId: "rwp_write_a", args: { marker: "write:a" } },
      { toolId: "rwp_read_b", args: { marker: "read:b" } },
      { toolId: "rwp_write_b", args: { marker: "write:b" } },
    ]);
    const total = Date.now() - started;

    expect(results.map((r) => r.output)).toEqual(["read:a", "write:a", "read:b", "write:b"]);
    expect(results.every((r) => r.success)).toBe(true);

    expect(peakConcurrentReads).toBeGreaterThanOrEqual(2);

    const wa = span("rwp_write_a");
    const wb = span("rwp_write_b");
    expect(wb.start + 5).toBeGreaterThanOrEqual(wa.end);

    const sumAll = 120 + 80 + 100 + 80;
    const expectedFloor = Math.max(120, 100) + 80 + 80;
    expect(total).toBeGreaterThanOrEqual(expectedFloor - 25);
    expect(total).toBeLessThan(sumAll - 20);
  }, 15000);

  it("bounded pool caps read concurrency", async () => {
    process.env.TOOL_RWP_MAX_READ_CONCURRENCY = "1";
    try {
      resetTrace();
      await ToolExecutor.executeBatch("agent-probe", [
        { toolId: "rwp_read_a", args: {} },
        { toolId: "rwp_read_b", args: {} },
        { toolId: "rwp_read_c", args: {} },
      ]);
      expect(peakConcurrentReads).toBe(1);
    } finally {
      delete process.env.TOOL_RWP_MAX_READ_CONCURRENCY;
    }
  }, 15000);
});

describe("PERF-8 · rollback (TOOL_RWP=false → legacy all-or-nothing)", () => {
  const savedRwp = process.env.TOOL_RWP;

  beforeAll(() => {
    process.env.TOOL_RWP = "false";
  });

  afterAll(() => {
    if (savedRwp === undefined) delete process.env.TOOL_RWP;
    else process.env.TOOL_RWP = savedRwp;
  });

  it("mixed batch serializes fully; results still land in request order", async () => {
    resetTrace();
    const started = Date.now();
    const results = await ToolExecutor.executeBatch("agent-probe", [
      { toolId: "rwp_read_a", args: { marker: "read:a" } },
      { toolId: "rwp_write_a", args: { marker: "write:a" } },
      { toolId: "rwp_read_b", args: { marker: "read:b" } },
      { toolId: "rwp_write_b", args: { marker: "write:b" } },
    ]);
    const total = Date.now() - started;

    expect(results.map((r) => r.output)).toEqual(["read:a", "write:a", "read:b", "write:b"]);
    expect(peakConcurrentReads).toBe(1);

    const order = ["rwp_read_a", "rwp_write_a", "rwp_read_b", "rwp_write_b"];
    for (let i = 1; i < order.length; i++) {
      const prevEnd = span(order[i - 1]).end;
      const nextStart = span(order[i]).start;
      expect(nextStart + 5).toBeGreaterThanOrEqual(prevEnd);
    }

    expect(total).toBeGreaterThanOrEqual(120 + 80 + 100 + 80 - 15);
  }, 15000);

  it("all-read batches still parallelize under legacy mode", async () => {
    resetTrace();
    const started = Date.now();
    await ToolExecutor.executeBatch("agent-probe", [
      { toolId: "rwp_read_a", args: {} },
      { toolId: "rwp_read_b", args: {} },
    ]);
    const total = Date.now() - started;

    expect(peakConcurrentReads).toBe(2);
    expect(total).toBeLessThan(120 + 100 - 10);
  }, 15000);
});

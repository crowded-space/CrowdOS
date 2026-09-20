// CrowdOS §21 — the FULL lazy-expansion loop, end to end.
//
// Discovery and disclosure are only half the mechanism. For §21 to be real, a
// capability the agent expands must become CALLABLE on the next model call,
// because native function calling only accepts schemas present in the request.
//
// These tests prove that hand-off: open_detail records the disclosure against
// the run, and the agentic runtime unions it into the packet before calling the
// model. Without this, discovery is a dead end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  recordToolExpansion,
  expandedToolSchemas,
  expandedCapabilities,
  clearToolExpansions,
  resetToolExpansionsForTests,
} from "./tool-expansion-registry.js";

const READ_FILE = { name: "read_file", description: "read", inputSchema: { type: "object", properties: {} } };
const LIST_DIR = { name: "list_directory", description: "list", inputSchema: { type: "object", properties: {} } };

beforeEach(() => resetToolExpansionsForTests());
afterEach(() => resetToolExpansionsForTests());

describe("§21 expansion registry", () => {
  it("records disclosed schemas against the run", () => {
    const added = recordToolExpansion("run-1", "filesystem.read", [READ_FILE, LIST_DIR]);
    expect(added).toBe(2);
    expect(expandedToolSchemas("run-1").map((t) => t.name).sort()).toEqual(["list_directory", "read_file"]);
    expect(expandedCapabilities("run-1")).toEqual(["filesystem.read"]);
  });

  it("does not duplicate a tool already expanded", () => {
    recordToolExpansion("run-1", "filesystem.read", [READ_FILE]);
    const added = recordToolExpansion("run-1", "filesystem.read", [READ_FILE, LIST_DIR]);
    expect(added).toBe(1);
    expect(expandedToolSchemas("run-1")).toHaveLength(2);
  });

  it("accumulates across several capabilities in one run", () => {
    recordToolExpansion("run-1", "filesystem.read", [READ_FILE]);
    recordToolExpansion("run-1", "workspace.snapshot", [LIST_DIR]);
    expect(expandedToolSchemas("run-1")).toHaveLength(2);
    expect(expandedCapabilities("run-1").sort()).toEqual(["filesystem.read", "workspace.snapshot"]);
  });

  it("isolates runs from each other", () => {
    recordToolExpansion("run-1", "filesystem.read", [READ_FILE]);
    expect(expandedToolSchemas("run-2")).toEqual([]);
    expect(expandedCapabilities("run-2")).toEqual([]);
  });

  it("is a no-op without a run id (direct invocations get no expansion)", () => {
    expect(recordToolExpansion(null, "filesystem.read", [READ_FILE])).toBe(0);
    expect(recordToolExpansion(undefined, "filesystem.read", [READ_FILE])).toBe(0);
    expect(expandedToolSchemas(null)).toEqual([]);
  });

  it("drops a finished run’s expansions so the registry cannot grow per run", () => {
    recordToolExpansion("run-1", "filesystem.read", [READ_FILE]);
    clearToolExpansions("run-1");
    expect(expandedToolSchemas("run-1")).toEqual([]);
  });

  it("caps how many tools one run can accumulate", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${i}`,
      description: `t${i}`,
      inputSchema: { type: "object", properties: {} },
    }));
    recordToolExpansion("run-1", "big.capability", many);
    expect(expandedToolSchemas("run-1").length).toBeLessThanOrEqual(64);
  });

  it("ignores malformed schemas instead of registering junk", () => {
    const added = recordToolExpansion("run-1", "x", [
      { name: "", description: "no name", inputSchema: {} },
      undefined as never,
      READ_FILE,
    ]);
    expect(added).toBe(1);
    expect(expandedToolSchemas("run-1").map((t) => t.name)).toEqual(["read_file"]);
  });
});

describe("§21 expansion reaches the model request", () => {
  it("the agentic runtime unions expanded schemas into the packet, without mutating the input", async () => {
    const { AgenticRuntime } = await import("../../runtime/runtimes/agentic-runtime.js");
    const runtime = new AgenticRuntime() as unknown as {
      withExpandedTools(p: any): any;
    };
    const packet: any = {
      runId: "run-union",
      tools: [{ name: "lock_in", description: "lock", inputSchema: {} }],
    };
    recordToolExpansion("run-union", "filesystem.read", [READ_FILE]);

    const merged = runtime.withExpandedTools(packet);
    expect(merged.tools.map((t: any) => t.name).sort()).toEqual(["lock_in", "read_file"]);
    // The original packet is untouched (no aliasing of the live working array).
    expect(packet.tools.map((t: any) => t.name)).toEqual(["lock_in"]);
  });

  it("returns the SAME packet reference when nothing was expanded", async () => {
    const { AgenticRuntime } = await import("../../runtime/runtimes/agentic-runtime.js");
    const runtime = new AgenticRuntime() as unknown as { withExpandedTools(p: any): any };
    const packet: any = { runId: "run-none", tools: [{ name: "lock_in" }] };
    // Identity, not just equality: the un-expanded path must stay byte-identical
    // to pre-§21 behavior.
    expect(runtime.withExpandedTools(packet)).toBe(packet);
  });

  it("does not add a schema the packet already carries", async () => {
    const { AgenticRuntime } = await import("../../runtime/runtimes/agentic-runtime.js");
    const runtime = new AgenticRuntime() as unknown as { withExpandedTools(p: any): any };
    const packet: any = { runId: "run-dup", tools: [{ name: "read_file", description: "orig", inputSchema: {} }] };
    recordToolExpansion("run-dup", "filesystem.read", [READ_FILE]);
    expect(runtime.withExpandedTools(packet)).toBe(packet);
  });
});

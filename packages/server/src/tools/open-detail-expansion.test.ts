// CrowdOS §21 — the expansion hand-off, driven through the REAL open_detail tool.
//
// The registry unit tests prove the store. This proves the WIRING: that the
// `open_detail` handler actually records what it discloses, against the run it
// was called from — which is the step that turns "discoverable" into "lazily
// expandable". A registry that nothing writes to is just a data structure.
//
// The capabilities gate is mocked here (it needs PG to resolve authorization),
// but the tool definition and handler under test are the real ones, so the
// recording call site is genuinely exercised.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolRegistry } from "./tools-gate.js";
import {
  expandedToolSchemas,
  expandedCapabilities,
  resetToolExpansionsForTests,
} from "../shared/core/tool-expansion-registry.js";

const PROBE_SCHEMA = {
  name: "probe_expandable_tool",
  description: "Only callable after §21 expansion.",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
};

beforeEach(() => {
  resetToolExpansionsForTests();
  vi.doMock("../capabilities/capabilities-gate.js", () => ({
    capabilitiesGate: {
      visibleFor: async () => [
        { id: "filesystem.read", domain: "workspace", summary: "Read files.", available: true },
      ],
      expand: async (_agentId: string, capabilityId: string) =>
        capabilityId === "filesystem.read"
          ? {
              id: "filesystem.read",
              domain: "workspace",
              summary: "Read files.",
              tools: [PROBE_SCHEMA.name],
              source: "builtin",
              toolSchemas: [PROBE_SCHEMA],
            }
          : null,
    },
  }));
});

afterEach(() => {
  vi.doUnmock("../capabilities/capabilities-gate.js");
  resetToolExpansionsForTests();
});

async function callOpenDetail(args: Record<string, unknown>, ctx: Record<string, unknown>) {
  const tool = toolRegistry.get("open_detail");
  expect(tool, "open_detail must be registered").toBeDefined();
  return tool!.handler(args, ctx as never);
}

describe("§21 open_detail records what it discloses", () => {
  it("registers the disclosed schemas against the calling run", async () => {
    const res = await callOpenDetail({ capability_id: "filesystem.read" }, { agentId: "agent-1", runId: "run-a" });
    expect(res.success).toBe(true);
    expect(expandedCapabilities("run-a")).toEqual(["filesystem.read"]);
    expect(expandedToolSchemas("run-a").map((t) => t.name)).toEqual([PROBE_SCHEMA.name]);
  });

  it("scopes the recording to the run, not the agent", async () => {
    await callOpenDetail({ capability_id: "filesystem.read" }, { agentId: "agent-1", runId: "run-a" });
    expect(expandedToolSchemas("run-b")).toEqual([]);
  });

  it("still discloses the schemas when no run id is present, but records nothing", async () => {
    const res = await callOpenDetail({ capability_id: "filesystem.read" }, { agentId: "agent-1" });
    expect(res.success).toBe(true);
    // The agent can still READ the shape; it simply is not made callable.
    expect(res.output).toContain(PROBE_SCHEMA.name);
    expect(expandedToolSchemas(null)).toEqual([]);
  });

  it("refuses a capability the agent was never offered, and records nothing", async () => {
    const res = await callOpenDetail({ capability_id: "does.not.exist" }, { agentId: "agent-1", runId: "run-a" });
    expect(res.success).toBe(false);
    expect(expandedCapabilities("run-a")).toEqual([]);
  });

  it("lists available capabilities when no id is given, recording nothing", async () => {
    const res = await callOpenDetail({}, { agentId: "agent-1", runId: "run-a" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("filesystem.read");
    expect(expandedCapabilities("run-a")).toEqual([]);
  });

  it("reports callable_now so the agent knows the tool is usable", async () => {
    const res = await callOpenDetail({ capability_id: "filesystem.read" }, { agentId: "agent-1", runId: "run-a" });
    expect(res.output).toContain("callable_now");
  });
});

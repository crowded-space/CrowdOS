// ─── create_artifact — the Zone A artifact verb, L0+L1 ───────────────────
// Realizes the `artifact.create` capability (§21): the agent supplies a type +
// body, the SERVER derives the path under the workspace artifactDir
// (`vfs/artifacts/<runId>/<id>.<ext>`). No caller-supplied path exists, so an
// L1 agent can never escape the artifact folder or clobber another run's file.
//
// Authority boundary: `authLevelRequired: 1` admits L0+L1 only. The executor
// rule is `agent.authorityLevel > authLevelRequired`, so L2/L3 non-omniscient
// agents are rejected — asserted below as carefully as the accept path.

import { beforeEach, describe, expect, it, vi } from "vitest";

const agentRow = vi.hoisted(() => ({
  id: "agent-l1",
  name: "probe-agent",
  authorityLevel: 1,
  isOmniscient: false,
}));

const created = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: { getResolvedToolsForAgent: async () => ["create_artifact"] },
}));

vi.mock("../shared/config/database.js", () => ({
  getDb: () => ({ query: { agents: { findFirst: async () => ({ ...agentRow }) } } }),
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
  isDatabaseConfigured: () => true,
}));

vi.mock("../artifacts/artifacts-gate.js", () => ({
  artifactsGate: {
    create: async (input: Record<string, unknown>) => {
      const row = {
        id: "art_test_001",
        workspaceId: input.workspaceId,
        producerAgent: input.producerAgent,
        artifactType: input.type,
        path: "vfs/artifacts/run-1/art_test_001.report.md",
        semanticTags: input.semanticTags ?? [],
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        runId: input.runId ?? null,
        beforeHash: null,
        afterHash: null,
        patch: null,
        contentRef: input.contentRef ?? null,
      };
      created.rows.push(row);
      return row;
    },
  },
}));

import { ToolExecutor, classifyToolEffect } from "./tool-executor.js";
import { toolRegistry } from "./tool-registry.js";
import { UNIVERSAL_TOOL_IDS } from "./tools-gate.js";
import { BUILTIN_CAPABILITIES } from "../capabilities/capabilities-gate.js";

describe("create_artifact · Zone A artifact verb", () => {
  beforeEach(() => {
    created.rows.length = 0;
    agentRow.authorityLevel = 1;
    agentRow.isOmniscient = false;
  });

  it("is registered as a write-classified level-1 tool", () => {
    const def = toolRegistry.get("create_artifact");
    expect(def).toBeDefined();
    expect(def!.authLevelRequired).toBe(1);
    expect(def!.effectClass).toBe("write");
    expect(classifyToolEffect("create_artifact", def)).toBe("write");
  });

  it("is granted by default (universal) so L0/L1 need no toolkit edit", () => {
    expect((UNIVERSAL_TOOL_IDS as string[])).toContain("create_artifact");
  });

  it("realizes the artifact.create capability in the catalog", () => {
    const descriptor = BUILTIN_CAPABILITIES.find((c) => c.id === "artifact.create");
    expect(descriptor).toBeDefined();
    expect(descriptor!.tools).toContain("create_artifact");
    expect(toolRegistry.has("create_artifact")).toBe(true);
  });

  it("L1 creates an artifact; the server derives workspace, producer, and path", async () => {
    const result = await ToolExecutor.execute(
      "agent-l1",
      "create_artifact",
      { type: "report", content: "# summary\nhello" },
      { workspaceId: "ws-1", runId: "run-1" },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.artifactId).toBe("art_test_001");
    expect(payload.path).toBe("vfs/artifacts/run-1/art_test_001.report.md");

    // Server-derived, never caller-supplied: workspace + producer come from ctx,
    // and there is no path parameter to smuggle an escape through.
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0].workspaceId).toBe("ws-1");
    expect(created.rows[0].producerAgent).toBe("agent-l1");
    expect(created.rows[0].runId).toBe("run-1");
    const def = toolRegistry.get("create_artifact")!;
    expect(Object.keys(def.parameters.properties)).not.toContain("path");
    expect(Object.keys(def.parameters.properties)).not.toContain("workspaceId");
    expect(Object.keys(def.parameters.properties)).not.toContain("producerAgent");
  });

  it("L0 is admitted", async () => {
    agentRow.authorityLevel = 0;
    const result = await ToolExecutor.execute(
      "agent-l0",
      "create_artifact",
      { type: "report", content: "hello" },
      { workspaceId: "ws-1" },
    );
    expect(result.success).toBe(true);
  });

  it("L2 (non-omniscient) is refused and writes nothing", async () => {
    agentRow.authorityLevel = 2;

    const result = await ToolExecutor.execute(
      "agent-l2",
      "create_artifact",
      { type: "report", content: "hello" },
      { workspaceId: "ws-1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Security breach: Tool "create_artifact" requires Level 1 authority',
    );
    expect(result.output).toBe("");
    expect(created.rows).toHaveLength(0);
  });

  it("rejects an unknown artifact type without writing", async () => {
    const result = await ToolExecutor.execute(
      "agent-l1",
      "create_artifact",
      { type: "smuggled", content: "hello" },
      { workspaceId: "ws-1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown artifact type");
    expect(created.rows).toHaveLength(0);
  });
});

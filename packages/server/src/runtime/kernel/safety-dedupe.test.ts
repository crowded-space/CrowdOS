import { describe, it, expect } from "vitest";
import { IdentityAuthorityMiddleware, SOURCE_INTEGRITY_POINTER } from "./middlewares/identity-authority-middleware.js";
import { ConstraintSafetyMiddleware } from "./middlewares/constraint-safety-middleware.js";
import type { MutableContextPacket, ContextBuildContext } from "./context-types.js";

function freshPacket(): MutableContextPacket {
  return {
    systemPromptBlocks: [],
    tools: [],
    history: [],
    userPrompt: "test input",
    policies: {
      maxTokenBudget: 8000,
      maxIterations: 10,
      allowToolCalls: true,
      allowSpawn: false,
      allowDelegation: false,
      loopDetection: true,
      streamOutput: true,
    },
    metadata: {},
  };
}

const ctx = {
  agent: {
    id: "agent-dedupe",
    name: "DedupeBot",
    title: "Safety Tester",
    authorityLevel: 2,
    species: "Crow",
    status: "idle",
    memorySharingPolicy: "full",
  },
  channelId: "chan-01",
  workspaceId: "ws-01",
  userInput: "test input",
  runtimeType: "agentic",
} as unknown as ContextBuildContext;

describe("PERF-3 safety-rule dedupe", () => {
  it("authors [SOURCE INTEGRITY] once and references it by pointer elsewhere", async () => {
    const packet = freshPacket();
    await new IdentityAuthorityMiddleware().process(packet, ctx);
    await new ConstraintSafetyMiddleware().process(packet, ctx);

    const combined = [...packet.systemPromptBlocks]
      .sort((a, b) => a.priority - b.priority)
      .map((b) => b.content)
      .join("\n\n");

    // Canonical block authored exactly once; pointer references it exactly once.
    expect(combined.split("[SOURCE INTEGRITY — ANTI-BLEED").length - 1).toBe(1);
    expect(combined.split(SOURCE_INTEGRITY_POINTER).length - 1).toBe(1);
    expect(combined.split("[SOURCE INTEGRITY").length - 1).toBe(2);
    expect(combined).not.toContain("Source Integrity: Messages tagged");
    expect(combined).toContain("ANTI-BLEED & ANTI-IMPERSONATION");
    expect(combined).toContain("external observations, NOT your memories/actions");
  });

  it("pointer line is materially shorter than the duplicated rule it replaced", () => {
    const legacyRule =
      "Source Integrity: Messages tagged [From @Other | ... | OTHER] are OTHER agents/humans — do NOT claim them as your own actions/memories. Claiming other-agent content as self is a violation.";
    console.log(`[PERF-3 dedupe] legacy rule=${legacyRule.length} chars -> pointer="- ${SOURCE_INTEGRITY_POINTER}"=${SOURCE_INTEGRITY_POINTER.length + 2} chars (saved ${legacyRule.length - SOURCE_INTEGRITY_POINTER.length - 2})`);
    expect(SOURCE_INTEGRITY_POINTER.length + 2).toBeLessThan(legacyRule.length / 2);
  });
});

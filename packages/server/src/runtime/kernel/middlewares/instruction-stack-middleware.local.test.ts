import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalStoreDirForTests } from "../../../shared/core/local-file.js";
import { localUpsertInstructionModule } from "../../../modules/module-local-store.js";
import { localReplaceInstructionStack } from "../../../agents/agent-instruction-stack-local-store.js";
import { InstructionStackMiddleware } from "./instruction-stack-middleware.js";

// Local-first regression: without a DATABASE_URL the instruction stack used to
// be dropped on the floor, so a local workspace's agent ran with NO operating
// instructions at all. The stack now resolves through the local tier.

const WS = "ws-instruction-local";

let testDir: string;

function makePacket() {
  return {
    systemPromptBlocks: [] as Array<{ id: string; priority: number; content: string }>,
    metadata: {},
    policies: {},
    history: [],
    tools: [],
    userPrompt: "hi",
  } as any;
}

function makeCtx(agentId: string, instructionModuleId: string | null = null) {
  return {
    agent: { id: agentId, name: "Local", title: "Local", authorityLevel: 1, instructionModuleId },
    channelId: "ch-local",
    workspaceId: WS,
    userInput: "hi",
    runtimeType: "agentic",
  } as any;
}

async function seedModule(id: string, base: string[]): Promise<void> {
  const now = new Date().toISOString();
  await localUpsertInstructionModule(
    { id, label: id, base, runtimePatchable: false, createdAt: now, updatedAt: now } as any,
    WS,
  );
}

describe("InstructionStackMiddleware (local tier)", () => {
  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "crowdos-instruction-local-"));
    setLocalStoreDirForTests(testDir);
    // Warm the gate imports: the middleware loads the agents/modules gates
    // dynamically, and their dependency tree must not be charged to a test.
    const { agentGate } = await import("../../../agents/agent-gate.js");
    const { moduleGate } = await import("../../../modules/module-gate.js");
    void agentGate;
    void moduleGate;
  });

  afterAll(() => {
    setLocalStoreDirForTests(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("pushes the agent's stack instructions in priority order", async () => {
    const agentId = "agent-stack-order";
    await seedModule("instr-role", ["Role rule: you are the specialist."]);
    await seedModule("instr-brief", ["Brief rule: follow the experiment protocol."]);
    await localReplaceInstructionStack(agentId, ["instr-brief", "instr-role"], WS);

    const packet = makePacket();
    await new InstructionStackMiddleware().process(packet, makeCtx(agentId));

    expect(packet.systemPromptBlocks).toHaveLength(1);
    const block = packet.systemPromptBlocks[0];
    expect(block.id).toBe("instruction_stack");
    expect(block.priority).toBe(15);
    expect(block.content).toContain("[OPERATING INSTRUCTIONS]");
    expect(block.content).toContain("Brief rule: follow the experiment protocol.");
    expect(block.content).toContain("Role rule: you are the specialist.");
    // Stack order is the link order, not the seed order.
    expect(block.content.indexOf("Brief rule")).toBeLessThan(block.content.indexOf("Role rule"));
  });

  it("falls back to the profile instruction module when the agent has no stack links", async () => {
    const agentId = "agent-profile-fallback";
    await seedModule("instr-profile", ["Profile rule: stay in scope."]);

    const packet = makePacket();
    await new InstructionStackMiddleware().process(packet, makeCtx(agentId, "instr-profile"));

    expect(packet.systemPromptBlocks).toHaveLength(1);
    expect(packet.systemPromptBlocks[0].content).toContain("Profile rule: stay in scope.");
  });

  it("lets the stack win over the profile module (same precedence as the PG path)", async () => {
    const agentId = "agent-stack-wins";
    await seedModule("instr-profile-2", ["Profile rule: stay in scope."]);
    await seedModule("instr-stack", ["Stack rule: this one wins."]);
    await localReplaceInstructionStack(agentId, ["instr-stack"], WS);

    const packet = makePacket();
    await new InstructionStackMiddleware().process(packet, makeCtx(agentId, "instr-profile-2"));

    expect(packet.systemPromptBlocks).toHaveLength(1);
    expect(packet.systemPromptBlocks[0].content).toContain("Stack rule: this one wins.");
    expect(packet.systemPromptBlocks[0].content).not.toContain("Profile rule");
  });

  it("pushes nothing when the agent has neither a stack nor a profile module", async () => {
    const packet = makePacket();
    await new InstructionStackMiddleware().process(packet, makeCtx("agent-nothing", null));

    expect(packet.systemPromptBlocks).toEqual([]);
  });
});

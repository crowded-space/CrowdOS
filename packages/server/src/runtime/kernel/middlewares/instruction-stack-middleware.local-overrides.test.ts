import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalStoreDirForTests } from "../../../shared/core/local-file.js";
import { agentGate } from "../../../agents/agent-gate.js";
import { moduleGate } from "../../../modules/module-gate.js";
import { InstructionStackMiddleware } from "./instruction-stack-middleware.js";

// Local tier runtime overrides: the PG path has applied runtime overrides
// since forever, the local path ignored them. These pin the PG semantics on
// the local branch: scoped replace, refused whole-stack replace, append
// order, and the expiry sweep.

const WS = "ws-instruction-overrides";

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

function makeCtx(agentId: string) {
  return {
    agent: { id: agentId, name: "Local", title: "Local", authorityLevel: 1, instructionModuleId: null },
    channelId: "ch-local",
    workspaceId: WS,
    userInput: "hi",
    runtimeType: "agentic",
  } as any;
}

async function seedModule(label: string, base: string[]): Promise<string> {
  const mod = await moduleGate.instruction.create({ label, base }, WS);
  return mod.id;
}

async function seedStack(agentId: string, moduleIds: string[]): Promise<void> {
  await agentGate.replaceInstructionStack(agentId, moduleIds, undefined, WS);
}

async function putOverride(
  agentId: string,
  instructionPatch: Record<string, unknown>,
  expiresAt?: string,
): Promise<void> {
  await agentGate.upsertLocalRuntimeOverride(
    {
      targetAgentId: agentId,
      overrideType: "runtime_patch",
      instructionPatch: instructionPatch as any,
      createdBy: "studio",
      expiresAt: expiresAt ?? null,
    },
    WS,
  );
}

async function assemble(agentId: string): Promise<string> {
  const packet = makePacket();
  await new InstructionStackMiddleware().process(packet, makeCtx(agentId));
  const block = packet.systemPromptBlocks.find((b: { id: string }) => b.id === "instruction_stack");
  return block?.content ?? "";
}

describe("InstructionStackMiddleware (local tier) — runtime overrides", () => {
  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "crowdos-instruction-overrides-"));
    setLocalStoreDirForTests(testDir);
  });

  afterAll(() => {
    setLocalStoreDirForTests(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("appends the override lines after the rebuilt stack", async () => {
    const agentId = "agent-ov-append";
    const modA = await seedModule("instr-ov-a", ["Rule A."]);
    const modB = await seedModule("instr-ov-b", ["Rule B."]);
    await seedStack(agentId, [modA, modB]);
    await putOverride(agentId, { append: ["PATCH LINE"] });

    const content = await assemble(agentId);

    expect(content).toContain("Rule A.");
    expect(content).toContain("Rule B.");
    expect(content).toContain("PATCH LINE");
    // The append lands after the stack, not inside it.
    expect(content.indexOf("Rule A.")).toBeLessThan(content.indexOf("PATCH LINE"));
    expect(content.indexOf("Rule B.")).toBeLessThan(content.indexOf("PATCH LINE"));
  });

  it("replaces only the target module's slice", async () => {
    const agentId = "agent-ov-replace";
    const modA = await seedModule("instr-ov-r-a", ["Rule A."]);
    const modB = await seedModule("instr-ov-r-b", ["Rule B."]);
    await seedStack(agentId, [modA, modB]);
    await putOverride(agentId, { replace: ["Rule A replaced."], targetModuleId: modA });

    const content = await assemble(agentId);

    expect(content).toContain("Rule A replaced.");
    expect(content).not.toContain("Rule A.");
    // The other module's slice survives the scoped replace.
    expect(content).toContain("Rule B.");
  });

  it("honours the legacy replaceTarget alias", async () => {
    const agentId = "agent-ov-legacy-target";
    const modA = await seedModule("instr-ov-l-a", ["Rule A."]);
    await seedStack(agentId, [modA]);
    await putOverride(agentId, { replace: ["Rule A replaced."], replaceTarget: modA });

    const content = await assemble(agentId);

    expect(content).toContain("Rule A replaced.");
    expect(content).not.toContain("Rule A.");
  });

  it("ignores a replace that targets a module outside the stack", async () => {
    const agentId = "agent-ov-unknown-target";
    const modA = await seedModule("instr-ov-u-a", ["Rule A."]);
    await seedStack(agentId, [modA]);
    await putOverride(agentId, { replace: ["MUST NOT APPEAR"], targetModuleId: "instr-not-in-stack" });

    const content = await assemble(agentId);

    expect(content).toContain("Rule A.");
    expect(content).not.toContain("MUST NOT APPEAR");
  });

  it("refuses a replace without a target (no whole-stack wipe)", async () => {
    const agentId = "agent-ov-no-target";
    const modA = await seedModule("instr-ov-n-a", ["Rule A."]);
    await seedStack(agentId, [modA]);
    await putOverride(agentId, { replace: ["MUST NOT APPEAR"] });

    const content = await assemble(agentId);

    expect(content).toContain("Rule A.");
    expect(content).not.toContain("MUST NOT APPEAR");
  });

  it("does not apply an expired override and sweeps it from the store", async () => {
    const agentId = "agent-ov-expired";
    const modA = await seedModule("instr-ov-e-a", ["Rule A."]);
    await seedStack(agentId, [modA]);
    await putOverride(agentId, { append: ["EXPIRED LINE"] }, new Date(Date.now() - 60_000).toISOString());

    const content = await assemble(agentId);

    expect(content).toContain("Rule A.");
    expect(content).not.toContain("EXPIRED LINE");
    // The expired row is deleted, not just skipped.
    expect(await agentGate.listLocalRuntimeOverrides(agentId, WS)).toEqual([]);
  });

  it("ignores an override that carries no instruction patch", async () => {
    const agentId = "agent-ov-no-patch";
    const modA = await seedModule("instr-ov-p-a", ["Rule A."]);
    await seedStack(agentId, [modA]);
    await agentGate.upsertLocalRuntimeOverride(
      {
        targetAgentId: agentId,
        overrideType: "temp_permission",
        instructionPatch: null,
        permissionPatch: { grantTools: ["probe"] },
        createdBy: "studio",
      },
      WS,
    );

    const content = await assemble(agentId);

    // The permission patch contributes nothing to the instruction content.
    expect(content.replace("[OPERATING INSTRUCTIONS]", "").trim()).toBe("Rule A.");
  });
});

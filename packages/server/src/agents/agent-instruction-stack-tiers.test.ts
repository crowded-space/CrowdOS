// Studio-manifest local/db decoupling regression: the instruction-stack
// read+write path must work in a local-only workspace (no DATABASE_URL)
// without touching PG, and stay workspace-scoped. Pre-fix,
// replaceInstructionStack ran bare withTransaction -> getDb() -> threw
// "DATABASE_URL is not set", which surfaced as GET/PUT
// /api/studio/agents/:id/manifest -> 500 for every local workspace.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// True no-DB simulation (module-local-mode.test.ts pattern): unset so any
// ambient getDb() throws fast instead of hanging on a connection.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { agentGate } from "./agent-gate.js";
import { localUpsertAgent } from "./agent-local-store.js";
import { moduleGate } from "../modules/module-gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-agent-stack-tiers-"));
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function baseAgent(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-a",
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
    instructionModuleId: "instr-default",
    memorySharingPolicy: "full",
    status: "idle",
    isTemplate: false,
    ...overrides,
  };
}

async function seedStackModules() {
  const first = await moduleGate.instruction.create({ label: "First", base: ["first-line"] }, "ws-a");
  const second = await moduleGate.instruction.create({ label: "Second", base: ["second-line"] }, "ws-a");
  return [first, second] as const;
}

describe("instruction stack tiers · local-only workspace", () => {
  it("reads an empty stack without throwing (manifest GET path)", async () => {
    await localUpsertAgent(baseAgent({ id: "agent-empty", name: "agent-empty" }));

    const stack = await agentGate.getInstructionStack("agent-empty", undefined, "ws-a");

    expect(stack).toEqual([]);
  });

  it("round-trips a local replace with order + embedded modules", async () => {
    await localUpsertAgent(baseAgent({ id: "agent-1", name: "agent-1" }));
    const [first, second] = await seedStackModules();

    await agentGate.replaceInstructionStack("agent-1", [first.id, second.id], undefined, "ws-a");
    const stack = await agentGate.getInstructionStack("agent-1", undefined, "ws-a");

    expect(
      stack.map((l: any) => ({
        moduleId: l.instructionModuleId,
        priorityOrder: l.priorityOrder,
        label: l.instructionModule?.label,
      })),
    ).toEqual([
      { moduleId: first.id, priorityOrder: 10, label: "First" },
      { moduleId: second.id, priorityOrder: 20, label: "Second" },
    ]);
  });

  it("rejects an unknown module id and leaves the previous stack intact (all-or-nothing)", async () => {
    await localUpsertAgent(baseAgent({ id: "agent-2", name: "agent-2" }));
    const [first] = await seedStackModules();
    await agentGate.replaceInstructionStack("agent-2", [first.id], undefined, "ws-a");

    await expect(
      agentGate.replaceInstructionStack("agent-2", [first.id, "instr-missing"], undefined, "ws-a"),
    ).rejects.toThrow();

    const stack = await agentGate.getInstructionStack("agent-2", undefined, "ws-a");
    expect(stack.map((l: any) => l.instructionModuleId)).toEqual([first.id]);
  });

  it("keeps the same agent id isolated across workspaces", async () => {
    await localUpsertAgent(baseAgent({ id: "shared-id", name: "a" }));
    await localUpsertAgent(baseAgent({ id: "shared-id", name: "b", workspaceId: "ws-b" }));
    const [first] = await seedStackModules();
    const other = await moduleGate.instruction.create({ label: "Other", base: ["other"] }, "ws-b");

    await agentGate.replaceInstructionStack("shared-id", [first.id], undefined, "ws-a");
    await agentGate.replaceInstructionStack("shared-id", [other.id], undefined, "ws-b");

    const stackA = await agentGate.getInstructionStack("shared-id", undefined, "ws-a");
    const stackB = await agentGate.getInstructionStack("shared-id", undefined, "ws-b");
    expect(stackA.map((l: any) => l.instructionModuleId)).toEqual([first.id]);
    expect(stackB.map((l: any) => l.instructionModuleId)).toEqual([other.id]);
  });
});

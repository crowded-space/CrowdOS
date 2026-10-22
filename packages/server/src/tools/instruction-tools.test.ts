// Instruction tools at the registry level: definitions + handler contract
// against a real local workspace store. No DB, no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { env } from "../shared/config/env.js";
import { agentGate } from "../agents/agent-gate.js";
import { moduleGate } from "../modules/module-gate.js";
import { ToolRegistry } from "./tool-registry.js";
import { resolveToolRoot } from "./tool-root.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

const WS = "ws-instruction-tools";
const PROFILE_MODULE_ID = "instr-profile-tools";

let dir: string;
let agentId: string;

const ctx = { agentId: "", channelId: "channel-instr", workspaceId: WS, runId: "run-instr" };

async function seedProfileModule(): Promise<void> {
  await moduleGate.instruction.create(
    { label: "Profile instructions", base: ["Profile rule: you are the generalist."] },
    WS,
  );
  // The create path mints its own id; look it up by label so the agent
  // references the real module.
  const found = (await moduleGate.instruction.list({ workspaceId: WS })).find(
    (m) => m.label === "Profile instructions",
  );
  if (!found) throw new Error("profile module not seeded");
  await moduleGate.instruction.update(found.id, { label: "Profile instructions" }, WS);
  (globalThis as any).__profileModuleId = found.id;
}

async function seedAgent(): Promise<void> {
  const agent = await agentGate.create(
    {
      workspaceId: WS,
      name: "Ascend",
      title: "Ascend",
      authorityLevel: 1,
      instructionModuleId: (globalThis as any).__profileModuleId,
      memorySharingPolicy: "full",
      permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: true },
    } as never,
    undefined,
  );
  agentId = (agent as any).id;
  ctx.agentId = agentId;
}

async function writeRepoFile(name: string, content: string): Promise<void> {
  const root = await resolveToolRoot(ctx);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, name), content, "utf8");
}

async function stackLabels(): Promise<string[]> {
  const links = (await agentGate.getInstructionStack(agentId, undefined, WS)) as Array<{
    instructionModuleId: string;
  }>;
  const labels: string[] = [];
  for (const link of links) {
    const mod = await moduleGate.instruction.get(link.instructionModuleId, WS);
    labels.push(mod?.label ?? link.instructionModuleId);
  }
  return labels;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-instruction-tools-"));
  setLocalStoreDirForTests(dir);
  setRegistryFilePathForTests(join(dir, "workspaces.json"));
  const { saveWorkspaceRecord } = await import("../workspace/workspace-gate.js");
  const now = new Date().toISOString();
  await saveWorkspaceRecord({
    id: WS,
    name: WS,
    icon: "box",
    databaseUrl: "",
    rootPath: join(dir, WS),
    screenLockPinHash: null,
    createdAt: now,
    updatedAt: now,
  });
  await seedProfileModule();
  await seedAgent();
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  setRegistryFilePathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("instruction tools registration", () => {
  it("registers both verbs for L0-L2 with a moderate, side-effecting contract", () => {
    const registry = new ToolRegistry();
    for (const id of ["mount_instructions", "discard_instructions"]) {
      const def = registry.get(id);
      expect(def).toBeDefined();
      expect(def!.dangerLevel).toBe("moderate");
      expect(def!.effectClass).toBe("side-effect");
      expect(def!.authLevelRequired).toBe(2);
      expect(def!.category).toBe("system");
    }
    expect(registry.get("mount_instructions")!.parameters.required).toEqual(["path"]);
  });
});

describe("mount_instructions", () => {
  it("mounts a markdown file as the agent's own instruction stack", async () => {
    await writeRepoFile("AGENT.md", "Mission: play Torn City.\nRule: never handle credentials.");
    const registry = new ToolRegistry();

    const res = await registry.get("mount_instructions")!.handler(
      { path: "AGENT.md" },
      ctx as never,
    );

    expect(res.success).toBe(true);
    const out = JSON.parse(res.output);
    expect(out.mounted).toContain("AGENT.md");
    expect(out.content).toContain("Mission: play Torn City.");
    expect(out.effectiveFrom).toBe("next turn");
    // The mounted file REPLACES the agent's instruction modules.
    expect(await stackLabels()).toEqual([out.mounted]);
  });

  it("leaves the agent's identity and profile module untouched", async () => {
    await writeRepoFile("AGENT.md", "Mission: play Torn City.");
    const registry = new ToolRegistry();
    const before = await agentGate.getById(agentId, undefined, WS);

    await registry.get("mount_instructions")!.handler({ path: "AGENT.md" }, ctx as never);

    const after = await agentGate.getById(agentId, undefined, WS);
    expect(after!.name).toBe(before!.name);
    expect(after!.title).toBe(before!.title);
    expect(after!.authorityLevel).toBe(before!.authorityLevel);
    expect(after!.instructionModuleId).toBe(before!.instructionModuleId);
  });

  it("is idempotent: mounting the same path twice reuses one module", async () => {
    await writeRepoFile("AGENT.md", "First version.");
    const registry = new ToolRegistry();
    await registry.get("mount_instructions")!.handler({ path: "AGENT.md" }, ctx as never);

    await writeRepoFile("AGENT.md", "Second version.");
    const res = await registry.get("mount_instructions")!.handler({ path: "AGENT.md" }, ctx as never);

    const modules = await moduleGate.instruction.list({ workspaceId: WS });
    const mounted = modules.filter((m) => m.label.endsWith("AGENT.md"));
    expect(mounted).toHaveLength(1);
    expect(mounted[0].base[0]).toBe("Second version.");
    expect(JSON.parse(res.output).stack).toHaveLength(1);
  });

  it("refuses a file that does not exist and leaves the stack alone", async () => {
    const registry = new ToolRegistry();
    const res = await registry.get("mount_instructions")!.handler({ path: "nope.md" }, ctx as never);

    expect(res.success).toBe(false);
    expect(res.error).toContain("nope.md");
    expect(await stackLabels()).toEqual([]);
  });

  it("refuses an empty path", async () => {
    const registry = new ToolRegistry();
    const res = await registry.get("mount_instructions")!.handler({ path: "   " }, ctx as never);
    expect(res.success).toBe(false);
  });
});

describe("discard_instructions", () => {
  it("restores the agent's profile instructions", async () => {
    await writeRepoFile("AGENT.md", "Mission: play Torn City.");
    const registry = new ToolRegistry();
    await registry.get("mount_instructions")!.handler({ path: "AGENT.md" }, ctx as never);
    expect((await stackLabels()).length).toBe(1);

    const res = await registry.get("discard_instructions")!.handler({}, ctx as never);

    expect(res.success).toBe(true);
    const out = JSON.parse(res.output);
    expect(out.restored).toBe("profile");
    expect(await stackLabels()).toEqual(["Profile instructions"]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { localUpsertAgent } from "../agents/agent-local-store.js";
import { ToolExecutor } from "./tool-executor.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-tool-local-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

async function seedLocalAgent() {
  return localUpsertAgent({
    id: "agent-local-tools",
    workspaceId: "ws-local-tools",
    name: "local-tools",
    title: "Local Tools",
    authorityLevel: 0,
    modelModuleId: null,
    instructionModuleId: "instr-default",
    memorySharingPolicy: "full",
    status: "idle",
    isTemplate: false,
  });
}

async function seedLocalChannel() {
  const { channelGate } = await import("../channels/channel-gate.js");
  const cat = await channelGate.createCategory({
    name: "General",
    workspaceId: "ws-local-tools",
    createdBy: "test",
  });
  const created = await channelGate.create(
    {
      name: "general",
      type: "standard",
      createdBy: "test",
      categoryId: (cat as any).id ?? (cat as any).category?.id,
    } as any,
    undefined,
    "ws-local-tools",
  );
  return (created as any).channel?.id ?? (created as any).id;
}

describe("tool dispatch without DATABASE_URL", () => {
  it("resolves identity and authorization from the Local tier", async () => {
    const agent = await seedLocalAgent();
    const result = await ToolExecutor.execute(
      agent.id,
      "open_detail",
      {},
      { workspaceId: "ws-local-tools" },
    );
    expect(result.success).toBe(true);
  });

  it("reaches registry-backed read tools without a database handle", async () => {
    const agent = await seedLocalAgent();
    const result = await ToolExecutor.execute(
      agent.id,
      "load_skill",
      {},
      { workspaceId: "ws-local-tools" },
    );
    expect(result.success).toBe(true);
  });

  it("dispatches filesystem and terminal tools past identity without a database", async () => {
    const agent = await seedLocalAgent();
    const channelId = await seedLocalChannel();
    const ctx = { workspaceId: "ws-local-tools", channelId } as any;
    // Grant through a Local toolkit so dispatch reaches the handlers; the
    // handlers' own filesystem-jail behavior stays covered by the
    // filesystem suites. The regression is that dispatch itself must not
    // fail with the database error before a handler runs.
    const { localUpsertToolkitModule } = await import("../modules/module-local-store.js");
    const now = new Date();
    await localUpsertToolkitModule(
      { id: "tk-local-tools", label: "local", tools: ["read_file", "write_file", "execute_bash"], createdAt: now, updatedAt: now } as any,
      "ws-local-tools",
    );
    const { localUpsertAgent } = await import("../agents/agent-local-store.js");
    const { skillsGate } = await import("../skills/skills-gate.js");
    await localUpsertAgent({
      id: agent.id,
      workspaceId: "ws-local-tools",
      name: "local-tools",
      title: "Local Tools",
      authorityLevel: 0,
      modelModuleId: null,
      instructionModuleId: "instr-default",
      toolkitModuleId: "tk-local-tools",
      memorySharingPolicy: "full",
      status: "idle",
      isTemplate: false,
    });
    skillsGate.invalidateAgentCaches(agent.id);
    for (const [toolId, args] of [
      ["write_file", { path: "local-probe.txt", content: "local" }],
      ["read_file", { path: "local-probe.txt" }],
      ["execute_bash", { command: "echo local-exec" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await ToolExecutor.execute(agent.id, toolId, args, ctx);
      expect(String(result.error ?? "") + String(result.output ?? "")).not.toContain("DATABASE_URL");
    }
  });

  it("answers query_database honestly without a database", async () => {
    const agent = await seedLocalAgent();
    const result = await ToolExecutor.execute(
      agent.id,
      "query_database",
      { sql: "SELECT 1" },
      { workspaceId: "ws-local-tools" },
    );
    expect(result.success).toBe(false);
    expect(String(result.error ?? "")).not.toContain("DATABASE_URL is not set");
  });
});

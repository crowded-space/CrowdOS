import { beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: {
    getResolvedToolsForAgent: async () => ["sec3_timeout_probe", "sec3_fast_probe"],
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
          toolkitModuleId: null,
        }),
      },
    },
  }),
  runWithDb: <T>(db: unknown, fn: () => T): T => fn(),
  dbScopeKey: () => "global",
  isDatabaseConfigured: () => true,
}));

import { ToolExecutor } from "./tool-executor.js";
import { toolRegistry } from "./tool-registry.js";
import { execHardened } from "./safety/hardened-exec.js";
import type { ToolExecutionContext } from "./tool-types.js";

describe("SEC-3 · ToolExecutor timeout kills the process tree", () => {
  let cwd: string;
  const spawned: ChildProcess[] = [];

  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "executor-timeout-"));

    toolRegistry.register({
      id: "sec3_timeout_probe",
      name: "sec3_timeout_probe",
      displayName: "SEC-3 Timeout Probe",
      description: "Test-only tool that spawns a long-lived child through the hardened exec path.",
      category: "system",
      sourceType: "native",
      parameters: { type: "object", properties: {} },
      dangerLevel: "moderate",
      timeoutMs: 600,
      handler: async (_args, ctx) =>
        await execHardened({
          command: 'node -e "setInterval(() => {}, 10000)"',
          cwd,
          signal: (ctx as ToolExecutionContext | undefined)?.abortSignal,
          timeoutMs: 120000,
          onSpawn: (child) => {
            spawned.push(child);
          },
        }),
    });
  });

  async function waitForExit(child: ChildProcess, timeoutMs = 8000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Child process was still alive after timeout kill")),
        timeoutMs
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  it("returns a typed timeout failure and terminates the long-lived child", async () => {
    const result = await ToolExecutor.execute("agent-probe", "sec3_timeout_probe", {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(result.durationMs).toBeLessThan(10000);
    expect(spawned.length).toBeGreaterThan(0);

    await waitForExit(spawned[0]);
  }, 20000);

  it("runs fast benign commands successfully through the hardened path", async () => {
    toolRegistry.register({
      id: "sec3_fast_probe",
      name: "sec3_fast_probe",
      displayName: "SEC-3 Fast Probe",
      description: "",
      category: "system",
      sourceType: "native",
      parameters: { type: "object", properties: {} },
      dangerLevel: "safe",
      handler: async (_args, ctx) =>
        await execHardened({
          command: 'node -e "console.log(\'sec3-ok\')"',
          cwd,
          signal: (ctx as ToolExecutionContext | undefined)?.abortSignal,
          timeoutMs: 30000,
        }),
    });

    const result = await ToolExecutor.execute("agent-probe", "sec3_fast_probe", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("sec3-ok");
  }, 20000);
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "./tool-executor.js";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { queueGate } from "../queue/queue-gate.js";
import * as databaseMod from "../shared/config/database.js";

// The agent must be allowed to call system_scheduler; the store under test is
// the REAL queue gate (only the provider boundary is faked).
vi.mock("../skills/skills-gate.js", () => ({
  skillsGate: { getResolvedToolsForAgent: async () => ["system_scheduler"] },
}));

const WORKSPACE = "ws-sched";
let dir: string;

function ctx() {
  return { channelId: "ch-sched", workspaceId: WORKSPACE } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-sched-tool-"));
  setLocalStoreDirForTests(dir);
  queueGate.disarmAll();
  process.env.QUEUE_MODE = "inline";
  vi.spyOn(databaseMod, "getDb").mockReturnValue({
    query: {
      agents: {
        findFirst: async () => ({
          id: "agent-probe",
          name: "probe-agent",
          authorityLevel: 1,
          isOmniscient: true,
        }),
      },
    },
  } as unknown as ReturnType<typeof databaseMod.getDb>);
});

afterEach(() => {
  queueGate.disarmAll();
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.QUEUE_MODE;
  vi.restoreAllMocks();
});

describe("A1 · system_scheduler persists the schedule before arming it", () => {
  it("writes the row to the workspace store and reports success", async () => {
    const res = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { delaySeconds: 60, taskDescription: "wake-me", channelId: "ch-sched" },
      ctx(),
    );
    expect(res.success).toBe(true);

    const rows = await queueGate.listActiveSchedules(WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channelId: "ch-sched",
      workspaceId: WORKSPACE,
      task: "wake-me",
      cron: null,
      isActive: true,
    });
    expect(rows[0].nextRun).toBeTruthy();

    // The row is on disk, not just in the gate's memory.
    const file = join(dir, WORKSPACE, "vfs", ".crowdos", "scheduler", "scheduled_tasks.json");
    expect(existsSync(file)).toBe(true);
  });

  it("stores the cron and a next boundary for a repeatable schedule", async () => {
    const res = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { cron: "*/5 * * * *", taskDescription: "cron-task", channelId: "ch-sched" },
      ctx(),
    );
    expect(res.success).toBe(true);

    const rows = await queueGate.listActiveSchedules(WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0].cron).toBe("*/5 * * * *");
    const nextRun = new Date(rows[0].nextRun as string);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    expect(nextRun.getMinutes() % 5).toBe(0);
  });

  it("does not arm a schedule it could not persist", async () => {
    // Point the store at a path that cannot become a directory.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    setLocalStoreDirForTests(blocker);

    const res = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { delaySeconds: 60, taskDescription: "unpersistable", channelId: "ch-sched" },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    // Nothing was armed: the schedule did not exist outside the store.
    expect(await queueGate.listActiveSchedules()).toHaveLength(0);
  });

  it("deactivates the persisted row when inline arming fails (cron and one-shot)", async () => {
    vi.spyOn(queueGate, "armSchedule").mockRejectedValue(new Error("arm failed"));

    const oneShot = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { delaySeconds: 60, taskDescription: "arms-fail-once", channelId: "ch-sched" },
      ctx(),
    );
    expect(oneShot.success).toBe(false);
    expect(oneShot.error).toMatch(/arm failed/);
    expect(await queueGate.listActiveSchedules(WORKSPACE)).toHaveLength(0);

    const cron = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { cron: "*/5 * * * *", taskDescription: "arms-fail-cron", channelId: "ch-sched" },
      ctx(),
    );
    expect(cron.success).toBe(false);
    expect(cron.error).toMatch(/arm failed/);
    expect(await queueGate.listActiveSchedules(WORKSPACE)).toHaveLength(0);
  });

  it("rejects an inline cron form the local tier cannot track, before persisting", async () => {
    const res = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { cron: "0 3 * * *", taskDescription: "unsupported-cron", channelId: "ch-sched" },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unsupported cron/);
    // A row the boot re-arm could never fire must not reach the store.
    expect(await queueGate.listActiveSchedules(WORKSPACE)).toHaveLength(0);
  });

  it("rejects an invalid delay without leaving a row behind", async () => {
    const res = await ToolExecutor.execute(
      "agent-probe",
      "system_scheduler",
      { delaySeconds: -5, taskDescription: "bad-delay", channelId: "ch-sched" },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(await queueGate.listActiveSchedules(WORKSPACE)).toHaveLength(0);
  });
});

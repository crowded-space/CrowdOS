import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cross-domain boundary: this suite exercises Queue timers, so the message
// store (another domain) is faked at its gate. The real store and the real
// local scheduler rows are used throughout.
const { append, listGate } = vi.hoisted(() => ({
  append: vi.fn(async (m: unknown) => m),
  listGate: { wait: Promise.resolve() },
}));
vi.mock("../messages/message-gate.js", () => ({ messageGate: { append } }));
// Hold the boot list phase open so a disarm can land inside it. Everything
// else in the store stays real.
vi.mock("./scheduler-local-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scheduler-local-store.js")>();
  return {
    ...actual,
    localListActiveSchedules: async (...args: Parameters<typeof actual.localListActiveSchedules>) => {
      await listGate.wait;
      return actual.localListActiveSchedules(...args);
    },
  };
});

import { agentGate } from "../agents/agent-gate.js";
import { channelGate } from "../channels/channel-gate.js";
import { runsGate } from "../runs/runs-gate.js";
import { runtimeGate } from "../runtime/runtime-gate.js";
import { activeRuns } from "../shared/core/active-runs.js";
import { queueGate } from "./queue-gate.js";
// Warm the socket-server module graph the fire path imports lazily; in
// production `create-app.ts` loads it at boot, long before any fire.
import "../shared/sockets/register-socket-server.js";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import {
  EventBroker,
  resetSharedBrokerForTests,
  setSharedBroker,
} from "../event-broker/event-broker-gate.js";

const WS = "ws-rearm";
const T0 = new Date("2026-10-20T10:00:00.000Z");

let dir: string;

async function saveOneShot(delaySeconds: number, id: string): Promise<void> {
  await queueGate.saveSchedule({
    id,
    channelId: "ch-rearm",
    workspaceId: WS,
    task: id,
    message: `message-${id}`,
    targetAgentId: null,
    cron: null,
    delaySeconds,
  });
}

async function saveTargetOneShot(delaySeconds: number, id: string, targetAgentId: string): Promise<void> {
  await queueGate.saveSchedule({
    id,
    channelId: "ch-rearm",
    workspaceId: WS,
    task: id,
    message: `message-${id}`,
    targetAgentId,
    cron: null,
    delaySeconds,
  });
}

async function saveCron(cron: string, id: string): Promise<void> {
  await queueGate.saveSchedule({
    id,
    channelId: "ch-rearm",
    workspaceId: WS,
    task: id,
    message: `message-${id}`,
    targetAgentId: null,
    cron,
    delaySeconds: null,
  });
}

function firedRowIds(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .filter((call) => call[0] === "scheduled:triggered")
    .map((call) => String((call[1] as { id?: string } | undefined)?.id));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), "crowdos-rearm-"));
  setLocalStoreDirForTests(dir);
  process.env.QUEUE_MODE = "inline";
  append.mockClear();
  listGate.wait = Promise.resolve();
  activeRuns.clear();
  setSharedBroker(new EventBroker());
});

afterEach(() => {
  queueGate.disarmAll();
  activeRuns.clear();
  resetSharedBrokerForTests();
  setLocalStoreDirForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.QUEUE_MODE;
  rmSync(dir, { recursive: true, force: true });
});

describe("A2 · boot re-arm", () => {
  it("arms a future one-shot and fires it on time", async () => {
    await saveOneShot(300, "future-one-shot");
    await queueGate.rearmSchedules(T0);
    expect(await queueGate.listActiveSchedules(WS)).toHaveLength(1);

    const spy = vi.spyOn(EventBroker.prototype, "emit");
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["future-one-shot"]));
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "ch-rearm", content: "message-future-one-shot" }),
      expect.anything(),
    );
  });

  it("fires an overdue one-shot once as catch-up and deactivates it", async () => {
    await saveOneShot(60, "missed-while-down");
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    const report = await queueGate.rearmSchedules(new Date(T0.getTime() + 30 * 60_000));
    expect(report).toMatchObject({ mode: "inline", firedCatchUp: 1, armed: 0 });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ content: "message-missed-while-down" }),
      expect.anything(),
    );
    // The callback resolves after the fire completes; nothing stays armed.
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["missed-while-down"]));
    expect(await queueGate.listActiveSchedules(WS)).toHaveLength(0);

    // A second boot must not replay it.
    append.mockClear();
    const again = await queueGate.rearmSchedules(new Date(T0.getTime() + 60 * 60_000));
    expect(again).toMatchObject({ firedCatchUp: 0, armed: 0 });
    expect(append).not.toHaveBeenCalled();
  });

  it("A3 · a target one-shot fires one run for its agent and deactivates", async () => {
    await saveTargetOneShot(60, "wake-row", "agent-wake");
    const getById = vi.spyOn(agentGate, "getById").mockResolvedValue({
      id: "agent-wake",
      name: "wake-agent",
      status: "idle",
    } as never);
    // A wake is a MESSAGE: the target is reached through the standard ladder,
    // so the agent comes from the workspace roster.
    const list = vi.spyOn(agentGate, "list").mockResolvedValue([
      { id: "agent-wake", name: "wake-agent", status: "idle", authorityLevel: 1 },
    ] as never);
    const create = vi.spyOn(runsGate, "create").mockResolvedValue({ id: "run-wake" } as never);
    const execute = vi.spyOn(runtimeGate, "execute").mockResolvedValue({ status: "completed" } as never);
    vi.spyOn(channelGate, "getSettings").mockResolvedValue(null as never);

    const report = await queueGate.rearmSchedules(new Date(T0.getTime() + 30 * 60_000));

    expect(report).toMatchObject({ mode: "inline", firedCatchUp: 1, armed: 0 });
    expect(getById).toHaveBeenCalledWith("agent-wake", undefined, WS);
    expect(list).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-wake" }),
        userInput: "message-wake-row",
        // A wake always runs on the Agentic runtime.
        explicitRuntime: "agentic",
      }),
    );
    expect(await queueGate.listActiveSchedules(WS)).toHaveLength(0);

    // A second boot must not start a second run.
    execute.mockClear();
    await queueGate.rearmSchedules(new Date(T0.getTime() + 60 * 60_000));
    expect(execute).not.toHaveBeenCalled();
  });

  it("recomputes the next cron boundary instead of replaying missed ticks", async () => {
    await saveCron("*/5 * * * *", "cron-row");
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    // Boot at 10:23 — the 10:20 boundary was missed and must be skipped.
    const bootAt = new Date(T0.getTime() + 23 * 60_000);
    vi.setSystemTime(bootAt);
    const report = await queueGate.rearmSchedules(bootAt);
    expect(report).toMatchObject({ mode: "inline", armed: 1, firedCatchUp: 0 });

    const [row] = await queueGate.listActiveSchedules(WS);
    expect(new Date(row.nextRun as string).getTime()).toBe(new Date("2026-10-20T10:25:00.000Z").getTime());

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["cron-row"]));
    // Firing re-arms the next boundary from the fire instant.
    await vi.waitFor(async () => {
      const [after] = await queueGate.listActiveSchedules(WS);
      expect(new Date(after.nextRun as string).getTime()).toBe(new Date("2026-10-20T10:30:00.000Z").getTime());
    });
  });

  it("skips a cron form the local tier cannot track, and reports why", async () => {
    await saveCron("0 3 * * *", "untrackable-cron");
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    const report = await queueGate.rearmSchedules(T0);
    expect(report.armed).toBe(0);
    expect(report.skipped).toEqual([
      expect.objectContaining({ id: "untrackable-cron", reason: expect.stringContaining("not trackable") }),
    ]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(firedRowIds(spy)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("is idempotent: re-arming twice keeps exactly one timer per row", async () => {
    await saveOneShot(120, "dedupe-row");
    await queueGate.rearmSchedules(T0);
    await queueGate.rearmSchedules(T0);

    const spy = vi.spyOn(EventBroker.prototype, "emit");
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["dedupe-row"]));
  });

  it("disarmAll cancels pending fires on shutdown", async () => {
    await saveOneShot(120, "shutdown-row");
    await queueGate.rearmSchedules(T0);
    queueGate.disarmAll();

    const spy = vi.spyOn(EventBroker.prototype, "emit");
    await vi.advanceTimersByTimeAsync(240_000);
    expect(firedRowIds(spy)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("a disarm during the boot list await cancels the rearm", async () => {
    await saveOneShot(120, "disarm-mid-rearm");
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    let releaseList!: () => void;
    listGate.wait = new Promise<void>((resolve) => {
      releaseList = resolve;
    });

    const pending = queueGate.rearmSchedules(T0);
    queueGate.disarmAll();
    releaseList();
    const report = await pending;

    expect(report.armed).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(firedRowIds(spy)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("concurrent rearms share one run and fire an overdue one-shot once", async () => {
    await saveOneShot(60, "single-flight");
    const spy = vi.spyOn(EventBroker.prototype, "emit");
    const bootAt = new Date(T0.getTime() + 30 * 60_000);

    const [first, second] = await Promise.all([
      queueGate.rearmSchedules(bootAt),
      queueGate.rearmSchedules(bootAt),
    ]);

    expect(first.firedCatchUp).toBe(1);
    expect(second.firedCatchUp).toBe(1);
    expect(firedRowIds(spy)).toEqual(["single-flight"]);
    expect(first).toBe(second);
    expect(append).toHaveBeenCalledTimes(1);
    expect(await queueGate.listActiveSchedules(WS)).toHaveLength(0);
  });

  it("a fire in flight during disarmAll never re-arms the cron timer", async () => {
    await saveCron("*/5 * * * *", "cron-shutdown");
    await queueGate.rearmSchedules(T0);
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    // Hold the fire inside the message append, then shut down while it is
    // pending. The generation captured at fire start must block the re-arm.
    let releaseAppend!: () => void;
    append.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseAppend = resolve;
      }),
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));

    queueGate.disarmAll();
    releaseAppend();
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["cron-shutdown"]));

    // The next boundary must not fire: no timer was registered after disarm.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(firedRowIds(spy)).toEqual(["cron-shutdown"]);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("a restart mid-delay arms only the remainder of a one-shot", async () => {
    await saveOneShot(600, "mid-delay");
    // Fresh process: nothing is armed locally yet.
    queueGate.disarmAll();

    const bootAt = new Date(T0.getTime() + 4 * 60_000);
    vi.setSystemTime(bootAt);
    const report = await queueGate.rearmSchedules(bootAt);
    expect(report).toMatchObject({ mode: "inline", armed: 1, firedCatchUp: 0 });

    const [row] = await queueGate.listActiveSchedules(WS);
    expect(new Date(row.nextRun as string).getTime()).toBe(new Date("2026-10-20T10:10:00.000Z").getTime());

    const spy = vi.spyOn(EventBroker.prototype, "emit");
    await vi.advanceTimersByTimeAsync(6 * 60_000 - 1);
    expect(firedRowIds(spy)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(firedRowIds(spy)).toEqual(["mid-delay"]));
  });

  it("does not arm local timers in bullmq mode", async () => {
    await saveOneShot(60, "bullmq-row");
    process.env.QUEUE_MODE = "bullmq";
    const spy = vi.spyOn(EventBroker.prototype, "emit");

    const report = await queueGate.rearmSchedules(T0);
    expect(report).toEqual({ mode: "bullmq", armed: 0, firedCatchUp: 0, skipped: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(firedRowIds(spy)).toEqual([]);
  });
});

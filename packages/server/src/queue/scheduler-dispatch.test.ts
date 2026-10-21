import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dispatcher is Queue-owned; every cross-domain dependency is faked at its
// gate (AGENTS: fake the boundary, not the logic under test). The real
// active-run registry is used so the busy semantics are exercised, not mocked.
const gates = vi.hoisted(() => ({
  getById: vi.fn(),
  getSettings: vi.fn(),
  create: vi.fn(),
  execute: vi.fn(),
  append: vi.fn(),
}));
vi.mock("../agents/agent-gate.js", () => ({ agentGate: { getById: gates.getById } }));
vi.mock("../channels/channel-gate.js", () => ({ channelGate: { getSettings: gates.getSettings } }));
vi.mock("../runs/runs-gate.js", () => ({ runsGate: { create: gates.create } }));
vi.mock("../runtime/runtime-gate.js", () => ({ runtimeGate: { execute: gates.execute } }));
vi.mock("../messages/message-gate.js", () => ({ messageGate: { append: gates.append } }));

import { activeRuns, beginRun, endRun } from "../shared/core/active-runs.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";
import { dispatchScheduledRun } from "./scheduler-dispatch.js";
import type { scheduleRow } from "./scheduler-local-store.js";

const ROW: scheduleRow = {
  id: "sched-1",
  channelId: "ch-1",
  workspaceId: "ws-1",
  task: "wake",
  message: "wake up",
  targetAgentId: "agent-1",
  cron: null,
  nextRun: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  isActive: true,
};

const AGENT = { id: "agent-1", name: "raven", status: "idle" };
const broker = new EventBroker();

function row(overrides: Partial<scheduleRow> = {}): scheduleRow {
  return { ...ROW, ...overrides };
}

beforeEach(() => {
  activeRuns.clear();
  gates.getById.mockReset().mockResolvedValue(AGENT);
  gates.getSettings.mockReset().mockResolvedValue(null);
  gates.create.mockReset().mockResolvedValue({ id: "run-1" });
  gates.execute.mockReset().mockResolvedValue({ status: "completed" });
  gates.append.mockReset().mockResolvedValue(ROW);
});

afterEach(() => {
  activeRuns.clear();
  vi.restoreAllMocks();
});

describe("A3 · scheduled fire starts a run for the target agent", () => {
  it("creates the run, then hands its id and the scheduled message to the runtime", async () => {
    let settle!: (value: unknown) => void;
    gates.execute.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

    await dispatchScheduledRun(row(), "wake up", broker);

    expect(gates.getById).toHaveBeenCalledWith("agent-1", undefined, "ws-1");
    expect(gates.create).toHaveBeenCalledWith({
      agentId: "agent-1",
      channelId: "ch-1",
      workspaceId: "ws-1",
      runtimeType: "auto",
    });
    expect(gates.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-1" }),
        channelId: "ch-1",
        workspaceId: "ws-1",
        userInput: "wake up",
        runId: "run-1",
        librarianAgentId: "agent-librarian",
      }),
    );

    const signal = gates.execute.mock.calls[0][0].abortSignal;
    expect(signal).toBe(activeRuns.get("ch-1:agent-1")![0].controller.signal);
    expect(signal.aborted).toBe(false);
    activeRuns.get("ch-1:agent-1")![0].controller.abort();
    expect(signal.aborted).toBe(true);

    settle({ status: "completed" });
    await vi.waitFor(() => expect(activeRuns.has("ch-1:agent-1")).toBe(false));
  });

  it("uses the channel pin as both the requested and the preferred runtime", async () => {
    gates.getSettings.mockResolvedValue({ pinnedRuntime: "research" });

    await dispatchScheduledRun(row(), "wake up", broker);

    expect(gates.getSettings).toHaveBeenCalledWith("ch-1", undefined, "ws-1");
    expect(gates.create).toHaveBeenCalledWith(expect.objectContaining({ runtimeType: "research" }));
    expect(gates.execute).toHaveBeenCalledWith(expect.objectContaining({ preferredRuntime: "research" }));
  });

  it.each([
    {
      name: "missing agent",
      agent: null,
      text: "Scheduled task sched-1: target agent agent-1 not found.",
    },
    {
      name: "paused agent",
      agent: { ...AGENT, status: "paused" },
      text: "Agent @raven is currently paused.",
    },
    {
      name: "offline agent",
      agent: { ...AGENT, status: "offline" },
      text: "Agent @raven is currently offline.",
    },
  ])("skips a $name and posts the exact notice", async ({ agent, text }) => {
    gates.getById.mockResolvedValue(agent);

    await dispatchScheduledRun(row(), "wake up", broker);

    expect(gates.create).not.toHaveBeenCalled();
    expect(gates.execute).not.toHaveBeenCalled();
    expect(gates.append).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "ch-1",
        workspaceId: "ws-1",
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "stakeholder",
        authorType: "system",
        content: text,
      }),
      expect.anything(),
    );
  });

  it("rejects a busy channel:agent pair without touching the live run, then works once released", async () => {
    const held = beginRun("ch-1:agent-1", "raven");

    await dispatchScheduledRun(row(), "wake up", broker);

    expect(gates.create).not.toHaveBeenCalled();
    expect(gates.execute).not.toHaveBeenCalled();
    expect(gates.append).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already running") }),
      expect.anything(),
    );

    endRun("ch-1:agent-1", held);
    await dispatchScheduledRun(row(), "wake up", broker);
    expect(gates.create).toHaveBeenCalledTimes(1);
    expect(gates.execute).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when the schedule has no target agent", async () => {
    await dispatchScheduledRun(row({ targetAgentId: null }), "wake up", broker);

    expect(gates.getById).not.toHaveBeenCalled();
    expect(gates.getSettings).not.toHaveBeenCalled();
    expect(gates.create).not.toHaveBeenCalled();
    expect(gates.execute).not.toHaveBeenCalled();
    expect(gates.append).not.toHaveBeenCalled();
  });

  it("releases the busy key when execution rejects, so the next fire can run", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    gates.execute.mockRejectedValue(new Error("model down"));

    await dispatchScheduledRun(row(), "wake up", broker);

    await vi.waitFor(() => expect(activeRuns.has("ch-1:agent-1")).toBe(false));
    expect(errorSpy).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(gates.append).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("System error processing @raven") }),
        expect.anything(),
      ),
    );

    gates.create.mockClear();
    gates.execute.mockResolvedValue({ status: "completed" });
    await dispatchScheduledRun(row(), "wake up", broker);
    expect(gates.create).toHaveBeenCalledTimes(1);
  });

  it("returns while execution is still pending (boot must not block on a model call)", async () => {
    let settle!: (value: unknown) => void;
    gates.execute.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

    const outcome = await Promise.race([
      dispatchScheduledRun(row(), "wake up", broker).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);

    expect(outcome).toBe("returned");
    expect(activeRuns.has("ch-1:agent-1")).toBe(true);

    settle({ status: "completed" });
    await vi.waitFor(() => expect(activeRuns.has("ch-1:agent-1")).toBe(false));
  });
});

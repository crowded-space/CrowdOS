import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A scheduled wake is an automated MESSAGE: it posts the wake prompt and lets
// the standard ladder decide who answers (the channel's pinned mention by
// default). The cross-domain boundary is faked at the shared dispatch; the
// ladder and the busy semantics live there and are covered by the socket
// suite.
const gates = vi.hoisted(() => ({
  getById: vi.fn(),
  append: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../agents/agent-gate.js", () => ({ agentGate: { getById: gates.getById } }));
vi.mock("../messages/message-gate.js", () => ({ messageGate: { append: gates.append } }));
vi.mock("../shared/core/message-dispatch.js", () => ({ dispatchChannelMessage: gates.dispatch }));

import { EventBroker } from "../event-broker/event-broker-gate.js";
import { dispatchScheduledRun } from "./scheduler-dispatch.js";
import type { scheduleRow } from "./scheduler-local-store.js";

const ROW: scheduleRow = {
  id: "sched-1",
  channelId: "ch-1",
  workspaceId: "ws-1",
  task: "wake",
  message: "wake up",
  targetAgentId: null,
  authorAgentId: null,
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
  gates.getById.mockReset().mockResolvedValue(AGENT);
  gates.append.mockReset().mockResolvedValue({ id: "msg-1" });
  gates.dispatch.mockReset().mockResolvedValue({ messageId: "msg-1", workspaceId: "ws-1", dispatched: [], skipped: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A3 · a scheduled wake is an automated message", () => {
  it("posts the wake with no mention, so the channel's pinned agent answers", async () => {
    await dispatchScheduledRun(row(), "wake up", broker);

    expect(gates.dispatch).toHaveBeenCalledTimes(1);
    const input = gates.dispatch.mock.calls[0][0];
    expect(input.channelId).toBe("ch-1");
    expect(input.workspaceId).toBe("ws-1");
    expect(input.content).toBe("wake up");
    expect(input.mentions).toEqual([]);
  });

  it("delivers an agent's own wake in the agent's own voice", async () => {
    gates.getById.mockResolvedValue({ id: "agent-1", name: "raven", authorityLevel: 1 });

    await dispatchScheduledRun(row({ authorAgentId: "agent-1" }), "energy should be back", broker);

    const input = gates.dispatch.mock.calls[0][0];
    expect(input.content).toBe("energy should be back");
    expect(input.author).toMatchObject({ id: "agent-1", name: "raven", type: "agent" });
  });

  it("delivers an operator-created task as a system message", async () => {
    await dispatchScheduledRun(row(), "review TASKS.json and continue", broker);

    const input = gates.dispatch.mock.calls[0][0];
    expect(input.author).toMatchObject({ id: "system-scheduler", type: "system" });
  });

  it("always routes agentic, whatever the channel's runtime pin says", async () => {
    await dispatchScheduledRun(row(), "wake up", broker);

    const input = gates.dispatch.mock.calls[0][0];
    expect(input.explicitRuntime).toBe("agentic");
    // The pin is a preference and is resolved by the shared dispatch, not here.
    expect(input.preferredRuntime).toBeUndefined();
  });

  it("turns an explicit target into a mention, exactly like a typed @Name", async () => {
    await dispatchScheduledRun(row({ targetAgentId: "agent-1" }), "wake up", broker);

    const input = gates.dispatch.mock.calls[0][0];
    expect(input.mentions).toEqual([{ type: "agent", targetId: "agent-1" }]);
  });

  it("notices an unknown target and wakes nobody", async () => {
    gates.getById.mockResolvedValue(null);

    await dispatchScheduledRun(row({ targetAgentId: "ghost" }), "wake up", broker);

    expect(gates.dispatch).not.toHaveBeenCalled();
    expect(gates.append).toHaveBeenCalledTimes(1);
    expect(gates.append.mock.calls[0][0].content).toContain("target agent ghost not found");
  });
});

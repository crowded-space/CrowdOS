import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/database.js", async () => {
  const h = await import("./agent-heartbeat-test-db.js");
  return { getDb: () => h.fakeHeartbeatDb };
});

vi.mock("../../memories/memories-gate.js", () => ({
  startMemorySweeper: () => {},
}));

// Record-only fan-out: the sweep visits workspace databases, so yield the
// fixture handle for an explicit test workspace (no global-pool fallback).
vi.mock("../../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workspace/workspace-gate.js")>();
  const h = await import("./agent-heartbeat-test-db.js");
  return {
    ...actual,
    forEachWorkspaceDb: async (fn: (db: unknown, workspaceId: string | null) => Promise<void>) => {
      await fn(h.fakeHeartbeatDb, "ws-test");
    },
  };
});

import { heartbeatFixture } from "./agent-heartbeat-test-db.js";
import { markAgentIdle, markAgentWorking, sweepOrphans } from "./agent-heartbeat.js";
import type { EventBroker } from "../../event-broker/event-broker-gate.js";

function makeBrokerSpy() {
  return { emit: vi.fn() } as unknown as EventBroker;
}

describe("heartbeat orphan sweeper agent:paused truth-out (CTX-1)", () => {
  beforeEach(() => {
    heartbeatFixture.staleRuntimeStates = [];
  });

  it("emits agent:paused when pausing an orphaned working agent", async () => {
    heartbeatFixture.staleRuntimeStates = [
      { agentId: "agent-zombie", status: "working", lastHeartbeat: new Date(Date.now() - 10 * 60_000) },
    ];
    const broker = makeBrokerSpy();

    await sweepOrphans(broker);

    expect(broker.emit).toHaveBeenCalledWith(
      "agent:paused",
      expect.objectContaining({ agentId: "agent-zombie", reason: expect.stringContaining("Heartbeat") }),
    );
    expect(broker.emit).toHaveBeenCalledWith("agent:status", expect.objectContaining({ agentId: "agent-zombie", status: "paused" }));
  });

  it("does not pause or emit for locally-working agents", async () => {
    heartbeatFixture.staleRuntimeStates = [
      { agentId: "agent-live", status: "working", lastHeartbeat: new Date(Date.now() - 10 * 60_000) },
    ];
    markAgentWorking("agent-live");
    try {
      const broker = makeBrokerSpy();

      await sweepOrphans(broker);

      expect(broker.emit).not.toHaveBeenCalled();
    } finally {
      markAgentIdle("agent-live");
    }
  });
});

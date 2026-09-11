import { beforeEach, describe, expect, it, vi } from "vitest";

// Harness socket: capture server-push handlers so tests can emit snapshots.
const handlers: Record<string, (raw: any) => void> = {};
vi.mock("../src/config/socket", () => ({
  socket: {
    on: (ev: string, fn: (raw: any) => void) => {
      handlers[ev] = fn;
    },
    emit: () => {},
    disconnect: () => {},
    connect: () => {},
  },
  emitChannelJoin: () => {},
  refreshSocketPin: () => {},
}));

import { useCrowdOSStore } from "./crowdOsStore";

const tenantAgent = { id: "agent-owl", name: "Owl" };
const foreignAgent = { id: "agent-x", name: "audit_spark" };

function emitSnapshot(payload: Record<string, unknown>) {
  handlers["runtime:snapshot"]({ payload });
}

describe("runtime:snapshot roster scoping", () => {
  beforeEach(() => {
    useCrowdOSStore.setState({
      activeWorkspaceId: "ws-active",
      agents: [tenantAgent as any],
      runtimeOverrides: [],
    } as any);
  });

  it("ignores untagged (global broadcast) rosters", () => {
    emitSnapshot({ agents: [foreignAgent], overrides: [] });
    expect(useCrowdOSStore.getState().agents.map((a: any) => a.id)).toEqual(["agent-owl"]);
  });

  it("ignores rosters tagged for another workspace", () => {
    emitSnapshot({ workspaceId: "ws-other", agents: [foreignAgent], overrides: [] });
    expect(useCrowdOSStore.getState().agents.map((a: any) => a.id)).toEqual(["agent-owl"]);
  });

  it("applies rosters tagged for the active workspace", () => {
    emitSnapshot({
      workspaceId: "ws-active",
      agents: [{ id: "agent-new", name: "New" }],
      overrides: [{ id: "ov1", agentId: "agent-new", type: "model", patch: {}, reason: "", active: true }],
    });
    const state = useCrowdOSStore.getState();
    expect(state.agents.map((a: any) => a.id)).toEqual(["agent-new"]);
    expect(state.runtimeOverrides.map((o: any) => o.id)).toEqual(["ov1"]);
  });
});

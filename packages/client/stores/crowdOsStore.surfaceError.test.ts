import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/socket", () => ({
  socket: {
    on: () => {},
    off: () => {},
    emit: () => {},
    connect: () => {},
    disconnect: () => ({ connect: () => {} }),
  },
  emitChannelJoin: () => {},
  emitChannelLeave: () => {},
  emitWorkspaceLeave: () => {},
  refreshSocketPin: () => {},
}));

import { useCrowdOSStore } from "./crowdOsStore";

// UI audit §3 (major #9): workspaceError is global store state written by
// workspace-scoped operations (agent/module mutation failures, settings
// probes). Without surface scoping, a stale "Validation failed" from Assemble
// Mind rendered inside the portal's pristine NEW WORKSPACE form. The fix:
// user-initiated surface transitions clear the error — leaving to the portal
// and entering a workspace both start a fresh surface. The screenlock probe
// contract (fetchWorkspaces records the verdict in workspaceError BEFORE
// lock()) is untouched by this fix.

const WS = {
  id: "ws-1",
  name: "WS",
  icon: "💼",
  categories: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({
    workspaces: [WS],
    activeWorkspaceId: "ws-1",
    activeChannelId: null,
    workspaceError: "Validation failed",
    isFetchingWorkspaces: false,
  } as any);
});

describe("surface transitions clear stale workspaceError (UI audit §3)", () => {
  it("leaveWorkspace clears the error before the portal renders", () => {
    useCrowdOSStore.getState().leaveWorkspace();

    const state = useCrowdOSStore.getState();
    expect(state.activeWorkspaceId).toBeNull();
    expect(state.workspaceError).toBeNull();
  });

  it("enterWorkspace clears the error carried from the previous surface", async () => {
    // Start from the portal with a stale error (e.g. an earlier workspace's
    // failed Assemble Mind validation).
    useCrowdOSStore.setState({ activeWorkspaceId: null, workspaceError: "Validation failed" } as any);

    let workspaceFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (url.includes("/api/workspaces")) {
          workspaceFetches += 1;
          return { ok: true, status: 200, json: async () => [WS] };
        }
        // Tenant slice probes (categories/channels/agents/modules/providers).
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    await useCrowdOSStore.getState().enterWorkspace("ws-1");

    expect(workspaceFetches).toBeGreaterThanOrEqual(1);
    expect(useCrowdOSStore.getState().activeWorkspaceId).toBe("ws-1");
    expect(useCrowdOSStore.getState().workspaceError).toBeNull();
  });
});

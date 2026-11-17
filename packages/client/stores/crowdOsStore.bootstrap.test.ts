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

// UI audit §1: the store restores activeWorkspaceId synchronously from
// localStorage, so on a reload after a workspace was deleted the shell's
// first paint mounted with a phantom id — the portal fired
// /api/workspace/files and /api/observability/cost/dashboard against the
// nonexistent workspace and every request 503'd (4 console errors before
// the user even entered). The fix: App gates the shell on
// `workspacesBootstrapped`, which fetchWorkspaces flips once the registry
// probe completes (success OR failure), and the invalid-active branch
// clears the stale id (existing) plus the dead-end hash.

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
    activeWorkspaceId: null,
    activeChannelId: null,
    workspaceError: null,
    workspacesBootstrapped: false,
  } as any);
});

describe("workspacesBootstrapped gate (UI audit §1)", () => {
  it("starts false and flips true after a successful registry probe", async () => {
    expect(useCrowdOSStore.getState().workspacesBootstrapped).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [WS] })),
    );

    await useCrowdOSStore.getState().fetchWorkspaces();

    expect(useCrowdOSStore.getState().workspacesBootstrapped).toBe(true);
  });

  it("flips true even when the registry probe fails (finally semantics)", async () => {
    expect(useCrowdOSStore.getState().workspacesBootstrapped).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend down");
      }),
    );

    await useCrowdOSStore.getState().fetchWorkspaces();

    // Without finally semantics a failed probe would leave the shell gated
    // forever on a skeleton.
    expect(useCrowdOSStore.getState().workspacesBootstrapped).toBe(true);
  });

  it("clears a stale restored workspace id the registry no longer knows", async () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-gone", activeChannelId: "ch-gone" } as any);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [WS] })),
    );

    await useCrowdOSStore.getState().fetchWorkspaces();

    const state = useCrowdOSStore.getState();
    expect(state.activeWorkspaceId).toBeNull();
    expect(state.activeChannelId).toBeNull();
    expect(state.workspacesBootstrapped).toBe(true);
  });

  it("clears a dead-end deep-link hash pointing at the removed workspace", async () => {
    // Audit §1: a hash naming a workspace the registry no longer knows
    // (#crowdos/ws-gone/…) dead-ended at the picker forever. The invalid-active
    // branch must drop the hash so the portal is the real address.
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("window", { location: { hash: "#crowdos/ws-gone/ch-old", pathname: "/", search: "" } });
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-gone" } as any);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [WS] })),
    );

    await useCrowdOSStore.getState().fetchWorkspaces();

    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});

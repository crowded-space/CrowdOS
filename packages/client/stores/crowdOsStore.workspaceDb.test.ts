import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCrowdOSStore } from "./crowdOsStore";

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

function seedWorkspace() {
  useCrowdOSStore.setState({
    workspaces: [
      {
        id: "ws-seed",
        name: "Seed",
        icon: "crow-indigo-circle",
        database: { configured: true, host: "db.internal", database: "appdb" },
        categories: [],
        channels: [],
        createdAt: new Date().toISOString(),
      },
    ],
    workspaceError: null,
    isCreatingWorkspace: false,
    isUpdatingWorkspace: false,
    activeWorkspaceId: "ws-seed",
    activeChannelId: null,
  } as any);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({
    workspaces: [],
    workspaceError: null,
    isCreatingWorkspace: false,
    isUpdatingWorkspace: false,
    activeWorkspaceId: null,
    activeChannelId: null,
  } as any);
});

describe("workspace database error handling", () => {
  it("surfaces 4xx create failures without a silent local fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(false, 400, { message: "Invalid workspace database URL: boom." })),
    );
    const { createWorkspace } = useCrowdOSStore.getState();
    await expect(createWorkspace("Bad", "mysql://u:p@host/db", "crow-indigo-circle")).rejects.toThrow(
      /Invalid workspace database URL/,
    );
    const state = useCrowdOSStore.getState();
    expect(state.workspaces).toHaveLength(0);
    expect(state.workspaceError).toMatch(/Invalid workspace database URL/);
    expect(state.isCreatingWorkspace).toBe(false);
  });

  it("marks offline-created database assignments as pending sync, not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend unreachable");
      }),
    );
    const { createWorkspace } = useCrowdOSStore.getState();
    await createWorkspace("Offline", "postgresql://u:p@dbhost:5432/db", "crow-indigo-circle");
    const state = useCrowdOSStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].database).toMatchObject({
      configured: false,
      pendingSync: true,
      host: "dbhost",
    });
  });

  it("rejects server-refused updates without any local fallback", async () => {
    seedWorkspace();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(false, 400, { message: "Invalid workspace database URL: nope." })),
    );
    const { updateWorkspace } = useCrowdOSStore.getState();
    await expect(updateWorkspace("ws-seed", { name: "Renamed", databaseUrl: "mysql://x" })).rejects.toThrow(
      /Invalid workspace database URL/,
    );
    // A 400 means the server was reached and refused: nothing is persisted
    // locally, so no divergence is created.
    const ws = useCrowdOSStore.getState().workspaces[0];
    expect(ws.name).toBe("Seed");
    expect(ws.database).toEqual({ configured: true, host: "db.internal", database: "appdb" });
  });

  it("marks offline database replacements as pending sync", async () => {
    seedWorkspace();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend unreachable");
      }),
    );
    const { updateWorkspace } = useCrowdOSStore.getState();
    await updateWorkspace("ws-seed", { databaseUrl: "postgresql://u:p@newhost/db2" });
    expect(useCrowdOSStore.getState().workspaces[0].database).toMatchObject({
      configured: false,
      pendingSync: true,
      host: "newhost",
    });
  });

  it("clears tenant slices when leaving a workspace", async () => {
    useCrowdOSStore.setState({
      agents: [{ id: "a1", name: "Foreign" } as any],
      messages: [{ id: "m1" } as any],
      modelModules: [{ id: "mod1" } as any],
      activeWorkspaceId: "ws-seed",
    } as any);
    useCrowdOSStore.getState().leaveWorkspace();
    const state = useCrowdOSStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.modelModules).toEqual([]);
    expect(state.activeWorkspaceId).toBeNull();
  });

  it("clears tenant slices when a refresh fails outright", async () => {
    seedWorkspace();
    useCrowdOSStore.setState({
      agents: [{ id: "a1", name: "Foreign" } as any],
      messages: [{ id: "m1" } as any],
    } as any);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend unreachable");
      }),
    );
    await useCrowdOSStore.getState().fetchWorkspaces();
    const state = useCrowdOSStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.workspaces).toEqual([]);
  });

  it("clears tenant slices when any tenant endpoint is not ok", async () => {
    seedWorkspace();
    useCrowdOSStore.setState({
      agents: [{ id: "a1", name: "Foreign" } as any],
    } as any);
    const roster = [{ id: "ws-seed", name: "Seed", icon: "x", screenLockEnabled: false, database: { configured: true }, createdAt: new Date().toISOString() }];
    const withClone = (ok: boolean, status: number, body: unknown) => ({
      ok,
      status,
      json: async () => body,
      clone: () => ({ json: async () => body }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.endsWith("/api/workspaces")) return withClone(true, 200, roster);
        if (u.includes("/api/agents")) return withClone(false, 500, { message: "agents boom" });
        return withClone(true, 200, []);
      }),
    );
    await useCrowdOSStore.getState().fetchWorkspaces();
    const state = useCrowdOSStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.workspaceError).toMatch(/agents boom/);
  });
});

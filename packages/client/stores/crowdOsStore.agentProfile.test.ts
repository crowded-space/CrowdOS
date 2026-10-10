import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/socket", () => ({
  socket: { on: () => {}, emit: () => {}, disconnect: () => {}, connect: () => {} },
  emitChannelJoin: () => {},
  emitChannelLeave: () => {},
  emitWorkspaceLeave: () => {},
  refreshSocketPin: () => {},
}));

import { useCrowdOSStore } from "./crowdOsStore";

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

function stubAgentUpdate(capture: { body: any }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/agents/") && init?.method === "PUT") {
      capture.body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse(true, 200, { id: "ag-1" });
    }
    return jsonResponse(true, 200, []);
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({ workspaces: [], workspaceError: null, activeWorkspaceId: null, activeChannelId: null } as any);
});

describe("agent context cap update payload", () => {
  it("sends a valid integer cap through", async () => {
    const capture: { body: any } = { body: null };
    stubAgentUpdate(capture);
    const { updateAgent } = useCrowdOSStore.getState();
    await updateAgent("ag-1", { contextTokenCap: 64000 });
    expect(capture.body).toMatchObject({ contextTokenCap: 64000 });
  });
  it("sends explicit null when cleared", async () => {
    const capture: { body: any } = { body: null };
    stubAgentUpdate(capture);
    const { updateAgent } = useCrowdOSStore.getState();
    await updateAgent("ag-1", { contextTokenCap: null });
    expect(capture.body).toMatchObject({ contextTokenCap: null });
  });
  it("never sends NaN", async () => {
    const capture: { body: any } = { body: null };
    stubAgentUpdate(capture);
    const { updateAgent } = useCrowdOSStore.getState();
    await updateAgent("ag-1", { contextTokenCap: Number.NaN } as any);
    expect(capture.body ?? {}).not.toHaveProperty("contextTokenCap");
  });
  it("omits the field when untouched", async () => {
    const capture: { body: any } = { body: null };
    stubAgentUpdate(capture);
    const { updateAgent } = useCrowdOSStore.getState();
    await updateAgent("ag-1", { name: "renamed" });
    expect(capture.body ?? {}).not.toHaveProperty("contextTokenCap");
  });
});

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

// Audit §2.14: createChannel accepted a description parameter but the POST
// body never included it — the topic typed into the create modal was
// silently discarded.

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({
    workspaces: [],
    workspaceError: null,
    activeWorkspaceId: "ws-1",
    activeChannelId: null,
  } as any);
});

describe("createChannel topic description", () => {
  it("sends the description in the POST body", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        // Gate on the POST: the channel-switch follow-up (audit §2.14 #17)
        // fires GET /api/channels/:id/messages, which must not clobber the
        // captured create body.
        if (url.includes("/api/channels") && init?.method === "POST") {
          sentBody = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, status: 200, json: async () => ({ id: "ch-new", name: "qa-temp" }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    await useCrowdOSStore.getState().createChannel("cat-1", "qa-temp", "QA audit temp channel");
    expect(sentBody).toMatchObject({ name: "qa-temp", description: "QA audit temp channel" });
  });

  it("omits the description key when none was given", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (url.includes("/api/channels") && init?.method === "POST") {
          sentBody = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, status: 200, json: async () => ({ id: "ch-new", name: "bare" }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    await useCrowdOSStore.getState().createChannel("cat-1", "bare", undefined);
    expect(sentBody).not.toHaveProperty("description");
  });
});

describe("createChannel switches to the created channel (audit §2.14 minor #17)", () => {
  it("activates the new channel after the workspace refresh", async () => {
    useCrowdOSStore.setState({
      workspaces: [{
        id: "ws-1",
        name: "WS",
        icon: "💼",
        categories: [],
        channels: [{ id: "ch-old", name: "general" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      activeChannelId: "ch-old",
    } as any);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (url.includes("/api/channels") && (typeof input === "string" ? input : String((input as Request).url)).endsWith("/api/channels")) {
          return { ok: true, status: 200, json: async () => ({ id: "ch-new", name: "fresh" }) };
        }
        // fetchWorkspaces refresh + socket follow-up reads.
        return { ok: true, status: 200, json: async () => [] };
      }),
    );

    await useCrowdOSStore.getState().createChannel(null, "fresh", undefined);

    // Without the fix the store stayed on ch-old: creating a channel left
    // the operator on the previous channel with no indication the new one
    // existed.
    expect(useCrowdOSStore.getState().activeChannelId).toBe("ch-new");
  });
});

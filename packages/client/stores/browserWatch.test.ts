import { beforeEach, describe, expect, it, vi } from "vitest";

// Harness socket: capture server-push handlers and record client emits.
const handlers = vi.hoisted(() => ({} as Record<string, (raw: any) => void>));
const emits = vi.hoisted(() => [] as Array<{ event: string; payload: any }>);
vi.mock("../src/config/socket", () => ({
  socket: {
    on: (ev: string, fn: (raw: any) => void) => {
      handlers[ev] = fn;
    },
    emit: (event: string, payload: any) => {
      emits.push({ event, payload });
    },
    disconnect: () => {},
    connect: () => {},
  },
  emitChannelJoin: () => {},
  emitChannelLeave: () => {},
  emitWorkspaceLeave: () => {},
  refreshSocketPin: () => {},
}));

import { useCrowdOSStore } from "./crowdOsStore";

describe("browser watch", () => {
  beforeEach(() => {
    useCrowdOSStore.setState({
      activeWorkspaceId: "ws-active",
      browserFrameByWorkspace: {},
      browserStateByWorkspace: {},
    } as any);
    emits.length = 0;
  });

  it("subscribes to the active workspace on start and unsubscribes on stop", () => {
    useCrowdOSStore.getState().startBrowserWatch();
    expect(emits).toEqual([{ event: "browser:subscribe", payload: { workspaceId: "ws-active" } }]);

    useCrowdOSStore.getState().stopBrowserWatch();
    expect(emits).toEqual([
      { event: "browser:subscribe", payload: { workspaceId: "ws-active" } },
      { event: "browser:unsubscribe", payload: { workspaceId: "ws-active" } },
    ]);
  });

  it("emits nothing without an active workspace", () => {
    useCrowdOSStore.setState({ activeWorkspaceId: null } as any);
    useCrowdOSStore.getState().startBrowserWatch();
    useCrowdOSStore.getState().stopBrowserWatch();
    expect(emits).toEqual([]);
  });

  it("unsubscribes the workspace it subscribed, not the new active one", () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-old" } as any);
    useCrowdOSStore.getState().startBrowserWatch();
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-new" } as any);
    useCrowdOSStore.getState().stopBrowserWatch("ws-old");
    expect(emits).toEqual([
      { event: "browser:subscribe", payload: { workspaceId: "ws-old" } },
      { event: "browser:unsubscribe", payload: { workspaceId: "ws-old" } },
    ]);
  });

  it("explicit start/stop ids win over the active workspace", () => {
    useCrowdOSStore.getState().startBrowserWatch("ws-x");
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-y" } as any);
    useCrowdOSStore.getState().stopBrowserWatch("ws-x");
    expect(emits).toEqual([
      { event: "browser:subscribe", payload: { workspaceId: "ws-x" } },
      { event: "browser:unsubscribe", payload: { workspaceId: "ws-x" } },
    ]);
  });

  it("keeps only the latest frame per workspace", () => {
    handlers["browser:frame"]({
      workspaceId: "ws-active",
      mimeType: "image/jpeg",
      data: "first",
      ts: 1,
    });
    handlers["browser:frame"]({
      workspaceId: "ws-active",
      mimeType: "image/jpeg",
      data: "second",
      ts: 2,
    });

    const frames = useCrowdOSStore.getState().browserFrameByWorkspace;
    expect(Object.keys(frames)).toEqual(["ws-active"]);
    expect(frames["ws-active"]).toEqual({
      dataUrl: "data:image/jpeg;base64,second",
      ts: 2,
    });
  });

  it("stores state under the payload workspace and leaves others untouched", () => {
    handlers["browser:state"]({
      workspaceId: "ws-active",
      open: true,
      url: "https://example.com/",
      title: "Example",
    });
    handlers["browser:state"]({
      workspaceId: "ws-other",
      open: false,
      url: null,
      title: null,
    });

    const states = useCrowdOSStore.getState().browserStateByWorkspace;
    expect(states["ws-active"]).toEqual({
      open: true,
      url: "https://example.com/",
      title: "Example",
    });
    expect(states["ws-other"]).toEqual({ open: false, url: null, title: null });
  });

  it("ignores a malformed frame without throwing", () => {
    expect(() => handlers["browser:frame"]({ data: "orphan", mimeType: "image/jpeg" })).not.toThrow();
    expect(useCrowdOSStore.getState().browserFrameByWorkspace).toEqual({});
  });
});

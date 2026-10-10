import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({} as Record<string, (raw: any) => void>));
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
  emitChannelLeave: () => {},
  emitWorkspaceLeave: () => {},
  refreshSocketPin: () => {},
}));

import { apiClient } from "../src/api/client";
import { useCrowdOSStore } from "./crowdOsStore";

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({
    workspaces: [],
    workspaceError: null,
    activeWorkspaceId: null,
    activeChannelId: null,
  } as any);
});

describe("model card cold-restore tenant scope", () => {
  it("sends x-workspace-id on testModelModule for the restored workspace", async () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-restored" } as any);
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse(true, 200, { success: true, message: "ok" });
      }),
    );
    await apiClient.testModelModule("mod-1");
    expect(sentHeaders["x-workspace-id"]).toBe("ws-restored");
    // The module-level setter is the explicit override only; the header
    // itself must carry the restored scope even when it was never called.
  });
});

describe("model card numeric coercion", () => {
  it("omits NaN temperature and maxTokens on update instead of sending them", async () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-1" } as any);
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse(true, 200, { id: "mod-1" });
      }),
    );
    const { updateModelModule } = useCrowdOSStore.getState();
    await updateModelModule("mod-1", { temperature: Number.NaN, maxTokens: Number.NaN } as any);
    expect(sentBody).toEqual({});
  });
});
describe("model card save scoping", () => {
  it("carries x-workspace-id on updateModelModule for the active workspace", async () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-save" } as any);
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse(true, 200, { id: "mod-1" });
      }),
    );
    const { updateModelModule } = useCrowdOSStore.getState();
    await updateModelModule("mod-1", { name: "Renamed" });
    expect(sentHeaders["x-workspace-id"]).toBe("ws-save");
  });
  it("sends finite temperature and maxTokens values through", async () => {
    useCrowdOSStore.setState({ activeWorkspaceId: "ws-1" } as any);
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/modules/model/mod-1") && init?.method === "PUT") {
          sentBody = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse(true, 200, { id: "mod-1" });
        }
        // Post-save fetchWorkspaces refresh: return an empty roster.
        return jsonResponse(true, 200, []);
      }),
    );
    const { updateModelModule } = useCrowdOSStore.getState();
    await updateModelModule("mod-1", { temperature: 0.3, maxTokens: 512 });
    expect(sentBody).toEqual({ temperature: 0.3, maxOutputTokens: 512 });
  });
});

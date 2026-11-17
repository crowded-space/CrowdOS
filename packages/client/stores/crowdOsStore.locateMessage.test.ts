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

// UI audit §2.15/#22: a search-result click used to be just
// setActiveChannel + onClose — the channel opened at its latest messages with
// no scroll-to and no highlight, so a match buried in history required the
// user to search again manually. openMessageAt must walk older pages (bounded)
// until the target row is loaded, and give up cleanly (clearing the pending
// target) when history is exhausted or the target is deeper than the cap.

const CH = "ch-locate";

function backendRow(id: string, sequenceNumber: number) {
  return {
    id,
    channelId: CH,
    authorId: "agent-1",
    authorName: "Ridder",
    authorType: "user",
    content: `message ${id}`,
    timestamp: `2026-01-01T00:0${Math.min(sequenceNumber, 9)}:00.000Z`,
    sequenceNumber,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useCrowdOSStore.setState({
    workspaces: [],
    workspaceError: null,
    activeWorkspaceId: "ws-1",
    activeChannelId: null,
    messages: [],
    channelCursors: {},
    isLoadingOlder: false,
    messageLocateTarget: null,
  } as any);
});

function envelope(messages: any[], cursor: { timestamp: string; seq: number } | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages,
      cursor: cursor ? { before: cursor } : null,
    }),
  };
}

describe("openMessageAt jump-to-message", () => {
  it("walks older pages until the target row is loaded", async () => {
    let olderFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          // Head page: the target (m-1) is NOT here.
          return envelope(
            [backendRow("m-5", 5), backendRow("m-4", 4), backendRow("m-3", 3)],
            { timestamp: "2026-01-01T00:03:00.000Z", seq: 3 },
          );
        }
        olderFetches += 1;
        return envelope(
          [backendRow("m-2", 2), backendRow("m-1", 1)],
          null,
        );
      }),
    );

    await useCrowdOSStore.getState().openMessageAt({ channelId: CH, messageId: "m-1" });

    const state = useCrowdOSStore.getState();
    expect(state.messages.map(m => m.id)).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5"]);
    expect(olderFetches).toBe(1);
    // The pending target stays set for the chat area to consume (scroll + flash
    // + clear), it is not dropped by the walk.
    expect(state.messageLocateTarget).toEqual({ channelId: CH, messageId: "m-1" });
  });

  it("does not fetch older pages when the target is on the head page", async () => {
    let olderFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          return envelope(
            [backendRow("m-3", 3), backendRow("m-2", 2), backendRow("m-1", 1)],
            { timestamp: "2026-01-01T00:01:00.000Z", seq: 1 },
          );
        }
        olderFetches += 1;
        return envelope([], null);
      }),
    );

    await useCrowdOSStore.getState().openMessageAt({ channelId: CH, messageId: "m-2" });

    expect(useCrowdOSStore.getState().messageLocateTarget).toEqual({ channelId: CH, messageId: "m-2" });
    expect(olderFetches).toBe(0);
  });

  it("gives up after the bounded page cap and clears the stale target", async () => {
    let olderFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          return envelope(
            [backendRow("m-9", 9)],
            { timestamp: "2026-01-01T00:09:00.000Z", seq: 9 },
          );
        }
        olderFetches += 1;
        // History keeps going with fresh rows forever: the walk must stop at
        // its cap instead of fetching unbounded.
        const n = olderFetches;
        return envelope(
          [backendRow(`m-older-${n}`, 100 - n)],
          { timestamp: "2026-01-01T00:00:00.000Z", seq: 100 - n },
        );
      }),
    );

    await useCrowdOSStore.getState().openMessageAt({ channelId: CH, messageId: "buried-forever" });

    expect(olderFetches).toBeLessThanOrEqual(12);
    expect(useCrowdOSStore.getState().messageLocateTarget).toBeNull();
  });

  it("stops when pages stop adding new rows (history exhausted)", async () => {
    let olderFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          return envelope(
            [backendRow("m-3", 3)],
            { timestamp: "2026-01-01T00:03:00.000Z", seq: 3 },
          );
        }
        olderFetches += 1;
        // First older page adds m-2 (walk continues); the second returns the
        // same row again — nothing new loads, so the walk must stop on zero
        // growth instead of spinning to the cap.
        return envelope(
          [backendRow("m-2", 2)],
          { timestamp: "2026-01-01T00:02:00.000Z", seq: 2 },
        );
      }),
    );

    await useCrowdOSStore.getState().openMessageAt({ channelId: CH, messageId: "not-there" });

    // One productive page + one page that adds nothing, then stop.
    expect(olderFetches).toBe(2);
    expect(useCrowdOSStore.getState().messageLocateTarget).toBeNull();
  });

  it("does not refetch a page whose cursor is unchanged (stalled backend)", async () => {
    let olderFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          return envelope(
            [backendRow("m-3", 3)],
            { timestamp: "2026-01-01T00:03:00.000Z", seq: 3 },
          );
        }
        olderFetches += 1;
        // Every older fetch echoes the SAME next cursor: pagination is
        // stalled. The walk must break on the unchanged cursor instead of
        // burning all 12 cap iterations on one identical page.
        return envelope(
          [backendRow("m-2", 2)],
          { timestamp: "2026-01-01T00:02:00.000Z", seq: 2 },
        );
      }),
    );
    olderFetches = 0;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (!url.includes(`/api/channels/${CH}/messages`)) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (!url.includes("before=")) {
          return envelope(
            [backendRow("m-3", 3)],
            { timestamp: "2026-01-01T00:03:00.000Z", seq: 3 },
          );
        }
        olderFetches += 1;
        call += 1;
        // Each fetch returns a FRESH row (so zero-growth cannot stop the walk)
        // but the cursor is IDENTICAL to the head page's — pagination is
        // stalled. The walk must break on the unchanged cursor instead of
        // burning all 12 cap iterations on one identical page.
        return envelope(
          [backendRow(`m-fresh-${call}`, 200 - call)],
          { timestamp: "2026-01-01T00:03:00.000Z", seq: 3 },
        );
      }),
    );

    await useCrowdOSStore.getState().openMessageAt({ channelId: CH, messageId: "never" });

    expect(olderFetches).toBe(1);
    expect(useCrowdOSStore.getState().messageLocateTarget).toBeNull();
  });
});

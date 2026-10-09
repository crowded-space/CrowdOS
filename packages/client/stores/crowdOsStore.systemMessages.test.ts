import { beforeEach, describe, expect, it, vi } from "vitest";

// Harness socket: capture server-push handlers so tests can emit server events.
// vi.hoisted so the registry exists before the hoisted vi.mock factory runs.
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

import { useCrowdOSStore } from "./crowdOsStore";

// SYSMSG-001: server rows with authorType 'system' (e.g. "System Warning"
// escalations) must arrive in the store as type 'system' so the renderer
// shows the centered system line, not an agent bubble.

const WORKSPACE = "ws-sysmsg";
const CHANNEL = "ch-sysmsg";
const TS = "2026-10-08T00:00:00.000Z";

function emitMessageNew(row: Record<string, unknown>) {
  // Real socket emissions are enveloped ({eventId, seq, type, payload});
  // unwrapEnvelope only unwraps objects carrying an envelope marker.
  handlers["message:new"]({ eventId: "evt-test", seq: null, type: "message:new", payload: row });
}

describe("message:new author-type mapping", () => {
  beforeEach(() => {
    useCrowdOSStore.setState({
      messages: [],
      workspaces: [],
      activeWorkspaceId: WORKSPACE,
      activeChannelId: CHANNEL,
    } as any);
  });

  it("maps authorType to the render type: system -> system, user -> human, agent -> agent", () => {
    // Real server payload shape: the persisted row, with NO `type` field —
    // the client derives the render type from authorType.
    emitMessageNew({
      id: "sys-1",
      channelId: CHANNEL,
      workspaceId: WORKSPACE,
      authorId: "system",
      authorName: "System Warning",
      authorType: "system",
      content: "Budget exceeded: swarm paused.",
      timestamp: TS,
      sequenceNumber: 3,
    });
    emitMessageNew({
      id: "usr-1",
      channelId: CHANNEL,
      workspaceId: WORKSPACE,
      authorId: "local-operator",
      authorName: "Local operator",
      authorType: "user",
      content: "hello",
      timestamp: TS,
      sequenceNumber: 2,
    });
    emitMessageNew({
      id: "agt-1",
      channelId: CHANNEL,
      workspaceId: WORKSPACE,
      authorId: "agent-owl",
      authorName: "Owl",
      authorType: "agent",
      content: "final answer",
      timestamp: TS,
      sequenceNumber: 1,
    });

    expect(useCrowdOSStore.getState().messages).toEqual([
      {
        id: "sys-1",
        type: "system",
        content: "Budget exceeded: swarm paused.",
        authorId: "system",
        authorName: "System Warning",
        authorAvatar: "🤖",
        channelId: CHANNEL,
        timestamp: TS,
        mentions: [],
      },
      {
        id: "usr-1",
        type: "human",
        content: "hello",
        authorId: "local-operator",
        authorName: "Local operator",
        channelId: CHANNEL,
        timestamp: TS,
        mentions: [],
      },
      {
        id: "agt-1",
        type: "agent",
        content: "final answer",
        authorId: "agent-owl",
        authorName: "Owl",
        authorAvatar: "🤖",
        channelId: CHANNEL,
        timestamp: TS,
        mentions: [],
      },
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "@crowdos/pi-core";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { PiEventBridge } from "./PiEventBridge.js";

interface StreamEmission {
  channelId: string;
  agentId: string;
  chunk: string;
  isThoughts?: boolean;
  streamed?: boolean;
  scopedChannelId?: string;
}

function captureBroker(sink: StreamEmission[]): EventBroker {
  return {
    emit: (type: string, payload: unknown, options?: { channelId?: string }) => {
      if (type === "message:stream") {
        sink.push({ ...(payload as StreamEmission), scopedChannelId: options?.channelId });
      }
      return {} as never;
    },
  } as unknown as EventBroker;
}

describe("PERF-6 · PiEventBridge stream coalescing", () => {
  afterEach(() => {
    delete process.env.STREAM_BATCH_MS;
    vi.useRealTimers();
  });

  it("100 rapid message deltas coalesce to <= ceil(100/batch)+1 socket writes with identical content", async () => {
    vi.useFakeTimers();
    const emitted: StreamEmission[] = [];
    const broker = captureBroker(emitted);
    const stream = new EventStream();

    const bridge = PiEventBridge.pipeToBroker(stream, {
      agentId: "ag-1",
      agentName: "coder",
      channelId: "ch-1",
      workspaceId: "ws-1",
      broker,
    });

    const deltas = Array.from({ length: 100 }, (_, i) => `tok${i} `);
    for (let i = 0; i < deltas.length; i++) {
      stream.emit({ type: "message_delta", timestamp: Date.now(), content: deltas[i] });
      await vi.advanceTimersByTimeAsync(1);
    }

    stream.emit({ type: "agent_end", timestamp: Date.now(), content: deltas.join("") });
    const completion = await bridge.waitForCompletion();

    expect(emitted.length).toBeLessThanOrEqual(Math.ceil(100 / 50) + 1);
    expect(emitted.map((e) => e.chunk).join("")).toBe(deltas.join(""));
    expect(completion.finalContent).toBe(deltas.join(""));
    expect(emitted.every((e) => e.isThoughts === false && e.streamed === true)).toBe(true);
    expect(emitted.every((e) => e.scopedChannelId === "ch-1")).toBe(true);
  });

  it("thought and content lanes coalesce independently and stay ordered", async () => {
    vi.useFakeTimers();
    const emitted: StreamEmission[] = [];
    const broker = captureBroker(emitted);
    const stream = new EventStream();

    const bridge = PiEventBridge.pipeToBroker(stream, {
      agentId: "ag-1",
      agentName: "coder",
      channelId: "ch-1",
      workspaceId: "ws-1",
      broker,
    });

    stream.emit({ type: "thought_delta", timestamp: Date.now(), content: "T1" });
    stream.emit({ type: "message_delta", timestamp: Date.now(), content: "C1" });
    stream.emit({ type: "thought_delta", timestamp: Date.now(), content: "T2" });
    stream.emit({ type: "message_delta", timestamp: Date.now(), content: "C2" });

    stream.emit({ type: "agent_end", timestamp: Date.now(), content: "C1C2", thoughts: "T1T2" });
    const completion = await bridge.waitForCompletion();

    const thoughts = emitted.filter((e) => e.isThoughts).map((e) => e.chunk).join("");
    const content = emitted.filter((e) => !e.isThoughts).map((e) => e.chunk).join("");
    expect(thoughts).toBe("T1T2");
    expect(content).toBe("C1C2");
    expect(completion.finalThoughts).toBe("T1T2");
  });

  it("STREAM_BATCH_MS=0 restores per-delta unbatched emission", async () => {
    process.env.STREAM_BATCH_MS = "0";
    const emitted: StreamEmission[] = [];
    const broker = captureBroker(emitted);
    const stream = new EventStream();

    const bridge = PiEventBridge.pipeToBroker(stream, {
      agentId: "ag-1",
      agentName: "coder",
      channelId: "ch-1",
      workspaceId: "ws-1",
      broker,
    });

    for (let i = 0; i < 10; i++) {
      stream.emit({ type: "message_delta", timestamp: Date.now(), content: `d${i}` });
    }
    stream.emit({ type: "agent_end", timestamp: Date.now(), content: "d0d1d2d3d4d5d6d7d8d9" });
    await bridge.waitForCompletion();

    expect(emitted.length).toBe(10);
    expect(emitted.map((e) => e.chunk).join("")).toBe("d0d1d2d3d4d5d6d7d8d9");
  });
});

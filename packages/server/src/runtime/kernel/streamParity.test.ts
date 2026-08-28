import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { createChunkCoalescer, resolveStreamBatchMs } from "../../Shared/core/streamCoalescer.js";

vi.mock("../../Shared/core/agentHeartbeat.js", () => ({
  markAgentWorking: () => {},
  markAgentIdle: () => {},
}));

import { RuntimeKernel } from "./RuntimeKernel.js";

interface EmittedStream {
  channelId: string;
  agentId: string;
  chunk: string;
  isThoughts?: boolean;
  streamed?: boolean;
}

function captureBroker(sink: EmittedStream[]): EventBroker {
  return {
    emit: (_type: string, payload: unknown) => {
      sink.push(payload as EmittedStream);
      return {} as never;
    },
  } as unknown as EventBroker;
}

describe("PERF-6 · bridge-vs-kernel stream parity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coding-runtime bridge flush rate ≡ kernel-path flush rate for identical delta schedules", async () => {
    const kernelEmitted: EmittedStream[] = [];
    const bridgeEmitted: EmittedStream[] = [];

    const kernel = new RuntimeKernel();
    const kernelBroker = captureBroker(kernelEmitted);
    const batchMs = resolveStreamBatchMs(process.env.STREAM_BATCH_MS);

    const bridgeCoalescer = createChunkCoalescer((content) => {
      bridgeEmitted.push({
        channelId: "ch1",
        agentId: "ag1",
        chunk: content,
        isThoughts: false,
        streamed: true,
      });
    }, batchMs);

    const deltas = Array.from({ length: 100 }, (_, i) => `tok${i} `);
    for (const delta of deltas) {
      kernel.streamChunk(kernelBroker, "ch1", "ag1", delta, false, true);
      bridgeCoalescer.push(delta);
      await vi.advanceTimersByTimeAsync(1);
    }

    kernel.flushStreams("ch1", "ag1");
    bridgeCoalescer.flush();

    expect(bridgeEmitted.length).toBe(kernelEmitted.length);
    expect(kernelEmitted.length).toBeLessThanOrEqual(Math.ceil(100 / batchMs) + 1);
    expect(kernelEmitted.map((e) => e.chunk).join("")).toBe(deltas.join(""));
    expect(bridgeEmitted.map((e) => e.chunk).join("")).toBe(deltas.join(""));
    expect(kernelEmitted.every((e) => e.isThoughts === false)).toBe(true);
  });

  it("kernel keeps thought and content lanes independent while batching", () => {
    const emitted: EmittedStream[] = [];
    const kernel = new RuntimeKernel();
    const broker = captureBroker(emitted);

    kernel.streamChunk(broker, "ch1", "ag1", "think-", true, true);
    kernel.streamChunk(broker, "ch1", "ag1", "say-", false, true);
    kernel.streamChunk(broker, "ch1", "ag1", "A", true, true);
    kernel.streamChunk(broker, "ch1", "ag1", "B", false, true);
    kernel.flushStreams("ch1", "ag1");

    const thoughts = emitted.filter((e) => e.isThoughts).map((e) => e.chunk).join("");
    const content = emitted.filter((e) => !e.isThoughts).map((e) => e.chunk).join("");
    expect(thoughts).toContain("think-A");
    expect(content).toContain("say-B");
    expect(emitted.length).toBe(2);
  });

  it("non-streamed single-block emissions bypass batching unchanged", () => {
    const emitted: EmittedStream[] = [];
    const kernel = new RuntimeKernel();
    const broker = captureBroker(emitted);

    kernel.streamChunk(broker, "ch1", "ag1", "whole block", false, false);

    expect(emitted).toEqual([
      { channelId: "ch1", agentId: "ag1", chunk: "whole block", isThoughts: false, streamed: false },
    ]);
  });
});

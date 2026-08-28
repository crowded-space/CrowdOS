import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChunkCoalescer, resolveStreamBatchMs } from "./streamCoalescer.js";

describe("PERF-6 · stream coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces 100 rapid deltas into <= ceil(100/batch)+1 flushes with identical concatenated content", async () => {
    const flushed: string[] = [];
    const coalescer = createChunkCoalescer((content) => flushed.push(content), 50);

    const deltas = Array.from({ length: 100 }, (_, i) => `d${i}~`);
    for (let i = 0; i < deltas.length; i++) {
      coalescer.push(deltas[i]);
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(60);

    const maxExpected = Math.ceil(100 / 50) + 1;
    expect(flushed.length).toBeLessThanOrEqual(maxExpected);
    expect(flushed.join("")).toBe(deltas.join(""));
  });

  it("preserves order across interleaved thought/content lanes", () => {
    const thoughts: string[] = [];
    const content: string[] = [];
    const t = createChunkCoalescer((c) => thoughts.push(c), 30);
    const c = createChunkCoalescer((x) => content.push(x), 30);

    t.push("T1");
    c.push("C1");
    t.push("T2");
    c.push("C2");

    expect(thoughts).toEqual([]);
    t.flush();
    c.flush();
    expect(thoughts.join("")).toBe("T1T2");
    expect(content.join("")).toBe("C1C2");
    expect(t.pending).toBe(false);
  });

  it("batchMs=0 disables batching (immediate per-chunk flush)", () => {
    const flushed: string[] = [];
    const coalescer = createChunkCoalescer((content) => flushed.push(content), 0);
    coalescer.push("a");
    coalescer.push("b");
    expect(flushed).toEqual(["a", "b"]);
  });

  it("flush() emits trailing buffered content exactly once", () => {
    const flushed: string[] = [];
    const coalescer = createChunkCoalescer((content) => flushed.push(content), 500);
    coalescer.push("tail");
    coalescer.flush();
    coalescer.flush();
    expect(flushed).toEqual(["tail"]);
  });
});

describe("STREAM_BATCH_MS semantics", () => {
  it("matches legacy parsing: bogus/negative → 50, 0 stays 0", () => {
    expect(resolveStreamBatchMs(undefined)).toBe(50);
    expect(resolveStreamBatchMs("bogus")).toBe(50);
    expect(resolveStreamBatchMs("-5")).toBe(50);
    expect(resolveStreamBatchMs("0")).toBe(0);
    expect(resolveStreamBatchMs("25")).toBe(25);
  });
});

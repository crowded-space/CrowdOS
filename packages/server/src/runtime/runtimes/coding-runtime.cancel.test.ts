import { describe, expect, it, vi, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});


import { CodingRuntime } from "./coding-runtime.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { EventBroker } from "../../event-broker/event-broker-gate.js";
import { ProviderAbortError, ProviderTimeoutError } from "../providers/provider-errors.js";
import type { ContextPacket, IProviderAdapter, LLMRequest, LLMResponse } from "../types.js";

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket & { _modelConfig: Record<string, unknown> } {
  return {
    requestId: "req-cancel-1",
    agentId: "agent-cancel-1",
    agentName: "Cancel Tester",
    authorityLevel: 3,
    channelId: "ch-cancel",
    workspaceId: "default",
    userInput: "write a long poem",
    systemPrompt: "You code.",
    history: [],
    policies: {
      maxTokenBudget: 4000,
      maxIterations: 5,
      allowToolCalls: true,
      allowSpawn: false,
      allowDelegation: false,
      loopDetection: true,
      streamOutput: true,
    },
    metadata: {
      runtimeType: "coding",
      provider: "cancel-test",
      modelName: "cancel-model",
      modelModuleId: "mod-cancel",
      startedAt: new Date(),
    },
    _modelConfig: {
      provider: "cancel-test",
      modelName: "cancel-model",
      temperature: 0.1,
      maxOutputTokens: 256,
    },
    ...overrides,
  } as ContextPacket & { _modelConfig: Record<string, unknown> };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CAN-1 · CodingRuntime kill-mid-stream", () => {
  it("abort during a hung stream → status 'cancelled', no retries, no leaked timers", async () => {
    let attempts = 0;
    let markEntered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const hangAdapter: IProviderAdapter = {
      provider: "cancel-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(
        _config,
        _request: LLMRequest,
        _onChunk,
        options?: { signal?: AbortSignal },
      ): Promise<LLMResponse> {
        attempts++;
        return new Promise<LLMResponse>((_, reject) => {
          const bail = () => reject(new ProviderAbortError("Provider call aborted by caller signal.", "cancel-test"));
          if (options?.signal?.aborted) return bail();
          options?.signal?.addEventListener("abort", bail, { once: true });
          markEntered();
        });
      },
    };
    ProviderRegistry.register(hangAdapter);

    const controller = new AbortController();
    const broker = new EventBroker();
    const runtime = new CodingRuntime();

    vi.useFakeTimers();
    const baselineTimers = vi.getTimerCount();

    const execution = runtime.execute(makePacket({ abortSignal: controller.signal }), broker);
    void execution.catch(() => {});

    // The pre-adapter chain (agent status dual-write, tool setup) performs real
    // file I/O, which wall-clock timer advances cannot wait for. Synchronize on
    // actual adapter entry instead: the abort below is then guaranteed to land
    // mid-stream (attempts === 1), never during setup.
    await adapterEntered;

    // User hits cancel mid-stream.
    controller.abort(new Error("Run cancelled by user (channel=ch-cancel)."));

    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it("pre-stream idle timeouts retry twice then complete when the provider recovers", async () => {
    let attempts = 0;
    let markFirstEntry!: () => void;
    const firstEntry = new Promise<void>((resolve) => {
      markFirstEntry = resolve;
    });
    const flakyThenHealthy: IProviderAdapter = {
      provider: "cancel-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(_config, _request, onChunk): Promise<LLMResponse> {
        attempts++;
        if (attempts === 1) markFirstEntry();
        if (attempts <= 2) throw new ProviderTimeoutError("idle", 120_000, "cancel-test");
        onChunk?.({ content: "recovered", isThoughts: false });
        return {
          content: "recovered",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        };
      },
    };
    ProviderRegistry.register(flakyThenHealthy);

    const broker = new EventBroker();
    const runtime = new CodingRuntime();

    vi.useFakeTimers();
    const execution = runtime.execute(makePacket(), broker);
    void execution.catch(() => {});

    // Wait for the first real adapter call (pre-adapter chain = real I/O), then
    // advance the fake clock deterministically over the exact CAN-1 schedule:
    // 1s backoff after attempt 1, 2s after attempt 2 → attempt 3 succeeds.
    await firstEntry;
    await vi.advanceTimersByTimeAsync(0); // flush microtasks so attempt 1's failure arms the 1s backoff
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await execution;

    expect(attempts).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe("recovered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort during pre-adapter setup still settles as 'cancelled' (no lost terminal event)", async () => {
    // Regression for the CAN-1 setup race: an abort that lands before the
    // provider adapter is called makes the pi-core loop throw at its first
    // checkpoint and emit its terminal error synchronously — before the
    // runtime bridge subscribes. EventStream must replay that terminal event
    // or the run hangs forever.
    let attempts = 0;
    const adapter: IProviderAdapter = {
      provider: "cancel-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(): Promise<LLMResponse> {
        attempts++;
        return {
          content: "should never run",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
    };
    ProviderRegistry.register(adapter);

    const controller = new AbortController();
    const broker = new EventBroker();
    const runtime = new CodingRuntime();

    const execution = runtime.execute(makePacket({ abortSignal: controller.signal }), broker);
    // Abort immediately after execute suspends on its first await: the abort
    // lands while the pre-adapter chain is still running, never at the adapter.
    controller.abort(new Error("Run cancelled by user (channel=ch-cancel)."));

    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(attempts).toBe(0);
  }, 15000);
});

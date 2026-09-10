import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import * as databaseModule from "../../Shared/config/database.js";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});


import { CodingRuntime } from "./CodingRuntime.js";
import { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { ProviderAbortError, ProviderTimeoutError } from "../providers/providerErrors.js";
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
  beforeEach(() => {
    // persistMessage resolves message tenancy from the channel row.
    const testDb = (databaseModule as any).__socketTestDb as {
      store: { channels: Record<string, unknown>[] };
      reset(): void;
    } | undefined;
    testDb?.reset();
    testDb?.store.channels.push({ id: "ch-cancel", workspaceId: "default", name: "cancel" });
  });
  it("abort during a hung stream → status 'cancelled', no retries, no leaked timers", async () => {
    let attempts = 0;
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
    await vi.advanceTimersByTimeAsync(50);

    // User hits cancel mid-stream.
    controller.abort(new Error("Run cancelled by user (channel=ch-cancel)."));
    await vi.advanceTimersByTimeAsync(50);

    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it("pre-stream idle timeouts retry twice then complete when the provider recovers", async () => {
    let attempts = 0;
    const flakyThenHealthy: IProviderAdapter = {
      provider: "cancel-test",
      supportsStreaming: true,
      supportsTools: true,
      async call(_config, _request, onChunk): Promise<LLMResponse> {
        attempts++;
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

    // Backoff schedule: 1s after attempt 1, 2s after attempt 2 → attempt 3 succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await execution;

    expect(attempts).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe("recovered");
    expect(vi.getTimerCount()).toBe(0);
  });
});

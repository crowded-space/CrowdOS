import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleAdapter } from "./google-adapter.js";
import { OpenAIAdapter } from "./open-ai-adapter.js";
import { ProviderAbortError, ProviderTimeoutError } from "./provider-errors.js";
import {
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  getProviderTimeoutConfig,
} from "./provider-http.js";
import { _setUndiciDispatcherForTesting, _resetUndiciDispatcherForTesting } from "../../shared/core/http-agent.js";
import { BaseRuntime } from "../runtimes/base-runtime.js";
import type { LLMResponse, RuntimeResult } from "../types.js";

const TIMEOUT_ENV_KEYS = ["PROVIDER_CONNECT_TIMEOUT_MS", "PROVIDER_IDLE_TIMEOUT_MS"] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of TIMEOUT_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of TIMEOUT_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

const LLM_REQ = { systemPrompt: "sys", userPrompt: "hello" };

/** Fetch stub that honors its abort signal like undici does (rejects with signal.reason). */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject((signal as any).reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject((signal as any).reason ?? new Error("aborted")), {
          once: true,
        });
      }),
  );
}

function streamResponseStub(body: ReadableStream<Uint8Array>, extra: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    status: 200,
    body,
    ...extra,
  } as unknown as Response;
}

const encoder = new TextEncoder();

describe("CAN-1 · provider timeout config", () => {
  it("defaults to connect=10s / idle=120s", () => {
    expect(getProviderTimeoutConfig()).toEqual({
      connectTimeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
    });
    expect(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_PROVIDER_IDLE_TIMEOUT_MS).toBe(120_000);
  });

  it("reads PROVIDER_*_TIMEOUT_MS overrides; 0 disables; bogus falls back", () => {
    process.env.PROVIDER_CONNECT_TIMEOUT_MS = "2500";
    process.env.PROVIDER_IDLE_TIMEOUT_MS = "0";
    expect(getProviderTimeoutConfig()).toEqual({ connectTimeoutMs: 2500, idleTimeoutMs: 0 });

    process.env.PROVIDER_CONNECT_TIMEOUT_MS = "bogus";
    expect(getProviderTimeoutConfig()).toEqual({ connectTimeoutMs: 10_000, idleTimeoutMs: 0 });
  });
});

describe("CAN-1 · connect timeout surfaces typed error", () => {
  it("GoogleAdapter streaming: hung fetch rejects with ProviderTimeoutError(connect)", async () => {
    process.env.PROVIDER_CONNECT_TIMEOUT_MS = "80";
    vi.useFakeTimers();
    try {
      const fetchImpl = hangingFetch();
      vi.stubGlobal("fetch", fetchImpl);

      const adapter = new GoogleAdapter();
      const pending = adapter.call(
        { provider: "google", modelName: "gemini-2.0-flash" },
        LLM_REQ,
        () => {},
      );
      void pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(120);

      let caught: unknown;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderTimeoutError);
      expect((caught as ProviderTimeoutError).phase).toBe("connect");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("OpenAIAdapter non-streaming: hung fetch rejects with typed timeout and cleans timers", async () => {
    process.env.PROVIDER_CONNECT_TIMEOUT_MS = "60";
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hangingFetch());
      const adapter = new OpenAIAdapter();
      const pending = adapter.call({ provider: "openai", modelName: "gpt-4o" }, LLM_REQ);
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caller abort beats the watchdog with ProviderAbortError (not retryable classification)", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("raw network teardown")), {
              once: true,
            });
          }),
        ),
      );
      const adapter = new GoogleAdapter();
      const pending = adapter.call({ provider: "google", modelName: "gemini-2.0-flash" }, LLM_REQ, () => {}, {
        signal: controller.signal,
      });
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(ProviderAbortError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CAN-1 · streaming idle watchdog resets per chunk", () => {
  it("idle timeout fires only when chunks stop; resets keep a slow-but-alive stream going", async () => {
    process.env.PROVIDER_CONNECT_TIMEOUT_MS = "5000";
    process.env.PROVIDER_IDLE_TIMEOUT_MS = "300";
    vi.useFakeTimers();
    try {
      let push: ((text: string) => void) | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          push('data: {"candidates":[{"content":[{"parts":[{"text":"a"}]}]}]}\n\n');
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => streamResponseStub(body)),
      );

      const adapter = new GoogleAdapter();
      const pending = adapter.call({ provider: "google", modelName: "gemini-2.0-flash" }, LLM_REQ, () => {});
      void pending.catch(() => {});

      // Chunk 1 consumed immediately; watchdog armed. Advance 200ms (< 300ms idle).
      // Chunk 1 consumed immediately; watchdog armed. Advance 200ms (< 300ms idle).
      await vi.advanceTimersByTimeAsync(200);
      push!('data: {"candidates":[{"content":[{"parts":[{"text":"b"}]}]}]}\n\n');
      await vi.advanceTimersByTimeAsync(200);
      push!('data: {"candidates":[{"content":[{"parts":[{"text":"c"}]}]}]}\n\n');
      // Total elapsed far exceeds one idle window, but resets kept it alive.
      await vi.advanceTimersByTimeAsync(200);

      // Stream stalls → watchdog fires → typed idle timeout.
      await vi.advanceTimersByTimeAsync(400);
      let caught: unknown;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderTimeoutError);
      expect((caught as ProviderTimeoutError).phase).toBe("idle");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle watchdog covers non-streaming whole-body reads (json)", async () => {
    process.env.PROVIDER_IDLE_TIMEOUT_MS = "150";
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
          const signal = init?.signal;
          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((_, reject) => {
                if (signal?.aborted) return reject((signal as any).reason);
                signal?.addEventListener("abort", () => reject((signal as any).reason), { once: true });
              }),
          } as unknown as Response;
        }),
      );
      const adapter = new OpenAIAdapter();
      const pending = adapter.call({ provider: "openai", modelName: "gpt-4o" }, LLM_REQ);
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(300);
      let caught: unknown;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderTimeoutError);
      expect((caught as ProviderTimeoutError).phase).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PERF-9 · keep-alive dispatcher forwarding", () => {
  afterEach(() => {
    _resetUndiciDispatcherForTesting();
  });

  it("providerFetch attaches the dispatcher alongside the composed CAN-1 signal", async () => {
    const fakeAgent = { __isFakeAgent: true };
    _setUndiciDispatcherForTesting(fakeAgent);

    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        } as unknown as Response;
      }),
    );

    const adapter = new OpenAIAdapter();
    const response = await adapter.call({ provider: "openai", modelName: "gpt-4o" }, LLM_REQ);

    expect(response.content).toBe("hi");
    expect(capturedInit).toBeDefined();
    expect((capturedInit as unknown as Record<string, unknown>).dispatcher).toBe(fakeAgent);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits dispatcher entirely when undici is unavailable (init unchanged)", async () => {
    _setUndiciDispatcherForTesting(undefined);

    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        } as unknown as Response;
      }),
    );

    const adapter = new OpenAIAdapter();
    await adapter.call({ provider: "openai", modelName: "gpt-4o" }, LLM_REQ);

    expect(capturedInit).toBeDefined();
    expect((capturedInit as unknown as Record<string, unknown>).dispatcher).toBeUndefined();
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

class RetryProbeRuntime extends BaseRuntime {
  readonly type = "coding" as const;
  attempts = 0;
  failure: () => never;

  constructor(failure: () => never) {
    super();
    this.failure = failure;
  }

  execute(): Promise<RuntimeResult> {
    throw new Error("unused");
  }

  run(): Promise<LLMResponse> {
    return this.invokeProviderWithPreStreamRetry(async () => {
      this.attempts++;
      this.failure();
    });
  }

  runWithChunkThenFail(chunkMarker: { emitted: boolean }): Promise<LLMResponse> {
    return this.invokeProviderWithPreStreamRetry(async (markStreamStarted) => {
      this.attempts++;
      markStreamStarted();
      chunkMarker.emitted = true;
      this.failure();
    });
  }
}

describe("CAN-1 · pre-stream retry policy (×2 exponential backoff)", () => {
  it("connect-phase timeout retries twice with 1s then 2s backoff, then fails visibly", async () => {
    vi.useFakeTimers();
    try {
      const probe = new RetryProbeRuntime(() => {
        throw new ProviderTimeoutError("connect", 10_000, "google");
      });

      const outcome = probe.run().then(
        () => null,
        (err) => ({ error: err }),
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(probe.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe.attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(probe.attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe.attempts).toBe(3);

      const result = (await outcome) as { error: unknown };
      expect(result.error).toBeInstanceOf(ProviderTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("network-class pre-stream failures are retried; API-style errors are not", async () => {
    vi.useFakeTimers();
    try {
      const networkProbe = new RetryProbeRuntime(() => {
        throw new Error("[OllamaAdapter] Network error: fetch failed - tried to POST to http://x/v1/chat/completions");
      });
      const networkOutcome = networkProbe.run().then(
        () => null,
        (err) => ({ error: err }),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(networkProbe.attempts).toBe(3);
      expect(((await networkOutcome) as { error: Error }).error).toBeInstanceOf(Error);

      const apiProbe = new RetryProbeRuntime(() => {
        throw new Error("[OpenAIAdapter] API error 401: bad key");
      });
      await expect(apiProbe.run()).rejects.toThrow(/API error 401/);
      expect(apiProbe.attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries after any chunk was emitted (post-stream)", async () => {
    vi.useFakeTimers();
    try {
      const marker = { emitted: false };
      const probe = new RetryProbeRuntime(() => {
        throw new ProviderTimeoutError("idle", 120_000, "anthropic");
      });
      const pending = probe.runWithChunkThenFail(marker);
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(probe.attempts).toBe(1);
      expect(marker.emitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries on caller abort (ProviderAbortError ≠ retryable)", async () => {
    const probe = new RetryProbeRuntime(() => {
      throw new ProviderAbortError("user aborted", "custom");
    });
    await expect(probe.run()).rejects.toBeInstanceOf(ProviderAbortError);
    expect(probe.attempts).toBe(1);
  });
});

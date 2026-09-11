import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONNECTIONS_PER_ORIGIN,
  DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_PIPELINING,
  _setUndiciDispatcherForTesting,
  getProviderDispatcher,
  getProviderKeepAliveConfig,
  getProviderKeepAliveStatus,
} from "./http-agent.js";

const ENV_KEYS = [
  "PROVIDER_KEEP_ALIVE_TIMEOUT_MS",
  "PROVIDER_KEEP_ALIVE_MAX_TIMEOUT_MS",
  "PROVIDER_PIPELINING",
  "PROVIDER_MAX_CONNECTIONS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  _setUndiciDispatcherForTesting(null);
});

describe("PERF-9 · provider keep-alive config", () => {
  it("defaults: keepAliveTimeout 10s, maxTimeout 60s, pipelining ≤4, bounded connections", () => {
    expect(getProviderKeepAliveConfig()).toEqual({
      keepAliveTimeoutMs: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeoutMs: DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS,
      pipelining: DEFAULT_PIPELINING,
      connectionsPerOrigin: DEFAULT_CONNECTIONS_PER_ORIGIN,
    });
    expect(DEFAULT_PIPELINING).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_PIPELINING).toBeLessThanOrEqual(4);
  });

  it("honors env overrides and rejects bogus values", () => {
    process.env.PROVIDER_KEEP_ALIVE_TIMEOUT_MS = "20000";
    process.env.PROVIDER_PIPELINING = "2";
    expect(getProviderKeepAliveConfig()).toMatchObject({
      keepAliveTimeoutMs: 20000,
      pipelining: 2,
    });

    process.env.PROVIDER_KEEP_ALIVE_TIMEOUT_MS = "bogus";
    process.env.PROVIDER_PIPELINING = "-3";
    process.env.PROVIDER_MAX_CONNECTIONS = "0";
    expect(getProviderKeepAliveConfig()).toMatchObject({
      keepAliveTimeoutMs: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      pipelining: DEFAULT_PIPELINING,
      connectionsPerOrigin: DEFAULT_CONNECTIONS_PER_ORIGIN,
    });
  });
});

describe("PERF-9 · dispatcher resolution", () => {
  it("returns undefined gracefully when undici is not resolvable (no throw)", async () => {
    _setUndiciDispatcherForTesting(null);
    await expect(getProviderDispatcher()).resolves.toBeUndefined();
  });

  it("returns an injected agent when one is available", async () => {
    const fakeAgent = { __isFakeAgent: true };
    _setUndiciDispatcherForTesting(fakeAgent);
    await expect(getProviderDispatcher()).resolves.toBe(fakeAgent);
  });

  it("status honestly reports fallback while undici is unavailable", async () => {
    _setUndiciDispatcherForTesting(null);
    const status = await getProviderKeepAliveStatus();
    expect(status.undiciDispatcherActive).toBe(false);
    expect(status.globalFetchPooledByDefault).toBe(true);
    expect(status.note).toMatch(/keep-alive by default/i);
  });

  it("status reports active once a dispatcher exists", async () => {
    _setUndiciDispatcherForTesting({});
    const status = await getProviderKeepAliveStatus();
    expect(status.undiciDispatcherActive).toBe(true);
  });
});

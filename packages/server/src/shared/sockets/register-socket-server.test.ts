import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

type DbStore = {
  apiKeys: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
  agents: Record<string, unknown>[];
};

interface Harness {
  port: number;
  io: any;
  broker: import("../../event-broker/event-broker-gate.js").EventBroker;
  apiKeyService: typeof import("../auth/api-key-service.js");
  socketsInternals: {
    limiter: { size: number; consume(id: string): boolean; release(id: string): void } | null;
    activeRuns(): Array<{ key: string; controller: AbortController; startedAt: number }>;
  };
  store: DbStore;
  setChannelOverride(fn: ((id: string) => Promise<unknown>) | null): void;
  cleanup: () => Promise<void>;
}

const ENV_KEYS = [
  "AUTH_STRICT",
  "AUTH_TOKEN",
  "API_KEY",
  "SOCKET_OPEN",
  "SOCKET_MSG_RATE_CAPACITY",
  "SOCKET_MSG_RATE_REFILL",
  "DURABLE_EVENTS",
  "MAX_PARALLEL_AGENTS",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let activeHarness: Harness | null = null;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  if (activeHarness) {
    await activeHarness.cleanup();
    activeHarness = null;
  }
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

async function setup(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {},
  deps: { executeRun?: (req: any) => Promise<any> } = {},
): Promise<Harness> {
  process.env.AUTH_STRICT = env.AUTH_STRICT ?? "true";
  process.env.DURABLE_EVENTS = env.DURABLE_EVENTS ?? "false";
  if (env.SOCKET_OPEN !== undefined) process.env.SOCKET_OPEN = env.SOCKET_OPEN;
  if (env.AUTH_TOKEN !== undefined) process.env.AUTH_TOKEN = env.AUTH_TOKEN;
  if (env.SOCKET_MSG_RATE_CAPACITY !== undefined) process.env.SOCKET_MSG_RATE_CAPACITY = env.SOCKET_MSG_RATE_CAPACITY;
  if (env.SOCKET_MSG_RATE_REFILL !== undefined) process.env.SOCKET_MSG_RATE_REFILL = env.SOCKET_MSG_RATE_REFILL;
  if (env.MAX_PARALLEL_AGENTS !== undefined) process.env.MAX_PARALLEL_AGENTS = env.MAX_PARALLEL_AGENTS;

  vi.resetModules();

  // The database/channelGate fakes are registered globally in src/test-setup.ts
  // (test-file-level vi.mock does not reach transitive importers under vitest
  // v4). Reset their state for this scenario.
  const [databaseModule, gateModule, brokerModule, authModule, socketModule] = await Promise.all([
    import("../config/database.js"),
    import("../../channels/channel-gate.js"),
    import("../../event-broker/event-broker-gate.js"),
    import("../auth/api-key-service.js"),
    import("./register-socket-server.js"),
  ]);
  const { registerSocketServer, _socketsInternals } = socketModule as typeof import("./register-socket-server.js");

  const socketTestDb = (databaseModule as any).__socketTestDb as {
    store: DbStore;
    reset(): void;
  };
  const socketTestGate = (gateModule as any).__socketTestChannelGate as {
    setOverride(fn: ((id: string) => Promise<unknown>) | null): void;
  };

  socketTestDb.reset();
  socketTestGate.setOverride(null);

  const broker = new brokerModule.EventBroker();
  const httpServer = createServer();
  const serverIo = registerSocketServer(httpServer, broker, deps as any);

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const clients: ClientSocket[] = [];

  const harness: Harness = {
    port,
    io: serverIo,
    broker,
    apiKeyService: authModule,
    socketsInternals: _socketsInternals as Harness["socketsInternals"],
    store: socketTestDb.store,
    setChannelOverride: (fn) => socketTestGate.setOverride(fn),
    cleanup: async () => {
      for (const client of clients.splice(0)) client.disconnect();
      await new Promise<void>((resolve, reject) => {
        serverIo.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      socketTestGate.setOverride(null);
    },
  };

  const connect = (
    opts: { auth?: Record<string, unknown> } = {},
  ): Promise<{ client: ClientSocket; error?: Error }> => {
    return new Promise((resolve) => {
      const client = io(`http://127.0.0.1:${port}`, {
        auth: opts.auth,
        transports: ["websocket"],
        reconnection: false,
        timeout: 5000,
      });
      clients.push(client);
      client.on("connect", () => resolve({ client }));
      client.on("connect_error", (err: Error) => resolve({ client, error: err }));
    });
  };
  (harness as any).connect = connect;

  activeHarness = harness;
  return harness;
}

function connectOf(harness: Harness): (opts?: { auth?: Record<string, unknown> }) => Promise<{ client: ClientSocket; error?: Error }> {
  return (harness as any).connect;
}

async function waitFor<T>(probe: () => T | undefined | false | null, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedKey(harness: Harness, label = "sec2-test") {
  const { key, record } = await harness.apiKeyService.createApiKey({ label, role: "operator" });
  return { key, record };
}

describe("SEC-2 · socket trust & room isolation", () => {
  // Generous timeout: the first test in this file pays the one-time cost of
  // importing the full runtime module graph (runtimeGate → kernels/runtimes).
  it("rejects unauthenticated handshake in strict mode", { timeout: 20_000 }, async () => {
    const harness = await setup();
    const connect = connectOf(harness);
    const { error } = await connect();
    expect(error?.message).toContain("Unauthorized");
  });

  it("accepts handshake carrying a valid seeded API key", async () => {
    const harness = await setup();
    const connect = connectOf(harness);
    const { key } = await seedKey(harness);
    const { error } = await connect({ auth: { key } });
    expect(error).toBeUndefined();
  });

  it("ignores impersonated identity claims — author identity is server-derived", async () => {
    const harness = await setup();
    const connect = connectOf(harness);
    harness.setChannelOverride(async (id: string) => (id === "chA" ? { id: "chA", name: "general" } : null));

    const { key, record } = await seedKey(harness);
    const { client, error } = await connect({
      auth: { key, userId: "victim-admin", workspaceId: "someone-elses-ws" },
    });
    expect(error).toBeUndefined();

    client.emit("user:message", {
      channelId: "chA",
      content: "hello world",
      authorId: "victim-admin",
      authorName: "Spoofed Name",
    });

    const stored = await waitFor(() => harness.store.messages.find((m) => m.channelId === "chA"));
    expect(stored.authorId).toBe(`apikey:${record.id}`);
    expect(stored.authorId).not.toBe("victim-admin");
    expect(stored.authorName).toBe("sec2-test");
  });

  it("room isolation: a socket without a membership grant receives no channel A events", async () => {
    const harness = await setup();
    const connect = connectOf(harness);
    harness.setChannelOverride(async (id: string) => (id === "chA" ? { id: "chA", name: "general" } : null));

    const { key: keyA } = await seedKey(harness, "member-key");
    const { key: keyB } = await seedKey(harness, "outsider-key");

    const member = await connect({ auth: { key: keyA } });
    const outsider = await connect({ auth: { key: keyB } });
    expect(member.error).toBeUndefined();
    expect(outsider.error).toBeUndefined();

    const receivedByMember: any[] = [];
    const receivedByOutsider: any[] = [];
    member.client.onAny((type, envelope) => receivedByMember.push({ type, envelope }));
    outsider.client.onAny((type, envelope) => receivedByOutsider.push({ type, envelope }));

    member.client.emit("channel:join", { channelId: "chA" });
    await waitFor(() => harness.io.sockets.adapter.rooms.has("channel:chA"));

    const event = harness.broker.emit(
      "message:new",
      { id: "msg-1", channelId: "chA", content: "secret" } as never,
      { channelId: "chA" },
    );

    await waitFor(() => receivedByMember.find((e) => e.type === "message:new" && e.envelope.eventId === event.eventId));
    expect(receivedByMember[0].envelope.type).toBe("message:new");
    await sleep(300);
    expect(receivedByOutsider).toHaveLength(0);
  });

  it("denies joining a nonexistent channel and delivers nothing to it", async () => {
    const harness = await setup();
    const connect = connectOf(harness);

    const { key } = await seedKey(harness);
    const session = await connect({ auth: { key } });
    expect(session.error).toBeUndefined();

    const errors: any[] = [];
    session.client.on("error" as any, (payload: any) => errors.push(payload));

    const received: any[] = [];
    session.client.onAny((type, envelope) => received.push({ type, envelope }));

    session.client.emit("channel:join", { channelId: "chGhost" });
    await waitFor(() => errors.find((e) => e.code === "channel_not_found"));
    expect(harness.io.sockets.adapter.rooms.has("channel:chGhost")).toBe(false);

    harness.broker.emit(
      "message:new",
      { id: "msg-ghost", channelId: "chGhost", content: "classified" } as never,
      { channelId: "chGhost" },
    );
    await sleep(300);
    expect(received.find((e) => e.type === "message:new")).toBeUndefined();
  });

  it("throttles bursts beyond the token bucket with rate_limited envelopes", async () => {
    const harness = await setup({
      SOCKET_MSG_RATE_CAPACITY: "2",
      SOCKET_MSG_RATE_REFILL: "1",
    });
    const connect = connectOf(harness);

    const { key } = await seedKey(harness);
    const session = await connect({ auth: { key } });
    expect(session.error).toBeUndefined();

    const errors: any[] = [];
    session.client.on("error" as any, (payload: any) => errors.push(payload));

    for (let i = 0; i < 6; i++) {
      session.client.emit("user:message", { channelId: "chThrottle", content: `burst ${i}` });
    }

    await sleep(700);
    const limited = errors.filter((e) => e.code === "rate_limited");
    expect(limited.length).toBe(4);
    expect(errors.length).toBe(limited.length);
  });

  it("disconnect releases rooms and per-socket state without cancelling runs", async () => {
    const harness = await setup();
    const connect = connectOf(harness);
    harness.setChannelOverride(async (id: string) => (id === "chA" ? { id: "chA", name: "general" } : null));

    const { key } = await seedKey(harness);
    const session = await connect({ auth: { key } });
    expect(session.error).toBeUndefined();

    session.client.emit("user:message", { channelId: "chA", content: "populate limiter" });
    await waitFor(() => harness.socketsInternals.limiter && harness.socketsInternals.limiter.size === 1);

    session.client.disconnect();
    await waitFor(() => harness.io.sockets.sockets.size === 0);
    await waitFor(() => !harness.io.sockets.adapter.rooms.has("channel:chA"));
    await waitFor(() => harness.socketsInternals.limiter!.size === 0);
  });

  it("SOCKET_OPEN=true restores open rollback behavior in dev", async () => {
    const harness = await setup({ SOCKET_OPEN: "true" });
    const connect = connectOf(harness);
    harness.setChannelOverride(async () => null);

    const { client, error } = await connect({ auth: { userId: "legacy-user", workspaceId: "ws-x" } });
    expect(error).toBeUndefined();

    client.emit("channel:join", { channelId: "anything-goes" });
    await waitFor(() => harness.io.sockets.adapter.rooms.has("channel:anything-goes"));
  });
});

describe("SEC-5 fold-in · socket message rate limiter", () => {
  it("defaults to capacity 15 / refill 5 per second", async () => {
    delete process.env.SOCKET_MSG_RATE_CAPACITY;
    delete process.env.SOCKET_MSG_RATE_REFILL;
    const mod = await import("./rate-limiter.js");
    expect(mod.getRateLimitConfig()).toEqual({ capacity: 15, refillPerSecond: 5 });
  });

  it("reads overrides from SOCKET_MSG_RATE_* env", async () => {
    process.env.SOCKET_MSG_RATE_CAPACITY = "30";
    process.env.SOCKET_MSG_RATE_REFILL = "10";
    const mod = await import("./rate-limiter.js");
    expect(mod.getRateLimitConfig()).toEqual({ capacity: 30, refillPerSecond: 10 });
    process.env.SOCKET_MSG_RATE_CAPACITY = "bogus";
    expect(mod.getRateLimitConfig()).toEqual({ capacity: 15, refillPerSecond: 10 });
  });

  it("token bucket drops beyond capacity and refills over time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const mod = await import("./rate-limiter.js");
      const bucket = new mod.TokenBucket(3, 5);
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(false);

      vi.setSystemTime(200);
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only user-content-producing events are throttled", async () => {
    const mod = await import("./rate-limiter.js");
    expect(mod.isThrottledEvent("user:message")).toBe(true);
    expect(mod.isThrottledEvent("channel:join")).toBe(false);
    expect(mod.isThrottledEvent("workspace:join")).toBe(false);
    expect(mod.isThrottledEvent("typing")).toBe(false);
  });
});

/**
 * CAN-1 fixture: a run executor that mirrors a real runtime — hangs until the
 * run's abort signal fires (then resolves 'cancelled'), or until the test
 * explicitly releases it (then resolves 'completed').
 */
function makeHangingExecutor() {
  const calls: any[] = [];
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const executor = vi.fn(async (req: any) => {
    calls.push(req);
    signals.push(req.abortSignal);
    return new Promise((resolve) => {
      releases.push(() =>
        resolve({
          requestId: req.requestId,
          agentId: req.agent.id,
          channelId: req.channelId,
          finalResponse: "done",
          runtimeEvents: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "completed",
        }),
      );
      req.abortSignal?.addEventListener(
        "abort",
        () =>
          resolve({
            requestId: req.requestId,
            agentId: req.agent.id,
            channelId: req.channelId,
            finalResponse: "Run cancelled by user.",
            runtimeEvents: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            status: "cancelled",
          }),
        { once: true },
      );
    });
  });
  return {
    executor,
    calls,
    signals,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
    cancelledCount: () => signals.filter((s) => s.aborted).length,
  };
}

function seedAgent(store: DbStore, id: string, name: string): void {
  store.agents.push({
    id,
    name,
    title: "Test Agent",
    authorityLevel: 0,
    status: "idle",
    isTemplate: false,
    workspaceId: "default",
  });
}

describe("CAN-1 · cancellation & duplicate-trigger integrity", () => {
  it("rejects a second trigger for a running channel:agent pair and keeps the first controller alive", { timeout: 20_000 }, async () => {
    const hang = makeHangingExecutor();
    const harness = await setup({}, { executeRun: hang.executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chA" ? { id: "chA", name: "general" } : null));
      seedAgent(harness.store, "agent-canary", "Tester");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chA", content: "@Tester first request" });
      await waitFor(() => hang.calls.length === 1);

      // First run is registered and NOT stranded by what comes next.
      const runs = harness.socketsInternals.activeRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].key).toBe("chA:agent-canary");
      expect(runs[0].controller.signal.aborted).toBe(false);

      session.client.emit("user:message", { channelId: "chA", content: "@Tester second request" });

      // Explicit rejection surfaces via the existing system-warning vocabulary.
      await waitFor(() =>
        harness.store.messages.some(
          (m) => typeof m.content === "string" && m.content.includes("already running"),
        ),
      );

      // The duplicate never reached the executor; original controller untouched.
      expect(hang.calls).toHaveLength(1);
      expect(hang.signals[0].aborted).toBe(false);
      expect(harness.socketsInternals.activeRuns()).toHaveLength(1);
      expect(hang.calls[0].abortSignal).toBe(harness.socketsInternals.activeRuns()[0].controller.signal);
    } finally {
      hang.releaseAll();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("user:cancel aborts the active run and the registry entry is cleaned up after settle", { timeout: 20_000 }, async () => {
    const hang = makeHangingExecutor();
    const harness = await setup({}, { executeRun: hang.executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chB" ? { id: "chB", name: "build" } : null));
      seedAgent(harness.store, "agent-busy", "Builder");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chB", content: "@Builder start work" });
      await waitFor(() => hang.calls.length === 1);

      session.client.emit("user:cancel", { channelId: "chB" });

      await waitFor(() => hang.signals[0]?.aborted === true);
      await waitFor(() => harness.socketsInternals.activeRuns().length === 0);
    } finally {
      hang.releaseAll();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("array-safe registry: concurrent distinct agents cancel independently by agentId scope", { timeout: 20_000 }, async () => {
    const hang = makeHangingExecutor();
    const harness = await setup({}, { executeRun: hang.executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chC" ? { id: "chC", name: "ops" } : null));
      seedAgent(harness.store, "agent-alpha", "Alpha");
      seedAgent(harness.store, "agent-beta", "Beta");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chC", content: "@Alpha go" });
      session.client.emit("user:message", { channelId: "chC", content: "@Beta go" });
      await waitFor(() => hang.calls.length === 2);

      const keys = harness.socketsInternals.activeRuns().map((r) => r.key).sort();
      expect(keys).toEqual(["chC:agent-alpha", "chC:agent-beta"]);

      // Scoped cancel hits only the named agent's controller.
      session.client.emit("user:cancel", { channelId: "chC", agentId: "agent-alpha" });
      await waitFor(() => hang.signals[0]?.aborted === true && !hang.signals[1]?.aborted);

      // Unscoped cancel takes the remaining one.
      session.client.emit("user:cancel", { channelId: "chC" });
      await waitFor(() => hang.signals[1]?.aborted === true);
      await waitFor(() => harness.socketsInternals.activeRuns().length === 0);
    } finally {
      hang.releaseAll();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("disconnect still leaves in-flight runs untouched (HM2 preserved)", { timeout: 20_000 }, async () => {
    const hang = makeHangingExecutor();
    const harness = await setup({}, { executeRun: hang.executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chD" ? { id: "chD", name: "bg" } : null));
      seedAgent(harness.store, "agent-bg", "Runner");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chD", content: "@Runner long task" });
      await waitFor(() => hang.calls.length === 1);

      session.client.disconnect();
      await waitFor(() => harness.io.sockets.sockets.size === 0);
      await sleep(150);

      expect(hang.signals[0].aborted).toBe(false);
      expect(harness.socketsInternals.activeRuns().length).toBe(1);
    } finally {
      hang.releaseAll();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });
});

function captureMetrics() {
  const metrics: Array<{ stage: string; durationMs?: number; agents?: number; parallel?: number }> = [];
  const original = console.log.bind(console);
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    try {
      const parsed = JSON.parse(String(args[0])) as { stage?: string };
      if (parsed && typeof parsed === "object" && typeof parsed.stage === "string") {
        metrics.push(parsed as (typeof metrics)[number]);
      }
    } catch {
      // not a structured metric line
    }
    original(...args);
  });
  return { metrics, restore: () => spy.mockRestore() };
}

interface DelayedExecutor {
  executor: (req: any) => Promise<any>;
  calls: string[];
}

function makeDelayedExecutor(opts: { delays?: Record<string, number>; failIds?: Set<string> } = {}): DelayedExecutor {
  const delays = opts.delays ?? {};
  const failIds = opts.failIds ?? new Set<string>();
  const calls: string[] = [];
  const executor = async (req: any) => {
    calls.push(req.agent.id);
    await sleep(delays[req.agent.id] ?? 0);
    if (failIds.has(req.agent.id)) throw new Error(`boom-${req.agent.id}`);
    return {
      requestId: req.requestId,
      agentId: req.agent.id,
      channelId: req.channelId,
      finalResponse: `done-${req.agent.id}`,
      runtimeEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: "completed",
    };
  };
  return { executor, calls };
}

describe("PERF-1 · parallel mention dispatch", () => {
  it("dispatches 3 mentioned agents concurrently — batch completes in <1.3× slowest agent", { timeout: 20_000 }, async () => {
    const delayed = makeDelayedExecutor({ delays: { "agent-alpha": 300, "agent-beta": 100, "agent-gamma": 200 } });
    const harness = await setup({}, { executeRun: delayed.executor as any });
    const metrics = captureMetrics();
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chP1" ? { id: "chP1", name: "perf" } : null));
      seedAgent(harness.store, "agent-alpha", "Alpha");
      seedAgent(harness.store, "agent-beta", "Beta");
      seedAgent(harness.store, "agent-gamma", "Gamma");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chP1", content: "@Alpha @Beta @Gamma go" });

      await waitFor(() => metrics.metrics.find((m) => m.stage === "mention.dispatch"));
      expect(delayed.calls.sort()).toEqual(["agent-alpha", "agent-beta", "agent-gamma"]);
      expect(harness.socketsInternals.activeRuns()).toHaveLength(0);

      const metric = metrics.metrics.find((m) => m.stage === "mention.dispatch")!;
      expect(metric.agents).toBe(3);
      expect(metric.parallel).toBe(4);
      const maxDelay = 300;
      expect(metric.durationMs!).toBeLessThan(maxDelay * 1.3);
      expect(metric.durationMs!).toBeGreaterThanOrEqual(maxDelay - 40);
    } finally {
      metrics.restore();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("MAX_PARALLEL_AGENTS=1 restores legacy serial cumulative timing (rollback path)", { timeout: 20_000 }, async () => {
    const delayed = makeDelayedExecutor({ delays: { "agent-alpha": 120, "agent-beta": 120, "agent-gamma": 120 } });
    const harness = await setup({ MAX_PARALLEL_AGENTS: "1" }, { executeRun: delayed.executor as any });
    const metrics = captureMetrics();
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chS1" ? { id: "chS1", name: "serial" } : null));
      seedAgent(harness.store, "agent-alpha", "Alpha");
      seedAgent(harness.store, "agent-beta", "Beta");
      seedAgent(harness.store, "agent-gamma", "Gamma");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chS1", content: "@Alpha @Beta @Gamma go" });

      await waitFor(() => metrics.metrics.find((m) => m.stage === "mention.dispatch"));
      const metric = metrics.metrics.find((m) => m.stage === "mention.dispatch")!;
      expect(metric.parallel).toBe(1);
      expect(metric.durationMs!).toBeGreaterThanOrEqual(350);
      expect(metric.durationMs!).toBeLessThan(2500);
    } finally {
      metrics.restore();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("one rejecting agent does not affect siblings' results", { timeout: 20_000 }, async () => {
    const delayed = makeDelayedExecutor({
      delays: { "agent-alpha": 50, "agent-beta": 20, "agent-gamma": 50 },
      failIds: new Set(["agent-beta"]),
    });
    const harness = await setup({}, { executeRun: delayed.executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chX1" ? { id: "chX1", name: "isolation" } : null));
      seedAgent(harness.store, "agent-alpha", "Alpha");
      seedAgent(harness.store, "agent-beta", "Beta");
      seedAgent(harness.store, "agent-gamma", "Gamma");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chX1", content: "@Alpha @Beta @Gamma go" });

      await waitFor(() =>
        harness.store.messages.some(
          (m) => typeof m.content === "string" && m.content.includes("System error processing @Beta"),
        ),
      );
      await waitFor(() => harness.socketsInternals.activeRuns().length === 0);

      expect(delayed.calls.sort()).toEqual(["agent-alpha", "agent-beta", "agent-gamma"]);

      const warnings = harness.store.messages
        .filter((m) => m.authorId === "system")
        .map((m) => String(m.content));
      expect(warnings.some((c) => c.includes("System error processing @Beta") && c.includes("boom-agent-beta"))).toBe(true);
      expect(warnings.some((c) => c.includes("@Alpha"))).toBe(false);
      expect(warnings.some((c) => c.includes("@Gamma"))).toBe(false);
    } finally {
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });

  it("busy agent is skipped with a warning while the rest of the batch proceeds", { timeout: 20_000 }, async () => {
    const calls: string[] = [];
    let releaseBeta: () => void = () => {};
    const executor = vi.fn(async (req: any) => {
      calls.push(req.agent.id);
      if (req.agent.id === "agent-beta") {
        await new Promise<void>((resolve) => {
          releaseBeta = resolve;
        });
      } else {
        await sleep(40);
      }
      return {
        requestId: req.requestId,
        agentId: req.agent.id,
        channelId: req.channelId,
        finalResponse: `done-${req.agent.id}`,
        runtimeEvents: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "completed",
      };
    });
    const harness = await setup({}, { executeRun: executor as any });
    try {
      const connect = connectOf(harness);
      harness.setChannelOverride(async (id: string) => (id === "chB1" ? { id: "chB1", name: "busy" } : null));
      seedAgent(harness.store, "agent-beta", "Beta");
      seedAgent(harness.store, "agent-gamma", "Gamma");

      const { key } = await seedKey(harness);
      const session = await connect({ auth: { key } });
      expect(session.error).toBeUndefined();

      session.client.emit("user:message", { channelId: "chB1", content: "@Beta hold" });
      await waitFor(() => harness.socketsInternals.activeRuns().some((r) => r.key === "chB1:agent-beta"));

      session.client.emit("user:message", { channelId: "chB1", content: "@Beta @Gamma go" });

      await waitFor(() => calls.filter((id) => id === "agent-gamma").length === 1);
      await waitFor(() =>
        harness.store.messages.some(
          (m) => typeof m.content === "string" && m.content.includes("already running"),
        ),
      );

      expect(calls.filter((id) => id === "agent-beta")).toHaveLength(1);
      const betaSignal = harness.socketsInternals.activeRuns().find((r) => r.key === "chB1:agent-beta");
      expect(betaSignal?.controller.signal.aborted).toBe(false);

      releaseBeta();
      await waitFor(() => harness.socketsInternals.activeRuns().length === 0);
    } finally {
      releaseBeta();
      await sleep(50);
      await harness.cleanup();
      activeHarness = null;
    }
  });
});

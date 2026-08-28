import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRateLimitOptions, isRateLimitEnabled, registerRateLimit } from "./rateLimit.js";

async function buildApp(opts: { max: number; timeWindowMs: number }) {
  const app = Fastify();

  // Mirrors index.ts ordering: root-level onRequest hook (identity resolution)
  // added BEFORE registerRateLimit, so the limiter's route-level hooks run after.
  app.addHook("onRequest", async (request) => {
    const key = request.headers["x-test-key"];
    if (typeof key === "string" && key.length > 0) {
      request.identity = { id: key, label: null, role: "admin" };
    }
  });

  const registered = await registerRateLimit(app, { max: opts.max, timeWindowMs: opts.timeWindowMs });
  expect(registered).toBe(true);

  app.get("/probe", async () => ({ ok: true }));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/health", async () => ({ status: "ok" }));

  await app.ready();
  return app;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function hit(app: TestApp, path: string, ip?: string) {
  return app.inject({ method: "GET", url: path, remoteAddress: ip });
}

describe("SEC-5 · HTTP rate limiting (@fastify/rate-limit v11)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.RATE_LIMIT_ENABLED;
  });

  it("returns 200 under the limit and a 429 rate_limited body once exceeded", async () => {
    const app = await buildApp({ max: 3, timeWindowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      const res = await hit(app, "/probe");
      expect(res.statusCode).toBe(200);
    }

    const limited = await hit(app, "/probe");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    const body = limited.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it("exempts /health and /api/health from the global bucket", async () => {
    const app = await buildApp({ max: 2, timeWindowMs: 60_000 });
    for (let i = 0; i < 6; i++) {
      expect((await hit(app, "/health")).statusCode).toBe(200);
      expect((await hit(app, "/api/health")).statusCode).toBe(200);
    }
    await app.close();
  });

  it("keys the global bucket by identity.id so two keys do not share a bucket", async () => {
    const app = await buildApp({ max: 2, timeWindowMs: 60_000 });
    const injectWithKey = async (path: string, key: string) =>
      app.inject({ method: "GET", url: path, headers: { "x-test-key": key } });

    expect((await injectWithKey("/probe", "key-a")).statusCode).toBe(200);
    expect((await injectWithKey("/probe", "key-a")).statusCode).toBe(200);
    expect((await injectWithKey("/probe", "key-a")).statusCode).toBe(429);

    expect((await injectWithKey("/probe", "key-b")).statusCode).toBe(200);

    await app.close();
  });

  it("falls back to remote address when identity is absent", async () => {
    const app = await buildApp({ max: 2, timeWindowMs: 60_000 });
    for (let i = 0; i < 2; i++) {
      expect((await hit(app, "/probe", "10.9.9.1")).statusCode).toBe(200);
    }
    expect((await hit(app, "/probe", "10.9.9.1")).statusCode).toBe(429);
    expect((await hit(app, "/probe", "10.9.9.2")).statusCode).toBe(200);
    await app.close();
  });

  it("buildRateLimitOptions honors env tuning and allowlists health paths", async () => {
    vi.stubEnv("RATE_LIMIT_MAX", "42");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "12345");
    const options = buildRateLimitOptions() as { max: number; timeWindow: number };
    expect(options.max).toBe(42);
    expect(options.timeWindow).toBe(12345);
  });

  it("RATE_LIMIT_ENABLED=false disables registration entirely", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    expect(isRateLimitEnabled()).toBe(false);

    const app = Fastify();
    const registered = await registerRateLimit(app, { max: 1, timeWindowMs: 60_000 });
    expect(registered).toBe(false);
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/probe" })).statusCode).toBe(200);
    }
    await app.close();
  });
});

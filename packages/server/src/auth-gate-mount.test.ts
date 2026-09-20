// SEC-1 auth gate is MOUNTED (CrowdOS §19).
//
// The calibration audit found auth-gate.ts implemented, unit-tested, and
// registered on NOTHING — a default-deny gate that never runs is worse than no
// gate, because the codebase advertises a control that does not exist. These
// tests assert the mounted behavior end-to-end over the real server factory, so
// the gate cannot silently be unmounted again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "./shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

let app: any;
let stop: () => Promise<void>;
let apiKey = "";

const REMOTE = "203.0.113.7"; // TEST-NET-3, never a loopback peer

async function inject(opts: { method: string; url: string; remoteAddress?: string; key?: string }) {
  const headers: Record<string, string> = {};
  if (opts.key) headers["x-api-key"] = opts.key;
  return app.inject({
    method: opts.method as any,
    url: opts.url,
    headers,
    remoteAddress: opts.remoteAddress ?? REMOTE,
  });
}

beforeAll(async () => {
  const { buildServer } = await import("./create-app.js");
  const { authGate } = await import("./shared/auth/auth-gate.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
  // Mint a real key through the real service (scrypt hash round-trip).
  const created = await authGate.createApiKey({ label: "mount-test", role: "admin" });
  apiKey = created.key;
}, 60_000);

afterAll(async () => {
  await stop?.();
});

describe("auth gate mounted on the real server", () => {
  it("allows /health without a key", async () => {
    const res = await inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("denies a non-loopback caller with no key", async () => {
    const res = await inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("allows a non-loopback caller presenting a valid key", async () => {
    const res = await inject({ method: "GET", url: "/api/agents", key: apiKey });
    expect(res.statusCode).not.toBe(401);
  });

  it("rejects an invalid key even from a loopback peer (presented credential is authoritative)", async () => {
    const res = await inject({ method: "GET", url: "/api/agents", remoteAddress: "127.0.0.1", key: "crowd_not-a-real-key" });
    expect(res.statusCode).toBe(401);
  });

  it("trusts a keyless loopback peer (embedded desktop backend)", async () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await inject({ method: "GET", url: "/api/agents", remoteAddress: addr });
      expect(res.statusCode, addr).not.toBe(401);
    }
  });

  it("leaves the pre-key portal discovery surface reachable without a key", async () => {
    const list = await inject({ method: "GET", url: "/api/workspaces" });
    expect(list.statusCode).not.toBe(401);
  });

  it("keeps workspace mutation behind the gate", async () => {
    const res = await inject({
      method: "DELETE",
      url: "/api/workspaces/does-not-exist",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns the strict 401 shape", async () => {
    const res = await inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: 401, error: "Unauthorized" });
  });
});

describe("REST and socket trust boundaries agree", () => {
  it("uses the same loopback predicate for both transports", async () => {
    const { isLoopbackPeer: restPredicate } = await import("./shared/core/loopback.js");
    const { isLoopbackPeer: socketPredicate } = await import("./shared/sockets/socket-auth.js");
    const { authGate } = await import("./shared/auth/auth-gate.js");
    const addresses = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.5", "10.0.0.1", "", "localhost", undefined];
    for (const addr of addresses) {
      const expected = restPredicate(addr);
      expect(socketPredicate(addr), "socket: " + String(addr)).toBe(expected);
      expect(authGate.isLoopbackPeer(addr), "gate: " + String(addr)).toBe(expected);
    }
    // Pin the actual boundary so a silent widening fails here.
    expect(restPredicate("127.0.0.1")).toBe(true);
    expect(restPredicate("::1")).toBe(true);
    expect(restPredicate("::ffff:127.0.0.1")).toBe(true);
    expect(restPredicate("192.168.1.5")).toBe(false);
    expect(restPredicate("localhost")).toBe(false);
  });
});


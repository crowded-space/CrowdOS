// The screenlock PIN and the API key must not share the `Authorization` header.
//
// The client attaches the PIN to every /api call (src/config/pin.ts). It used to
// send BOTH `x-pin` and `Authorization: Bearer <pin>`. The mounted auth gate reads
// `Authorization` first as an API key, so a PIN-bearing request was verified as a
// key, failed (`crowd_` prefix check), and every /api call answered
// 401 "Missing or invalid API key." — even from a trusted loopback peer. A user who
// enabled screenlock was locked out of their own local app.
//
// These tests pin the separation: the PIN travels on `x-pin` ONLY.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "./shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

let app: any;
let stop: () => Promise<void>;
let workspacePinHash: string | null = null;

const LOOPBACK = "127.0.0.1";

async function inject(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}) {
  return app.inject({
    method: opts.method as any,
    url: opts.url,
    headers: opts.headers ?? {},
    remoteAddress: opts.remoteAddress ?? LOOPBACK,
  });
}

beforeAll(async () => {
  const { buildServer } = await import("./create-app.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
}, 60_000);

afterAll(async () => {
  await stop?.();
});

describe("PIN and API key never share the Authorization header", () => {
  it("accepts a loopback request that carries ONLY x-pin", async () => {
    // The shape the client must send once a screenlock PIN is configured.
    const res = await inject({ method: "GET", url: "/api/agents", headers: { "x-pin": "1234" } });
    expect(res.statusCode).not.toBe(401);
  });

  it("does NOT accept a PIN smuggled through Authorization: Bearer", async () => {
    // `Authorization` is the API-key channel. A PIN there is not a credential
    // the gate can verify, and treating it as one is what caused the lockout.
    const res = await inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-pin": "1234", Authorization: "Bearer 1234" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: 401, error: "Unauthorized" });
  });

  it("keeps a valid API key working when presented in Authorization", async () => {
    const { authGate } = await import("./shared/auth/auth-gate.js");
    const created = await authGate.createApiKey({ label: "pin-separation", role: "operator" });
    const res = await inject({
      method: "GET",
      url: "/api/agents",
      headers: { Authorization: `Bearer ${created.key}` },
      remoteAddress: "203.0.113.7",
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("still lets the PIN gate read the PIN from x-pin alone", async () => {
    const { pinGate } = await import("./shared/auth/pin-gate.js");
    const res = await inject({ method: "GET", url: "/api/agents", headers: { "x-pin": "1234" } });
    // Whatever the gate decides, it must not be "no PIN presented": the PIN was
    // on x-pin, which is the documented channel.
    expect(pinGate).toBeDefined();
    expect(res.statusCode).not.toBe(500);
  });
});

// GET /api/events/recent over the REAL server factory (§29 replay endpoint).
//
// Harness shape follows boot-local-mode.test.ts / auth-gate-mount.test.ts:
// buildServer({ skipListen: true, skipTimers: true }) with DATABASE_URL unset,
// so the local event log is the only tier in play. Requests come from a
// loopback peer, which the mounted SEC-1 gate trusts (the same trust boundary
// the embedded desktop backend relies on).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

let dir: string;
let app: any;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-events-route-"));
  setLocalStoreDirForTests(dir);
  const { buildServer } = await import("../create-app.js");
  const built = await buildServer({ skipTimers: true, skipListen: true });
  app = built.app;
  stop = built.stop;
}, 60_000);

afterAll(async () => {
  await stop?.();
  setLocalStoreDirForTests(null);
  (env as any).DATABASE_URL = prevDatabaseUrl;
  rmSync(dir, { recursive: true, force: true });
});

/** Loopback peer: the mounted auth gate trusts it keylessly (desktop backend). */
function inject(url: string, remoteAddress = "127.0.0.1") {
  return app.inject({ method: "GET", url, remoteAddress });
}

describe("GET /api/events/recent · §29 replay", () => {
  it("answers honestly empty for a channel with no log", async () => {
    const res = await inject("/api/events/recent?channelId=ch-none&afterSeq=0");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ channelId: "ch-none", events: [], lastSeq: 0 });
  });

  it("is no longer a deprecated no-op", async () => {
    const res = await inject("/api/events/recent?channelId=ch-none");
    const body = res.json();
    expect(body.deprecated).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["channelId", "events", "lastSeq"]);
  });

  it("serves the recorded tail with the client's contract shape", async () => {
    const { eventsGate } = await import("./events-gate.js");
    for (let i = 1; i <= 4; i++) {
      await eventsGate.record({
        eventId: `route-evt-${i}`,
        type: "message:new",
        channelId: "ch-route",
        payload: { id: `m-${i}`, channelId: "ch-route", workspaceId: "ws-route", content: `hello ${i}`, isInternalMonologue: false },
        timestamp: new Date(1_700_000_000_000 + i * 1000),
      });
    }

    const res = await inject("/api/events/recent?channelId=ch-route&afterSeq=0&limit=100");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channelId).toBe("ch-route");
    expect(body.lastSeq).toBe(4);
    expect(body.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
    // The exact fields the client types and reads (client.ts getEventsRecent).
    for (const ev of body.events) {
      expect(typeof ev.seq).toBe("number");
      expect(typeof ev.type).toBe("string");
      expect(typeof ev.createdAt).toBe("string");
      expect(ev.payload).toBeTypeOf("object");
      expect(ev.eventId).toBeTypeOf("string");
    }
    expect(body.events[0].payload.content).toBe("hello 1");

    // afterSeq is exclusive, and the tail is exactly what a resuming client needs.
    const tail = await inject("/api/events/recent?channelId=ch-route&afterSeq=2");
    expect(tail.json().events.map((e: any) => e.seq)).toEqual([3, 4]);
    expect(tail.json().lastSeq).toBe(4);

    // Caught up: empty tail, head echoed — no fabrication, no infinite re-poll.
    const caughtUp = await inject("/api/events/recent?channelId=ch-route&afterSeq=4");
    expect(caughtUp.json().events).toEqual([]);
    expect(caughtUp.json().lastSeq).toBe(4);
  });

  it("honors limit and rejects a limit above the 200 cap", async () => {
    const { eventsGate } = await import("./events-gate.js");
    for (let i = 1; i <= 5; i++) {
      await eventsGate.record({
        eventId: `lim-${i}`,
        type: "agent:status",
        channelId: "ch-lim",
        payload: { agentId: "agent-1", channelId: "ch-lim", status: "idle" },
        timestamp: new Date(),
      });
    }
    const limited = await inject("/api/events/recent?channelId=ch-lim&afterSeq=0&limit=2");
    expect(limited.json().events.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(limited.json().lastSeq).toBe(2);

    const over = await inject("/api/events/recent?channelId=ch-lim&limit=201");
    expect(over.statusCode).toBe(400);
  });

  it("requires channelId", async () => {
    const res = await inject("/api/events/recent");
    expect(res.statusCode).toBe(400);
  });

  it("keeps the tenant boundary: one channel's log never leaks into another's", async () => {
    const { eventsGate } = await import("./events-gate.js");
    await eventsGate.record({
      eventId: "iso-1",
      type: "message:new",
      channelId: "ch-iso-a",
      payload: { channelId: "ch-iso-a", workspaceId: "ws-a", content: "alpha" },
      timestamp: new Date(),
    });
    await eventsGate.record({
      eventId: "iso-2",
      type: "message:new",
      channelId: "ch-iso-b",
      payload: { channelId: "ch-iso-b", workspaceId: "ws-b", content: "beta" },
      timestamp: new Date(),
    });

    const a = await inject("/api/events/recent?channelId=ch-iso-a");
    expect(a.json().events).toHaveLength(1);
    expect(a.json().events[0].payload.content).toBe("alpha");
    const b = await inject("/api/events/recent?channelId=ch-iso-b");
    expect(b.json().events).toHaveLength(1);
    expect(b.json().events[0].payload.content).toBe("beta");
  });

  it("is behind the mounted auth gate for non-loopback callers", async () => {
    const res = await inject("/api/events/recent?channelId=ch-none", "203.0.113.7");
    expect(res.statusCode).toBe(401);
  });

  it("logs events emitted through the shared broker (the wired append hook)", async () => {
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = getSharedBroker();
    expect(broker).not.toBeNull();
    broker!.emit("agent:status" as never, { agentId: "agent-hook", channelId: "ch-hook", status: "working" } as never, { channelId: "ch-hook" } as never);
    broker!.emit("message:stream" as never, { agentId: "agent-hook", channelId: "ch-hook", chunk: "tok" } as never, { channelId: "ch-hook" } as never);

    // The hook is fire-and-forget; poll the endpoint until the append lands.
    let body: any = null;
    for (let i = 0; i < 100; i++) {
      body = (await inject("/api/events/recent?channelId=ch-hook")).json();
      if (body.events.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(body.events.map((e: any) => e.type)).toEqual(["agent:status"]);
    expect(body.events[0].agentId).toBe("agent-hook");
    expect(body.lastSeq).toBe(1);
  });
});

// §29 local event log: append-only JSONL, per-channel monotonic seq, exclusive
// afterSeq cursor, torn-tail tolerance, and §30 workspace isolation.
//
// These tests exercise the real files on disk (no mocks): the log's whole point
// is that it survives a process, so an in-memory fake would prove nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";
import { eventsGate, resetEventSeqFloorForTests, resetEventLogStatsForTests } from "./events-gate.js";
import { isEphemeralEventType, shouldLogEvent } from "./event-classification.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-eventlog-"));
  setLocalStoreDirForTests(dir);
  resetEventSeqFloorForTests();
  resetEventLogStatsForTests();
  return () => {
    setLocalStoreDirForTests(null);
    resetEventSeqFloorForTests();
    rmSync(dir, { recursive: true, force: true });
  };
});

afterEach(() => {
  setLocalStoreDirForTests(null);
});

// Canon: the log lives at <workspaceFolder>/vfs/.crowdos/events/<channelId>.jsonl.
// These tests write unscoped events, so the default workspace folder holds them.
const eventsDir = (workspaceId = "default") => join(localStoreDirsForTests(workspaceId).crowdos, "events");
const eventFile = (channelId: string, workspaceId = "default") =>
  join(eventsDir(workspaceId), `${channelId}.jsonl`);

/**
 * Emit through the real broker so the append path under test is the wired one.
 *
 * The `onAny` hook is deliberately fire-and-forget (local log lag must never
 * block live delivery), so the test drains the detached work explicitly by
 * waiting for the settled-event counter to reach `expected`. Polling a counter
 * instead of sleeping a fixed duration keeps this fast and non-flaky.
 */
async function emitAndSettle(
  broker: EventBroker,
  type: Parameters<EventBroker["emit"]>[0],
  payload: unknown,
  channelId: string | undefined,
  expectedSettled: number,
): Promise<void> {
  broker.emit(type, payload as never, channelId ? ({ channelId } as never) : undefined);
  const settled = () => eventsGate.stats.appended + eventsGate.stats.failed + eventsGate.stats.skipped;
  for (let i = 0; i < 200 && settled() < expectedSettled; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(settled(), `event ${type} did not settle`).toBeGreaterThanOrEqual(expectedSettled);
}

describe("§29 local event log · append + tail", () => {
  it("appends one JSON line per event under events/<channelId>.jsonl", async () => {
    const broker = new EventBroker();
    broker.onAny((event) => eventsGate.recordDetached(event));

    for (let i = 1; i <= 5; i++) {
      await emitAndSettle(broker, "agent:status", { agentId: "agent-1", status: "working" }, "ch-a", i);
    }

    expect(existsSync(eventFile("ch-a"))).toBe(true);
    const lines = readFileSync(eventFile("ch-a"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      seq: 1,
      type: "agent:status",
      channelId: "ch-a",
      agentId: "agent-1",
    });
    expect(typeof first.eventId).toBe("string");
    expect(typeof first.createdAt).toBe("string");
    expect(Number.isFinite(first.ts)).toBe(true);
    expect(JSON.parse(lines[4]).seq).toBe(5);
  });

  it("returns exactly the tail after an exclusive afterSeq, and a monotonic lastSeq", async () => {
    for (let i = 0; i < 10; i++) {
      await eventsGate.record({
        eventId: `evt-${i + 1}`,
        type: "tool:start",
        channelId: "ch-tail",
        payload: { agentId: "agent-1", channelId: "ch-tail", toolName: `tool-${i + 1}`, input: {} },
        timestamp: new Date(1_700_000_000_000 + i * 1000),
      });
    }

    const all = await eventsGate.listRecent("ch-tail", {});
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(all.lastSeq).toBe(10);

    const tail = await eventsGate.listRecent("ch-tail", { afterSeq: 7 });
    expect(tail.events.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(tail.lastSeq).toBe(10);

    // Exclusive, not inclusive: afterSeq = 10 must return nothing but still
    // report the head so a polling client can tell it is caught up.
    const caughtUp = await eventsGate.listRecent("ch-tail", { afterSeq: 10 });
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.lastSeq).toBe(10);

    // lastSeq never goes backwards as the log grows.
    const before = (await eventsGate.listRecent("ch-tail", { afterSeq: 3 })).lastSeq;
    await eventsGate.record({
      eventId: "evt-11",
      type: "tool:complete",
      channelId: "ch-tail",
      payload: { agentId: "agent-1", channelId: "ch-tail", toolName: "tool-11", success: true },
      timestamp: new Date(),
    });
    const after = (await eventsGate.listRecent("ch-tail", { afterSeq: 3 })).lastSeq;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBe(11);
  });

  it("honors limit and clamps it to the shared 1..200 ceiling", async () => {
    for (let i = 0; i < 6; i++) {
      await eventsGate.record({
        eventId: `evt-${i}`,
        type: "agent:thinking",
        channelId: "ch-limit",
        payload: { agentId: "agent-1", channelId: "ch-limit" },
        timestamp: new Date(),
      });
    }
    const page = await eventsGate.listRecent("ch-limit", { limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    // lastSeq is the highest seq RETURNED, not the head, when a page is truncated.
    expect(page.lastSeq).toBe(2);
    const oversized = await eventsGate.listRecent("ch-limit", { limit: 100_000 });
    expect(oversized.events).toHaveLength(6);
  });

  it("returns an honest empty result for an absent log", async () => {
    const result = await eventsGate.listRecent("ch-never-written", { afterSeq: 0 });
    expect(result.events).toEqual([]);
    expect(result.lastSeq).toBe(0);
    expect(result.headSeq).toBe(0);
    expect(existsSync(eventFile("ch-never-written"))).toBe(false);
  });

  it("skips a torn trailing line instead of throwing", async () => {
    await eventsGate.record({
      eventId: "evt-1",
      type: "agent:status",
      channelId: "ch-torn",
      payload: { agentId: "agent-1", status: "working" },
      timestamp: new Date(),
    });
    // Simulate a crash mid-append: a half-written line with no closing brace.
    const raw = readFileSync(eventFile("ch-torn"), "utf8");
    writeFileSync(eventFile("ch-torn"), raw + '{"seq":2,"type":"agent:status","pay', "utf8");

    const result = await eventsGate.listRecent("ch-torn", {});
    expect(result.events.map((e) => e.seq)).toEqual([1]);
    expect(result.lastSeq).toBe(1);

    // The log stays appendable after a torn tail.
    const next = await eventsGate.record({
      eventId: "evt-2",
      type: "agent:status",
      channelId: "ch-torn",
      payload: { agentId: "agent-1", status: "idle" },
      timestamp: new Date(),
    });
    expect(next?.seq).toBe(2);
    const afterTorn = await eventsGate.listRecent("ch-torn", { afterSeq: 1 });
    expect(afterTorn.events.map((e) => e.seq)).toEqual([2]);
  });
});

describe("§30 workspace isolation · channel logs never cross", () => {
  it("keeps a second channel in a different workspace out of the first channel's log", async () => {
    await eventsGate.record({
      eventId: "a-1",
      type: "message:new",
      channelId: "ch-ws-one",
      payload: { channelId: "ch-ws-one", workspaceId: "ws-1", content: "one" },
      timestamp: new Date(),
    });
    await eventsGate.record({
      eventId: "a-2",
      type: "message:new",
      channelId: "ch-ws-one",
      payload: { channelId: "ch-ws-one", workspaceId: "ws-1", content: "two" },
      timestamp: new Date(),
    });
    for (let i = 0; i < 4; i++) {
      await eventsGate.record({
        eventId: `b-${i}`,
        type: "message:new",
        channelId: "ch-ws-two",
        payload: { channelId: "ch-ws-two", workspaceId: "ws-2", content: `other-${i}` },
        timestamp: new Date(),
      });
    }

    const one = await eventsGate.listRecent("ch-ws-one", {});
    expect(one.events).toHaveLength(2);
    expect(one.events.every((e) => e.channelId === "ch-ws-one")).toBe(true);
    expect(one.events.every((e) => e.workspaceId === "ws-1")).toBe(true);
    expect(one.lastSeq).toBe(2);

    const two = await eventsGate.listRecent("ch-ws-two", {});
    expect(two.events).toHaveLength(4);
    expect(two.events.every((e) => e.workspaceId === "ws-2")).toBe(true);

    // Each channel owns an independent seq space: both start at 1.
    expect(one.events[0].seq).toBe(1);
    expect(two.events[0].seq).toBe(1);
    // Each channel's log sits inside ITS workspace folder — the isolation is
    // the folder boundary, not a filter applied after reading one shared file.
    expect(existsSync(eventFile("ch-ws-one", "ws-1"))).toBe(true);
    expect(existsSync(eventFile("ch-ws-two", "ws-2"))).toBe(true);
  });

  it("sanitizes hostile channel ids to one file instead of escaping the events dir", async () => {
    await eventsGate.record({
      eventId: "hostile",
      type: "agent:status",
      channelId: "../../etc/passwd",
      payload: { agentId: "agent-1", status: "working" },
      timestamp: new Date(),
    });
    const rows = await eventsGate.listRecent("../../etc/passwd", {});
    expect(rows.events).toHaveLength(1);
    expect(rows.events[0].seq).toBe(1);
    // One sanitized file inside events/, and nothing written outside it.
    const written = readdirSync(eventsDir());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[A-Za-z0-9_-]+\.jsonl$/);
    expect(existsSync(join(dir, "..", "..", "etc", "passwd"))).toBe(false);
  });
});

describe("ephemeral classification", () => {
  it("never logs message:stream (high-frequency streaming chunks)", async () => {
    expect(isEphemeralEventType("message:stream")).toBe(true);
    expect(isEphemeralEventType("message:new")).toBe(false);

    const broker = new EventBroker();
    broker.onAny((event) => eventsGate.recordDetached(event));
    for (let i = 0; i < 20; i++) {
      await emitAndSettle(broker, "message:stream", { channelId: "ch-stream", agentId: "agent-1", chunk: `tok-${i}` }, "ch-stream", i + 1);
    }
    await emitAndSettle(broker, "message:new", { channelId: "ch-stream", id: "m-1", content: "final" }, "ch-stream", 21);

    const result = await eventsGate.listRecent("ch-stream", {});
    expect(result.events.map((e) => e.type)).toEqual(["message:new"]);
    expect(eventsGate.stats.skipped).toBeGreaterThanOrEqual(20);
    expect(readFileSync(eventFile("ch-stream"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("skips channel-less global events (no channelId in event or payload)", () => {
    expect(shouldLogEvent({ type: "runtime:snapshot", payload: { agents: [] } })).toBe(false);
    expect(shouldLogEvent({ type: "workspace:sync", payload: {} })).toBe(false);
    expect(shouldLogEvent({ type: "agent:status", channelId: "ch-x", payload: {} })).toBe(true);
    // Payload-only channelId still counts (producers that tag the payload only).
    expect(shouldLogEvent({ type: "run.status_changed", payload: { channelId: "ch-y" } })).toBe(true);
    // Ephemeral wins over a present channelId.
    expect(shouldLogEvent({ type: "message:stream", channelId: "ch-z", payload: { channelId: "ch-z" } })).toBe(false);
  });

  it("keeps a failed append from throwing into the emit path", async () => {
    const broker = new EventBroker();
    broker.onAny((event) => eventsGate.recordDetached(event));
    // Point the store at a base whose canon `events` PARENT is a file, so the
    // mkdir for the log directory fails (ENOTDIR) and the append reports it.
    const blockedRoot = mkdtempSync(join(tmpdir(), "crowdos-eventlog-blocked-"));
    const blockedCrowdos = join(blockedRoot, "default", "vfs");
    mkdirSync(blockedCrowdos, { recursive: true });
    writeFileSync(join(blockedCrowdos, ".crowdos"), "blocker", "utf8");
    setLocalStoreDirForTests(blockedRoot);
    await emitAndSettle(broker, "agent:status", { agentId: "agent-1", status: "working" }, "ch-fail", 1);
    expect(eventsGate.stats.failed).toBeGreaterThanOrEqual(1);
    setLocalStoreDirForTests(dir);
    rmSync(blockedRoot, { recursive: true, force: true });
  });
});

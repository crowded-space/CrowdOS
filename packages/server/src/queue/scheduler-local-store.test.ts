import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import {
  localDeactivateSchedule,
  localListActiveSchedules,
  localSaveSchedule,
  localUpdateNextRun,
  nextCronOccurrence,
} from "./scheduler-local-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-scheduler-store-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

function oneShot(overrides: Partial<Parameters<typeof localSaveSchedule>[0]> = {}) {
  return {
    id: "sched-1",
    channelId: "ch-1",
    workspaceId: "ws-a",
    task: "wake me",
    delaySeconds: 60,
    ...overrides,
  };
}

describe("scheduler local store — round trip (A1)", () => {
  it("writes a row, lists it active, updates nextRun and deactivates it", async () => {
    const saved = await localSaveSchedule(oneShot());
    expect(saved).toMatchObject({
      id: "sched-1",
      channelId: "ch-1",
      workspaceId: "ws-a",
      task: "wake me",
      message: null,
      targetAgentId: null,
      cron: null,
      isActive: true,
    });

    const active = await localListActiveSchedules("ws-a");
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual(saved);

    expect(await localUpdateNextRun("sched-1", "2030-01-01T00:00:00.000Z", "ws-a")).toBe(true);
    const updated = await localListActiveSchedules("ws-a");
    expect(updated[0].nextRun).toBe("2030-01-01T00:00:00.000Z");

    expect(await localDeactivateSchedule("sched-1", "ws-a")).toBe(true);
    expect(await localListActiveSchedules("ws-a")).toHaveLength(0);
    // The row stays in the file as history — deactivate, not delete.
    expect(await localUpdateNextRun("sched-1", null, "ws-a")).toBe(true);
  });

  it("keeps the same schedule id in two workspaces apart (§30 isolation)", async () => {
    await localSaveSchedule(oneShot({ workspaceId: "ws-a" }));
    await localSaveSchedule(oneShot({ workspaceId: "ws-b", task: "other" }));

    const a = await localListActiveSchedules("ws-a");
    const b = await localListActiveSchedules("ws-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].workspaceId).toBe("ws-a");
    expect(b[0].workspaceId).toBe("ws-b");
    expect(a[0].task).toBe("wake me");
    expect(b[0].task).toBe("other");
  });

  it("computes nextRun from the delay of a one-shot", async () => {
    const now = new Date("2026-10-20T10:00:00.000Z");
    const row = await localSaveSchedule(oneShot({ delaySeconds: 90 }), now);
    expect(row.nextRun).toBe("2026-10-20T10:01:30.000Z");
  });

  it("computes nextRun as the next boundary of a */N cron", async () => {
    const now = new Date("2026-10-20T10:03:20.000Z");
    const row = await localSaveSchedule(oneShot({ cron: "*/5 * * * *", delaySeconds: null }), now);
    expect(row.nextRun).toBe("2026-10-20T10:05:00.000Z");
  });

  it("leaves nextRun null for a cron form the local tier cannot track", async () => {
    const row = await localSaveSchedule(oneShot({ cron: "0 3 * * *", delaySeconds: null }));
    expect(row.cron).toBe("0 3 * * *");
    expect(row.nextRun).toBeNull();
  });

  it("dedupes a row when overlapping scopes resolve to the same store file", async () => {
    setLocalStoreDirForTests(null);
    const registry = join(dir, "workspaces.json");
    writeFileSync(registry, JSON.stringify([{ id: "ws-a" }, { id: "ws-b" }]));
    const prevStore = process.env.CROWDOS_LOCALSTORE_DIR;
    const prevRegistry = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
    process.env.CROWDOS_LOCALSTORE_DIR = join(dir, "shared-store");
    process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = registry;
    try {
      await localSaveSchedule(oneShot({ workspaceId: "ws-a" }));
      const rows = await localListActiveSchedules();
      expect(rows.map((row) => row.id)).toEqual(["sched-1"]);
    } finally {
      if (prevStore === undefined) delete process.env.CROWDOS_LOCALSTORE_DIR;
      else process.env.CROWDOS_LOCALSTORE_DIR = prevStore;
      if (prevRegistry === undefined) delete process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
      else process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = prevRegistry;
      setLocalStoreDirForTests(dir);
    }
  });

  it("reports a missing row instead of creating one in an unrelated workspace", async () => {
    expect(await localUpdateNextRun("sched-missing", "2030-01-01T00:00:00.000Z", "ws-a")).toBe(false);
    expect(await localDeactivateSchedule("sched-missing", "ws-a")).toBe(false);
    expect(await localListActiveSchedules("ws-a")).toHaveLength(0);
  });
});

describe("nextCronOccurrence — the */N boundary", () => {
  const at = (iso: string) => new Date(iso);

  it("moves to the next multiple inside the hour", () => {
    expect(nextCronOccurrence("*/5 * * * *", at("2026-10-20T10:01:00.000Z"))).toBe("2026-10-20T10:05:00.000Z");
    expect(nextCronOccurrence("*/5 * * * *", at("2026-10-20T10:05:00.000Z"))).toBe("2026-10-20T10:10:00.000Z");
    expect(nextCronOccurrence("*/15 * * * *", at("2026-10-20T10:01:00.000Z"))).toBe("2026-10-20T10:15:00.000Z");
  });

  it("rolls to the next hour when the hour has no boundary left", () => {
    expect(nextCronOccurrence("*/5 * * * *", at("2026-10-20T10:57:10.000Z"))).toBe("2026-10-20T11:00:00.000Z");
    expect(nextCronOccurrence("*/7 * * * *", at("2026-10-20T10:58:10.000Z"))).toBe("2026-10-20T11:00:00.000Z");
  });

  it("treats an exact boundary as already fired", () => {
    expect(nextCronOccurrence("*/5 * * * *", at("2026-10-20T10:05:00.000Z"))).toBe("2026-10-20T10:10:00.000Z");
  });

  it("returns null for anything it cannot compute", () => {
    expect(nextCronOccurrence("0 3 * * *", at("2026-10-20T10:05:00.000Z"))).toBeNull();
    expect(nextCronOccurrence("@daily", at("2026-10-20T10:05:00.000Z"))).toBeNull();
    expect(nextCronOccurrence("*/0 * * * *", at("2026-10-20T10:05:00.000Z"))).toBeNull();
    expect(nextCronOccurrence("*/99 * * * *", at("2026-10-20T10:05:00.000Z"))).toBeNull();
  });
});

describe("nextCronOccurrence — the every-N-hours boundary", () => {
  // Hour boundaries are local-time boundaries (like a real crontab), so the
  // expectations are computed in local time and hold in any timezone.
  const localAt = (y: number, mo: number, d: number, h: number, min: number) =>
    new Date(y, mo, d, h, min, 0, 0);

  it("moves to the next matching hour", () => {
    const from = localAt(2026, 9, 20, 10, 30);
    const next = nextCronOccurrence("0 */2 * * *", from);
    expect(next).not.toBeNull();
    const at = new Date(next as string);
    expect(at.getHours() % 2).toBe(0);
    expect(at.getMinutes()).toBe(0);
    expect(at.getTime()).toBeGreaterThan(from.getTime());
  });

  it("lands exactly two hours later when the start hour already matches", () => {
    const from = localAt(2026, 9, 20, 10, 30);
    const next = new Date(nextCronOccurrence("0 */2 * * *", from) as string);
    expect(Math.round((next.getTime() - from.getTime()) / 3_600_000)).toBe(2);
  });

  it("honours the minute field", () => {
    const from = localAt(2026, 9, 20, 10, 0);
    const next = new Date(nextCronOccurrence("30 */4 * * *", from) as string);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours() % 4).toBe(0);
  });

  it("returns null for an unusable hour step or minute", () => {
    const from = localAt(2026, 9, 20, 10, 0);
    expect(nextCronOccurrence("0 */0 * * *", from)).toBeNull();
    expect(nextCronOccurrence("0 */25 * * *", from)).toBeNull();
    expect(nextCronOccurrence("60 */2 * * *", from)).toBeNull();
  });

  it("does NOT read */120 as every 2 hours (it is not a minute field)", () => {
    // */120 in the minute field cannot fire hourly-silently: the inline tier
    // rejects it, and the local tier must not track it either.
    const from = localAt(2026, 9, 20, 10, 0);
    expect(nextCronOccurrence("*/120 * * * *", from)).toBeNull();
  });
});

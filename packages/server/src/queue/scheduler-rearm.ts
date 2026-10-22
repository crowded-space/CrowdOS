// ─── Scheduler boot re-arm (A2) ───────────────────────────────────────
// Inline-tier timers live here, not in the Tools domain. The store row is
// truth: every arm and every fire writes `nextRun` back, so a restart can
// recalibrate against the wall clock instead of replaying missed fires:
//
//   one-shot overdue   → fire once now (catch-up), then deactivate
//   one-shot future    → arm the remainder
//   cron               → skip missed occurrences, arm the next boundary
//
// A cron form the local tier cannot compute (`nextRun: null`) is skipped and
// reported, never fired at an unknown time. BullMQ mode owns its own timers
// in Redis and is never armed locally (that would double-fire).

import { getQueueMode } from "./connection.js";
import {
  localDeactivateSchedule,
  localListActiveSchedules,
  localUpdateNextRun,
  nextCronOccurrence,
} from "./scheduler-local-store.js";
import type { scheduleRow } from "./scheduler-local-store.js";
import { dispatchScheduledRun } from "./scheduler-dispatch.js";

export type rearmReport = {
  mode: "inline" | "bullmq";
  armed: number;
  firedCatchUp: number;
  skipped: { id: string; reason: string }[];
};

const timers = new Map<string, NodeJS.Timeout>();
// Bumped by disarmAll so a fire that was already in flight cannot re-register
// a timer after shutdown. The row stays persisted for the next boot.
let generation = 0;
// Single-flight: concurrent boots share one run instead of both listing the
// same overdue row and firing it twice.
let inFlight: Promise<rearmReport> | null = null;

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(id);
}

export function disarmAll(): void {
  generation += 1;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

async function fireSchedule(row: scheduleRow): Promise<void> {
  const channelId = row.channelId || "general";
  // The wake carries the scheduler's OWN words: the message the agent wrote for
  // its future self, or the description it gave when it booked the schedule.
  // The scheduler never speaks in its own voice.
  const content = row.message?.trim() || row.task?.trim() || `⏰ Scheduled task: ${row.id}`;
  try {
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
    type emitter = { emit: (t: string, p: unknown, o?: unknown) => void };
    const broker =
      (getSharedBroker() as unknown as emitter | null) ?? (globalBroker as unknown as emitter | null);
    if (!broker) {
      console.warn("[scheduler] dropped scheduled emit: no shared broker registered");
      return;
    }
    // The wake IS the message: the shared dispatch persists it and lets the
    // standard ladder pick the agent (the channel's pinned mention by default).
    await dispatchScheduledRun(row, content, broker as never);
    try {
      broker.emit(
        "scheduled:triggered",
        {
          id: row.id,
          channelId,
          task: row.task,
          triggeredAt: new Date().toISOString(),
        } as never,
        { channelId },
      );
    } catch {}
  } catch (err) {
    console.error("[scheduler] fire failed", err);
  }
}

async function fireOneShot(row: scheduleRow): Promise<void> {
  await fireSchedule(row);
  await localUpdateNextRun(row.id, null, row.workspaceId);
  await localDeactivateSchedule(row.id, row.workspaceId);
}

async function fireCron(row: scheduleRow, armedGeneration: number): Promise<void> {
  await fireSchedule(row);
  if (!row.cron) return;
  // Shutdown may have happened while the fire was awaited. The generation was
  // captured before the await so it is visible here; never resurrect a timer.
  if (armedGeneration !== generation) return;
  if (!nextCronOccurrence(row.cron, new Date())) {
    console.warn(`[scheduler] cannot re-arm cron "${row.cron}" for ${row.id}; leaving it inactive until re-armed by hand`);
    await localUpdateNextRun(row.id, null, row.workspaceId);
    return;
  }
  await armSchedule(row, new Date(), armedGeneration);
}

/**
 * Arm one persisted row on the inline tier. The fire time is recomputed from
 * `now` (cron: next boundary strictly after; one-shot: the stored `nextRun`),
 * persisted, and then handed to a single `setTimeout` owned by this module.
 */
export async function armSchedule(
  row: scheduleRow,
  now: Date = new Date(),
  armedGeneration: number = generation,
): Promise<scheduleRow> {
  if (getQueueMode() === "bullmq") return row;
  const nextRun = row.cron ? nextCronOccurrence(row.cron, now) : row.nextRun;
  if (!nextRun) return row;

  const armedRow: scheduleRow = { ...row, nextRun };
  await localUpdateNextRun(row.id, nextRun, row.workspaceId);
  if (armedGeneration !== generation) return armedRow;

  clearTimer(row.id);
  const delay = Math.max(0, new Date(nextRun).getTime() - Date.now());
  const timer = setTimeout(() => {
    timers.delete(row.id);
    // Capture before any await: a fire started before `disarmAll` must not
    // re-arm after it, even though the append below resolves later.
    const fireGeneration = generation;
    const fire = row.cron ? fireCron(armedRow, fireGeneration) : fireOneShot(armedRow);
    void fire.catch((err) => console.error("[scheduler] scheduled fire failed", err));
  }, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  timers.set(row.id, timer);
  return armedRow;
}

/**
 * Boot re-arm. Lists every active row (unscoped), recalibrates each against
 * `now`, and reports what it did. A row that cannot be armed is reported in
 * `skipped`; one bad row never aborts the rest.
 */
export function rearmSchedules(now: Date = new Date()): Promise<rearmReport> {
  if (inFlight) return inFlight;
  const run = runRearm(now).then(
    (report) => {
      if (inFlight === run) inFlight = null;
      return report;
    },
    (err) => {
      if (inFlight === run) inFlight = null;
      throw err;
    },
  );
  inFlight = run;
  return run;
}

async function runRearm(now: Date): Promise<rearmReport> {
  const mode = getQueueMode();
  if (mode === "bullmq") {
    console.info("[queue] boot re-arm skipped in bullmq mode — BullMQ/Redis owns scheduled timers");
    return { mode, armed: 0, firedCatchUp: 0, skipped: [] };
  }

  // Capture before the list await: a disarmAll() that lands while the store is
  // being read must cancel this run, not be mistaken for the current epoch.
  const armedGeneration = generation;
  const report: rearmReport = { mode, armed: 0, firedCatchUp: 0, skipped: [] };
  const rows = await localListActiveSchedules();
  for (const row of rows) {
    if (armedGeneration !== generation) break;
    try {
      if (row.cron) {
        if (!nextCronOccurrence(row.cron, now)) {
          report.skipped.push({ id: row.id, reason: `cron "${row.cron}" is not trackable by the local tier` });
          continue;
        }
        await armSchedule(row, now, armedGeneration);
        if (timers.has(row.id)) report.armed += 1;
        continue;
      }
      if (!row.nextRun) {
        report.skipped.push({ id: row.id, reason: "one-shot schedule has no nextRun" });
        continue;
      }
      if (new Date(row.nextRun).getTime() <= now.getTime()) {
        await fireOneShot(row);
        report.firedCatchUp += 1;
        continue;
      }
      await armSchedule(row, now, armedGeneration);
      if (timers.has(row.id)) report.armed += 1;
    } catch (err) {
      report.skipped.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

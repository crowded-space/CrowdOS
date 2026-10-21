import { getQueueMode as _getQueueMode, closeConnection as _closeConnection } from "./connection.js";
import { enqueueRun as _enqueueRun, closeQueues as _closeQueues, getMaintenanceQueue, getRunsQueue, getFailedJobs as _getFailedJobs, getSchedulerQueue as _getSchedulerQueue } from "./queues.js";
import type { EnqueueRunInput } from "./queues.js";
import { scheduleMaintenance as _scheduleMaintenance } from "./repeatables.js";
import { stopRunWorker as _stopRunWorker } from "./run-worker.js";
import { stopMaintenanceWorker as _stopMaintenanceWorker } from "./maintenance-worker.js";
import { startSchedulerWorker as _startSchedulerWorker, stopSchedulerWorker as _stopSchedulerWorker } from "./scheduler-worker.js";
import {
  localSaveSchedule as _saveSchedule,
  localListActiveSchedules as _listActiveSchedules,
  localUpdateNextRun as _updateNextRun,
  localDeactivateSchedule as _deactivateSchedule,
} from "./scheduler-local-store.js";
import type { scheduleInput, scheduleRow } from "./scheduler-local-store.js";
import {
  armSchedule as _armSchedule,
  rearmSchedules as _rearmSchedules,
  disarmAll as _disarmAll,
} from "./scheduler-rearm.js";
import type { rearmReport } from "./scheduler-rearm.js";

export type { EnqueueRunInput };
export type { scheduleInput, scheduleRow, rearmReport };

async function healthCheck(): Promise<{ mode: string; connected: boolean; waiting: number; failed: number }> {
  const mode = _getQueueMode();
  if (mode !== "bullmq") {
    return { mode, connected: false, waiting: 0, failed: 0 };
  }
  // ponytail: 2s per-Redis-call cap; maxRetriesPerRequest:null queues forever on outage
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("redis timeout")), 2000);
        t.unref?.();
      }),
    ]);
  try {
    const conn = (await import("./connection.js")).getRedisConnection();
    let connected = false;
    if (conn) {
      try {
        const pong = await withTimeout(conn.ping());
        connected = pong === "PONG";
      } catch {
        connected = false;
      }
    }
    let waiting = 0;
    let failed = 0;
    try {
      const rq = getRunsQueue();
      if (rq) {
        const counts = await withTimeout(rq.getJobCounts("waiting", "failed", "active", "delayed"));
        waiting += Number(counts.waiting ?? 0) + Number(counts.active ?? 0) + Number(counts.delayed ?? 0);
        failed += Number(counts.failed ?? 0);
      }
    } catch {}
    try {
      const mq = getMaintenanceQueue();
      if (mq) {
        const counts = await withTimeout(mq.getJobCounts("waiting", "failed"));
        waiting += Number(counts.waiting ?? 0);
        failed += Number(counts.failed ?? 0);
      }
    } catch {}
    try {
      const { getSchedulerQueue } = await import("./queues.js");
      const sq = getSchedulerQueue();
      if (sq) {
        const counts = await withTimeout(sq.getJobCounts("waiting", "failed", "delayed"));
        waiting += Number(counts.waiting ?? 0) + Number(counts.delayed ?? 0);
        failed += Number(counts.failed ?? 0);
      }
    } catch {}
    return { mode, connected, waiting, failed };
  } catch {
    return { mode, connected: false, waiting: 0, failed: 0 };
  }
}

async function drain(): Promise<void> {
  if (_getQueueMode() !== "bullmq") return;
  try {
    await _stopRunWorker();
  } catch (err) {
    console.error("[queue] drain: stopRunWorker failed", err);
  }
  try {
    await _stopMaintenanceWorker();
  } catch (err) {
    console.error("[queue] drain: stopMaintenanceWorker failed", err);
  }
  try {
    await _stopSchedulerWorker();
  } catch (err) {
    console.error("[queue] drain: stopSchedulerWorker failed", err);
  }
  try {
    await _closeQueues();
  } catch (err) {
    console.error("[queue] drain: closeQueues failed", err);
  }
  try {
    await _closeConnection();
  } catch (err) {
    console.error("[queue] drain: closeConnection failed", err);
  }
}

export const queueGate = {
  mode: _getQueueMode,
  enqueueRun: _enqueueRun,
  scheduleMaintenance: _scheduleMaintenance,
  healthCheck,
  drain,
  getFailedJobs: _getFailedJobs,
  getSchedulerQueue: _getSchedulerQueue,
  startSchedulerWorker: _startSchedulerWorker,
  // A1 · scheduler durability (local file tier): a schedule is written here
  // before it is armed, so an armed timer that dies with the process is
  // still known to the next boot.
  saveSchedule: _saveSchedule,
  listActiveSchedules: _listActiveSchedules,
  updateNextRun: _updateNextRun,
  deactivateSchedule: _deactivateSchedule,
  // A2 · in-memory timers live in the Queue domain: boot re-arm recalibrates
  // persisted rows, and shutdown disarms every local timer.
  armSchedule: _armSchedule,
  rearmSchedules: _rearmSchedules,
  disarmAll: _disarmAll,
};

import { getQueueMode as _getQueueMode, closeConnection as _closeConnection } from "./connection.js";
import { enqueueRun as _enqueueRun, closeQueues as _closeQueues, getMaintenanceQueue, getRunsQueue, getFailedJobs as _getFailedJobs, getSchedulerQueue as _getSchedulerQueue } from "./queues.js";
import type { EnqueueRunInput } from "./queues.js";
import { scheduleMaintenance as _scheduleMaintenance } from "./repeatables.js";
import { stopRunWorker as _stopRunWorker } from "./run-worker.js";
import { stopMaintenanceWorker as _stopMaintenanceWorker } from "./maintenance-worker.js";
import { startSchedulerWorker as _startSchedulerWorker, stopSchedulerWorker as _stopSchedulerWorker } from "./scheduler-worker.js";

export type { EnqueueRunInput };

async function healthCheck(): Promise<{ mode: string; connected: boolean; waiting: number; failed: number }> {
  const mode = _getQueueMode();
  if (mode !== "bullmq") {
    return { mode, connected: false, waiting: 0, failed: 0 };
  }
  try {
    const conn = (await import("./connection.js")).getRedisConnection();
    let connected = false;
    if (conn) {
      try {
        const pong = await conn.ping();
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
        const counts = await rq.getJobCounts("waiting", "failed", "active", "delayed");
        waiting += Number(counts.waiting ?? 0) + Number(counts.active ?? 0) + Number(counts.delayed ?? 0);
        failed += Number(counts.failed ?? 0);
      }
    } catch {}
    try {
      const mq = getMaintenanceQueue();
      if (mq) {
        const counts = await mq.getJobCounts("waiting", "failed");
        waiting += Number(counts.waiting ?? 0);
        failed += Number(counts.failed ?? 0);
      }
    } catch {}
    try {
      const { getSchedulerQueue } = await import("./queues.js");
      const sq = getSchedulerQueue();
      if (sq) {
        const counts = await sq.getJobCounts("waiting", "failed", "delayed");
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
};

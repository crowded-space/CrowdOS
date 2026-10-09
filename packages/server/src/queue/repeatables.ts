import { getQueueMode } from "./connection.js";
import { getMaintenanceQueue } from "./queues.js";

export interface RepeatableSpec {
  id: string;
  name: string;
  everyMs: number;
}

export const REPEATABLES: RepeatableSpec[] = [
  { id: "librarian-delta", name: "librarian-delta", everyMs: 10 * 60 * 1000 },
  { id: "heartbeats-touch", name: "heartbeats-touch", everyMs: 15_000 },
  { id: "orphan-sweep", name: "orphan-sweep", everyMs: 20_000 },
  { id: "orphan-resume", name: "orphan-resume", everyMs: 30_000 },
  { id: "suppress-expiry", name: "suppress-expiry", everyMs: 10 * 60 * 1000 },
  { id: "retention", name: "retention", everyMs: 6 * 60 * 60 * 1000 },
  { id: "snapshot-full", name: "snapshot-full", everyMs: 15_000 },
  { id: "approval-expire", name: "approval-expire", everyMs: 30_000 },
  // THR-007: thread TTL expiry had no scheduler — the sweep existed only as
  // a manual POST endpoint, so expired threads never transitioned anywhere.
  { id: "thread-expire", name: "thread-expire", everyMs: 60_000 },
];

export async function scheduleMaintenance(): Promise<void> {
  if (getQueueMode() !== "bullmq") return;
  const queue = getMaintenanceQueue();
  if (!queue) return;

  const { startRunWorker } = await import("./run-worker.js");
  const { startMaintenanceWorker } = await import("./maintenance-worker.js");
  await startRunWorker();
  await startMaintenanceWorker();

  for (const spec of REPEATABLES) {
    try {
      await queue.upsertJobScheduler(spec.id, { every: spec.everyMs }, {
        name: spec.name,
        data: { kind: spec.id },
        opts: {
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 3600 },
        },
      });
    } catch (err) {
      console.error(`[Queue] Failed to schedule repeatable ${spec.id}`, (err as Error)?.message || err);
    }
  }
}

export async function removeMaintenanceSchedulers(): Promise<void> {
  if (getQueueMode() !== "bullmq") return;
  const queue = getMaintenanceQueue();
  if (!queue) return;
  for (const spec of REPEATABLES) {
    try {
      await queue.removeJobScheduler(spec.id);
    } catch {}
  }
}

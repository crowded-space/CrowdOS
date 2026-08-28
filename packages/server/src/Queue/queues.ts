import { Queue } from "bullmq";
import { getQueueMode, getRedisConnection } from "./connection.js";

export const RUNS_QUEUE_NAME = "runs";
export const MAINTENANCE_QUEUE_NAME = "maintenance";
export const SCHEDULER_QUEUE_NAME = "scheduler";

export interface EnqueueRunInput {
  runId?: string | null;
  channelId: string;
  agentId: string;
  messageId: string;
  userInput: string;
  workspaceId?: string | null;
}

export interface EnqueueResult {
  id: string;
  jobId: string;
}

const RUNS_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 60000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
};

const MAINTENANCE_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 3600 },
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 60000 },
};

const SCHEDULER_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 3600 },
  attempts: 1,
};

let runsQueue: Queue | null = null;
let maintenanceQueue: Queue | null = null;
let schedulerQueue: Queue | null = null;

export function getRunsQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (runsQueue) return runsQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  runsQueue = new Queue(RUNS_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: RUNS_DEFAULT_JOB_OPTIONS,
  });
  runsQueue.on("error", () => {});
  return runsQueue;
}

export function getMaintenanceQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (maintenanceQueue) return maintenanceQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: MAINTENANCE_DEFAULT_JOB_OPTIONS,
  });
  maintenanceQueue.on("error", () => {});
  return maintenanceQueue;
}

export function getSchedulerQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (schedulerQueue) return schedulerQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  schedulerQueue = new Queue(SCHEDULER_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: SCHEDULER_DEFAULT_JOB_OPTIONS,
  });
  schedulerQueue.on("error", () => {});
  return schedulerQueue;
}

export async function enqueueRun(input: EnqueueRunInput): Promise<EnqueueResult | null> {
  if (getQueueMode() !== "bullmq") return null;
  const queue = getRunsQueue();
  if (!queue) return null;
  const jobId = `${input.channelId}:${input.agentId}:${input.messageId}`;
  try {
    const job = await queue.add("run", input, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 60000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 604800 },
    });
    return { id: String(job.id), jobId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("JobId") || msg.includes("already exists") || msg.includes("exists")) {
      return { id: jobId, jobId };
    }
    throw err;
  }
}

export async function closeQueues(): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (runsQueue) {
    const q = runsQueue;
    runsQueue = null;
    tasks.push(q.close().catch(() => {}));
  }
  if (maintenanceQueue) {
    const q = maintenanceQueue;
    maintenanceQueue = null;
    tasks.push(q.close().catch(() => {}));
  }
  if (schedulerQueue) {
    const q = schedulerQueue;
    schedulerQueue = null;
    tasks.push(q.close().catch(() => {}));
  }
  await Promise.all(tasks);
}

export function resetQueuesForTests(): void {
  runsQueue = null;
  maintenanceQueue = null;
  schedulerQueue = null;
}

export function getJobOptions() {
  return {
    attempts: 3,
    backoffDelays: [60000, 300000, 1500000],
    lockDuration: 900000,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 604800 },
  };
}

export async function getFailedJobs(limit = 100): Promise<Array<{
  id: string | undefined;
  jobId: string | undefined;
  name: string;
  data: unknown;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number | undefined;
  processedOn: number | null;
  finishedOn: number | null;
  stacktrace: string[];
  opts: unknown;
}>> {
  if (getQueueMode() !== "bullmq") return [];
  const queue = getRunsQueue();
  if (!queue) return [];
  try {
    const jobs = await queue.getFailed(0, Math.min(limit, 100) - 1);
    return jobs.slice(0, limit).map((j) => ({
      id: j.id,
      jobId: (j.opts as Record<string, unknown>).jobId as string | undefined ?? j.id,
      name: j.name,
      data: j.data,
      failedReason: j.failedReason ?? (j as unknown as { stacktrace?: string[] }).stacktrace?.[0] ?? null,
      attemptsMade: j.attemptsMade,
      timestamp: j.timestamp,
      processedOn: (j as unknown as { processedOn?: number }).processedOn ?? null,
      finishedOn: j.finishedOn ?? null,
      stacktrace: j.stacktrace ?? [],
      opts: j.opts,
    }));
  } catch {
    return [];
  }
}

import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { getQueueMode, createRedisConnection } from "./connection.js";

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
  /** Manual runtime choice at send time — worker forwards it instead of re-routing Auto. */
  explicitRuntime?: string | null;
  /** §6 channel pin forwarded so the worker's Router resolves it identically. */
  preferredRuntime?: string | null;
  // ponytail: untyped by design — checkpoint shape owned by runs, queue just ferries it
  resumeContext?: unknown;
  resumeFrom?: unknown;
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
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 60000 },
};

let runsQueue: Queue | null = null;
let maintenanceQueue: Queue | null = null;
let schedulerQueue: Queue | null = null;
let runsConn: InstanceType<typeof IORedis> | null = null;
let maintenanceConn: InstanceType<typeof IORedis> | null = null;
let schedulerConn: InstanceType<typeof IORedis> | null = null;

async function quitConn(conn: InstanceType<typeof IORedis> | null): Promise<void> {
  if (!conn) return;
  try {
    await conn.quit();
  } catch {
    try {
      conn.disconnect();
    } catch {}
  }
}

export function getRunsQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (runsQueue) return runsQueue;
  const conn = createRedisConnection();
  if (!conn) return null;
  runsConn = conn;
  runsQueue = new Queue(RUNS_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: RUNS_DEFAULT_JOB_OPTIONS,
  });
  runsQueue.on("error", (err) => console.error("[runs:queue:error]", (err as Error)?.message ?? err));
  return runsQueue;
}

export function getMaintenanceQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (maintenanceQueue) return maintenanceQueue;
  const conn = createRedisConnection();
  if (!conn) return null;
  maintenanceConn = conn;
  maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: MAINTENANCE_DEFAULT_JOB_OPTIONS,
  });
  maintenanceQueue.on("error", (err) => console.error("[maintenance:queue:error]", (err as Error)?.message ?? err));
  return maintenanceQueue;
}

export function getSchedulerQueue(): Queue | null {
  if (getQueueMode() !== "bullmq") return null;
  if (schedulerQueue) return schedulerQueue;
  const conn = createRedisConnection();
  if (!conn) return null;
  schedulerConn = conn;
  schedulerQueue = new Queue(SCHEDULER_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: SCHEDULER_DEFAULT_JOB_OPTIONS,
  });
  schedulerQueue.on("error", (err) => console.error("[scheduler:queue:error]", (err as Error)?.message ?? err));
  return schedulerQueue;
}

export async function enqueueRun(input: EnqueueRunInput): Promise<EnqueueResult | null> {
  if (getQueueMode() !== "bullmq") return null;
  const queue = getRunsQueue();
  if (!queue) return null;
  // ponytail: fail fast — empty keys collapse jobId to "::" and dedup returns the wrong job
  if (!input.channelId || !input.agentId || !input.messageId) {
    throw new Error("[queue] enqueueRun requires channelId, agentId, messageId");
  }
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
    const c = runsConn;
    runsConn = null;
    tasks.push(q.close().catch(() => {}).then(() => quitConn(c)));
  }
  if (maintenanceQueue) {
    const q = maintenanceQueue;
    maintenanceQueue = null;
    const c = maintenanceConn;
    maintenanceConn = null;
    tasks.push(q.close().catch(() => {}).then(() => quitConn(c)));
  }
  if (schedulerQueue) {
    const q = schedulerQueue;
    schedulerQueue = null;
    const c = schedulerConn;
    schedulerConn = null;
    tasks.push(q.close().catch(() => {}).then(() => quitConn(c)));
  }
  await Promise.all(tasks);
}

export function resetQueuesForTests(): void {
  runsQueue = null;
  maintenanceQueue = null;
  schedulerQueue = null;
  runsConn = null;
  maintenanceConn = null;
  schedulerConn = null;
}

export function getJobOptions() {
  // Mirrors exponential backoff base 60s above: 60s, 120s, 240s (delay * 2^n).
  return {
    attempts: 3,
    backoffDelays: [60000, 120000, 240000],
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
    const jobs = await queue.getFailed(0, Math.min(limit, 200) - 1);
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

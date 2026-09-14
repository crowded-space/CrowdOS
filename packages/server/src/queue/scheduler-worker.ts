import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { createRedisConnection, getQueueMode } from "./connection.js";
import { SCHEDULER_QUEUE_NAME } from "./queues.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";

let schedulerWorker: Worker | null = null;
let schedulerConn: InstanceType<typeof IORedis> | null = null;

export interface ScheduledJobData {
  id: string;
  channelId: string;
  task: string;
  message?: string;
  workspaceId?: string;
  targetAgentId?: string;
  cron?: string;
  createdAt: string;
}

async function handleScheduledTrigger(job: Job<ScheduledJobData>): Promise<void> {
  const data = job.data as ScheduledJobData;
  const channelId = data.channelId || "general";
  const content = data.message || `⏰ Scheduled task: ${data.task}`;
  const workspaceId = data.workspaceId || "default";
  // ponytail: jobId as idempotency key — stable across retries (no fresh ULID/Date.now per attempt)
  const messageId = (job.id as string | undefined) || data.id;

  // Persist + emit a real system message into the channel (honest firing).
  // We reuse the same transactional sequence pattern as the socket layer (DB-2)
  // but fall back to an ephemeral emit when DB is unavailable (test fakes,
  // offline dev). Either path emits via EventBroker so sockets/replays see it.
  // Prefer the live socket broker if available (shared holder; no static cycle
  // with registerSocketServer). Fresh fallback is local-only (documented).
  let broker: InstanceType<typeof EventBroker>;
  try {
    const { getSharedBroker } = (await import("../event-broker/event-broker-gate.js")) as unknown as { getSharedBroker?: () => InstanceType<typeof EventBroker> | null };
    broker = getSharedBroker?.() ?? new EventBroker();
  } catch {
    broker = new EventBroker();
  }

  // Try to persist message via the Messages owner gate (sequence + insert + emit).
  try {
    const { messageGate } = await import("../messages/message-gate.js");
    await messageGate.append(
      {
        id: typeof messageId === "string" ? messageId : undefined,
        channelId,
        authorId: "system-scheduler",
        authorName: "Scheduler",
        authorLevel: "system",
        authorType: "system",
        content,
        workspaceId,
      },
      { broker: broker as never }
    );
  } catch {
    // Ephemeral fallback when DB not reachable (e.g., in-memory test fake without messages table)
    const ephemeral = {
      id: messageId || `sched-${channelId}-${data.task}-${data.createdAt}`,
      channelId,
      authorId: "system-scheduler",
      authorName: "Scheduler",
      authorLevel: "system",
      authorType: "system",
      content,
      mentions: [],
      isInternalMonologue: false,
      sequenceNumber: 0,
      timestamp: new Date(),
    };
    try {
      (broker as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("message:new", ephemeral as unknown as never, { channelId });
    } catch {}
  }

  // Also emit a dedicated scheduled event for observability/consumers (additive)
  try {
    (broker as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("scheduled:triggered" as string, {
      id: data.id,
      channelId,
      task: data.task,
      cron: data.cron ?? null,
      triggeredAt: new Date().toISOString(),
    } as unknown as never, { channelId });
  } catch {}

  // Optional: if a target agent was requested, we could enqueue a run here.
  // Keeping the scheduler honest but minimal: the message itself will trigger
  // normal mention dispatch on the next user:message cycle if the scheduler
  // seeded an @mention into the content (e.g., "@agent do X"). For explicit
  // targetAgentId we could enqueue a run directly; left as additive hook.
}

async function schedulerProcessor(job: Job<ScheduledJobData>): Promise<unknown> {
  // BullMQ repeatables arrive with name "scheduled:trigger" or "scheduled:cron"
  // and occasionally as "scheduled:trigger:xyz" — route all to the same handler.
  if (job.name.startsWith("scheduled")) {
    return handleScheduledTrigger(job);
  }
  // Fallback for repeatable data.kind shape (parity with maintenanceWorker)
  const kind = (job.data as unknown as { kind?: string })?.kind;
  if (kind === "scheduled:trigger" || kind === "scheduled:cron" || (job.data as ScheduledJobData)?.task) {
    return handleScheduledTrigger(job as Job<ScheduledJobData>);
  }
  return handleScheduledTrigger(job as Job<ScheduledJobData>);
}

export function getSchedulerWorker(): Worker | null {
  return schedulerWorker;
}

export async function startSchedulerWorker(): Promise<Worker | null> {
  if (getQueueMode() !== "bullmq") return null;
  if (schedulerWorker) return schedulerWorker;
  const conn = createRedisConnection() as InstanceType<typeof IORedis> | null;
  if (!conn) return null;
  schedulerConn = conn;
  schedulerWorker = new Worker<ScheduledJobData>(SCHEDULER_QUEUE_NAME, schedulerProcessor, {
    connection: conn as unknown as IORedis,
    concurrency: 4,
    // M2: stall tuning explicit (BullMQ v6 defaults). lockDuration 15min kept:
    // scheduler jobs are short but share Redis with run jobs; a shorter lock
    // adds false-stall churn for no gain. Crashes surface via 'stalled' below.
    lockDuration: 900000,
    stalledInterval: 30000,
    maxStalledCount: 1,
  });
  // M2: Worker is the stall checker — observe its queue events with jobId.
  schedulerWorker.on("error", (err) => console.error("[scheduler:worker:error]", (err as Error)?.message ?? err));
  schedulerWorker.on("completed", (job) => console.log(`[scheduler:completed] jobId=${job.id}`));
  schedulerWorker.on("failed", (job, err) => console.warn(`[scheduler:failed] jobId=${job?.id} ${(err as Error)?.message ?? err}`));
  schedulerWorker.on("stalled", (jobId) => console.warn(`[scheduler:stalled] jobId=${jobId}`));
  return schedulerWorker;
}

export async function stopSchedulerWorker(): Promise<void> {
  if (schedulerWorker) {
    const w = schedulerWorker;
    schedulerWorker = null;
    try {
      await w.close();
    } catch {}
  }
  if (schedulerConn) {
    const c = schedulerConn;
    schedulerConn = null;
    try {
      await c.quit();
    } catch {
      try {
        c.disconnect();
      } catch {}
    }
  }
}

export function resetSchedulerWorkerForTests(): void {
  schedulerWorker = null;
  schedulerConn = null;
}

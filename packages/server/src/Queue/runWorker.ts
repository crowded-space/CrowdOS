import { Worker, type Job } from "bullmq";
import { createRedisConnection, getQueueMode, getRedisUrl } from "./connection.js";
import { RUNS_QUEUE_NAME, type EnqueueRunInput } from "./queues.js";
import IORedis from "ioredis";

let runWorker: Worker | null = null;

export interface RunJobData extends EnqueueRunInput {}

async function processRunJob(job: Job<RunJobData>): Promise<unknown> {
  const { channelId, agentId, messageId, userInput, workspaceId, runId } = job.data;
  // Workspace-owned execution: the job must carry an explicit workspace —
  // never silently fall back to "default".
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    throw new Error(`[runWorker] Job ${job.id ?? runId ?? "?"} missing workspaceId; refusing to execute without tenant scope.`);
  }
  const resumeContext = (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeContext ?? (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeFrom ?? null;

  const [{ runtimeGate }, { agentGate }, { EventBroker }] = await Promise.all([
    import("../runtime/runtimeGate.js"),
    import("../Agents/agentGate.js"),
    import("../EventBroker/eventBrokerGate.js"),
  ]);
  const broker = new EventBroker();

  let agent: unknown = null;
  try {
    if (typeof (agentGate as unknown as Record<string, unknown>).getById === "function") {
      agent = await (agentGate as unknown as { getById: (id: string) => Promise<unknown> }).getById(agentId);
    }
  } catch {}
  if (!agent) {
    try {
      const list = await (agentGate as unknown as { list: () => Promise<unknown[]> }).list();
      agent = (list as Array<{ id: string }>).find((a) => a.id === agentId) ?? null;
    } catch {}
  }
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const result = await (runtimeGate as unknown as { execute: (req: unknown) => Promise<unknown> }).execute({
    agent,
    channelId,
    workspaceId,
    userInput,
    broker,
    explicitRuntime: undefined,
    librarianAgentId: "agent-librarian",
    runId: (runId as string | undefined) ?? null,
    resumeContext: resumeContext as unknown as null,
  });

  return result;
}

export function getRunWorker(): Worker | null {
  return runWorker;
}

export async function startRunWorker(): Promise<Worker | null> {
  if (getQueueMode() !== "bullmq") return null;
  if (runWorker) return runWorker;

  const conn = createRedisConnection() as InstanceType<typeof IORedis> | null;
  if (!conn) return null;

  runWorker = new Worker<RunJobData>(RUNS_QUEUE_NAME, processRunJob, {
    connection: conn as unknown as IORedis,
    concurrency: 4,
    lockDuration: 900000,
  });
  runWorker.on("error", () => {});
  const bullMqFailed = "failed";
  (runWorker as unknown as { on: (e: string, h: () => void) => void }).on(bullMqFailed, () => {});
  return runWorker;
}

export async function stopRunWorker(): Promise<void> {
  if (runWorker) {
    const w = runWorker;
    runWorker = null;
    try {
      await w.close();
    } catch {}
  }
}

export function resetRunWorkerForTests(): void {
  runWorker = null;
}

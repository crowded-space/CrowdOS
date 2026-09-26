import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { createRedisConnection, getQueueMode } from "./connection.js";
import { RUNS_QUEUE_NAME, type EnqueueRunInput } from "./queues.js";

let runWorker: Worker | null = null;
let runConn: InstanceType<typeof IORedis> | null = null;

export interface RunJobData extends EnqueueRunInput {}

// Job data is untrusted input — only known runtime types pass through.
// Anything else degrades to Auto (undefined), never a throw.
const KNOWN_RUNTIMES = new Set(["conversational", "agentic", "swarm", "coding", "research"]);

async function processRunJob(job: Job<RunJobData>): Promise<unknown> {
  const { channelId, agentId, messageId, userInput, workspaceId, runId } = job.data;
  const rawRuntime = (job.data as { explicitRuntime?: unknown }).explicitRuntime;
  const explicitRuntime = typeof rawRuntime === "string" && KNOWN_RUNTIMES.has(rawRuntime) ? rawRuntime : undefined;
  // §6 pin: same validation as explicitRuntime — untrusted job data, so an
  // unknown value degrades to Auto rather than reaching the Router.
  const rawPreferred = (job.data as { preferredRuntime?: unknown }).preferredRuntime;
  const preferredRuntime = typeof rawPreferred === "string" && KNOWN_RUNTIMES.has(rawPreferred) ? rawPreferred : undefined;
  const resumeContext = (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeContext ?? (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeFrom ?? null;

  const [{ runtimeGate }, { agentGate }, { getSharedBroker }] = await Promise.all([
    import("../runtime/runtime-gate.js"),
    import("../agents/agent-gate.js"),
    import("../event-broker/event-broker-gate.js"),
  ]);
  // ponytail: single shared instance (worker boot sets worker-local); no orphan fallback.
  const broker = (getSharedBroker as () => { onAny: (cb: (event: any) => void) => string; off: (id: string) => void } | null)?.();
  if (!broker) throw new Error("EventBroker not initialized (no shared broker registered).");

  // M5: processRunJob awaits the full multi-iteration runtime inline with no
  // useWorkerThreads — CPU-hot stretches starve BullMQ lock renewal for all 4
  // slots. Per-iteration updateProgress heartbeats keep busy jobs from looking
  // stalled. Real fix = useWorkerThreads/child-process pool (bigger redesign,
  // deliberately not done here).
  let iteration = 0;
  // ponytail: runId-keyed filter; runId-less emitters (coding bridge) count as before — no regression
  const wantRunId = (runId as string | undefined) ?? null;
  const hbListenerId = broker.onAny((event) => {
    try {
      if ((event as unknown as { type?: string }).type !== "tool:complete") return;
      const er = (event as unknown as { runId?: string | null }).runId;
      if (er !== undefined && er !== wantRunId) return;
      iteration += 1;
      void Promise.resolve(
        job.updateProgress({ iteration, runId: (runId as string | undefined) ?? null }),
      ).catch(() => {});
    } catch {}
  });
  try {
    void Promise.resolve(job.updateProgress({ iteration: 0, phase: "started" })).catch(() => {});
  } catch {}

  // P28: periodic heartbeat for long quiet stretches (no tool:complete events,
  // e.g. long LLM waits / approval blocks) — keeps the job from looking
  // stalled. updateProgress + extendLock are best-effort; worker lock renewal
  // also runs, but can starve during CPU-hot stretches.
  const heartbeat = setInterval(() => {
    try {
      void Promise.resolve(
        job.updateProgress({ iteration, phase: "running", runId: (runId as string | undefined) ?? null }),
      ).catch(() => {});
      const token = (job as unknown as { token?: string }).token;
      if (token) {
        void Promise.resolve(job.extendLock(token, 900000)).catch(() => {});
      }
    } catch {}
  }, 30000);
  try {
    (heartbeat as unknown as { unref?: () => void }).unref?.();
  } catch {}

  try {
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
      workspaceId: workspaceId ?? "default",
      userInput,
      broker,
      explicitRuntime,
      preferredRuntime,
      librarianAgentId: "agent-librarian",
      runId: (runId as string | undefined) ?? null,
      resumeContext: resumeContext as unknown as null,
    });

    return result;
  } finally {
    try {
      clearInterval(heartbeat);
    } catch {}
    try {
      broker.off(hbListenerId);
    } catch {}
  }
}

export function getRunWorker(): Worker | null {
  return runWorker;
}

// Run jobs can block up to 5min on approval waits while holding a slot, and the
// PG pool (DB_POOL_MAX, default 20) is shared with the API + sibling workers.
// Cap run slots so run + scheduler(4) + maintenance(2) stay within the pool.
function resolveRunWorkerConcurrency(): number {
  const raw = Number(process.env.DB_POOL_MAX);
  const poolMax = Number.isInteger(raw) && raw > 0 ? raw : 20;
  return Math.max(1, Math.min(4, poolMax - 6));
}

export async function startRunWorker(): Promise<Worker | null> {
  if (getQueueMode() !== "bullmq") return null;
  if (runWorker) return runWorker;

  const conn = createRedisConnection() as InstanceType<typeof IORedis> | null;
  if (!conn) return null;
  runConn = conn;

  runWorker = new Worker<RunJobData>(RUNS_QUEUE_NAME, processRunJob, {
    connection: conn as unknown as IORedis,
    concurrency: resolveRunWorkerConcurrency(),
    // M2: stall tuning explicit (BullMQ v6 defaults). lockDuration 15min kept:
    // run jobs can block up to 5min on approval waits; a shorter lock would
    // false-stall busy jobs. stalledInterval/maxStalledCount pinned so crashes
    // surface via 'stalled' below instead of hiding behind implicit defaults.
    lockDuration: 900000,
    stalledInterval: 30000,
    maxStalledCount: 1,
  });
  // M2: Worker is the stall checker — observe its queue events with jobId.
  // (Skipped separate QueueEvents class: same signals, no extra Redis conn.)
  runWorker.on("error", (err) => console.error("[runs:worker:error]", (err as Error)?.message ?? err));
  runWorker.on("completed", (job) => console.log(`[runs:completed] jobId=${job.id}`));
  runWorker.on("failed", (job, err) => console.warn(`[runs:failed] jobId=${job?.id} ${(err as Error)?.message ?? err}`));
  runWorker.on("stalled", (jobId) => console.warn(`[runs:stalled] jobId=${jobId}`));
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
  if (runConn) {
    const c = runConn;
    runConn = null;
    try {
      await c.quit();
    } catch {
      try {
        c.disconnect();
      } catch {}
    }
  }
}

export function resetRunWorkerForTests(): void {
  runWorker = null;
  runConn = null;
}

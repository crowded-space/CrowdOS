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

/**
 * RUN-026/RUN-030/RUN-031: run-state guard for non-resume jobs (no
 * resumeContext). A queue job may only start an execution for a row that is
 * still on its first (or retrying) delivery:
 *
 *  - terminal / resumable / mid-close rows refuse (RUN-026: a stale BullMQ
 *    retry or backlog pickup must not execute with no valid state anchor);
 *  - `queued` is resume-exclusive (only reachable via `resumable -> queued`),
 *    so a non-resume job seeing `queued` is the stale pre-sweep backlog job
 *    of a run the operator already resumed — refuse or it duplicates the
 *    resume execution (RUN-030);
 *  - `starting`/`running` with zero attempts made means ANOTHER execution is
 *    already in flight (only an executor walks a row out of `created`); a
 *    first-pickup job must refuse or it duplicates a live/resumed execution.
 *    A retried job (attemptsMade >= 1) adopts its own crashed row — the H4
 *    retry-reuse path stays intact. Stall redelivery of a hard-killed
 *    first attempt lands here too (attemptsMade stays 0): it is refused and
 *    the row recovers through the sweep (`running -> orphaned -> resumable`)
 *    plus an explicit resume, which is the documented recovery path.
 *  - rows with parentRunId are research child-trace rows (audit-only): never
 *    executable from the queue (RUN-031).
 */
// Exported for the RUN-026/030/031 unit test (same-folder test file).
export function refuseNonResumeJob(
  row: { status: string; parentRunId: string | null },
  attemptsMade: number,
): { reason: string } | null {
  if (row.parentRunId) return { reason: "child_trace_row" };
  if (row.status === "queued") return { reason: "resume_exclusive_status" };
  if ((row.status === "starting" || row.status === "running") && attemptsMade === 0) return { reason: "execution_in_flight" };
  if (!["created", "starting", "running"].includes(row.status)) return { reason: "stale_run_status" };
  return null;
}

// Exported for the TG-4 scope test (same-folder): the wrap assertion calls the
// processor directly with a fake Job instead of booting Redis.
export async function processRunJob(job: Job<RunJobData>): Promise<unknown> {
  const { channelId, agentId, messageId, userInput, workspaceId, runId } = job.data;
  const rawRuntime = (job.data as { explicitRuntime?: unknown }).explicitRuntime;
  const explicitRuntime = typeof rawRuntime === "string" && KNOWN_RUNTIMES.has(rawRuntime) ? rawRuntime : undefined;
  // §6 pin: same validation as explicitRuntime — untrusted job data, so an
  // unknown value degrades to Auto rather than reaching the Router.
  const rawPreferred = (job.data as { preferredRuntime?: unknown }).preferredRuntime;
  const preferredRuntime = typeof rawPreferred === "string" && KNOWN_RUNTIMES.has(rawPreferred) ? rawPreferred : undefined;
  const resumeContext = (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeContext ?? (job.data as unknown as { resumeContext?: unknown; resumeFrom?: unknown }).resumeFrom ?? null;
  // Operator context: untrusted job data — same clamps as the socket path.
  // Invalid/empty degrades to null (inject nothing), never a failure.
  const rawOp = (job.data as { operatorContext?: unknown }).operatorContext;
  let operatorContext: { name: string; tag: string; preference: string } | null = null;
  if (rawOp && typeof rawOp === "object") {
    const rec = rawOp as Record<string, unknown>;
    const pref = typeof rec.preference === "string" ? rec.preference.trim().slice(0, 2000) : "";
    if (pref) {
      operatorContext = {
        name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim().slice(0, 80) : "operator",
        tag: typeof rec.tag === "string" && rec.tag.trim() ? rec.tag.trim().slice(0, 24) : "Human",
        preference: pref,
      };
    }
  }

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
    // SH-002 (XD-016 worker leg) + RUN-026/RUN-030/RUN-031: resolve the
    // effective workspace first; the state guard and the scoped executor both
    // need it.
    const effectiveWorkspaceId = workspaceId ?? "default";

    // RUN-026/RUN-030/RUN-031: job/run correlation guard (see
    // refuseNonResumeJob). Refuse BEFORE resolving the agent or executing:
    // resume jobs pass through (the executor owns the resume walk and refuses
    // stale states itself, B-02); a missing row (null) also passes —
    // runs-disabled / record-less deployments execute run-less by design.
    if (runId && !resumeContext) {
      try {
        const { runsGate } = await import("../runs/runs-gate.js");
        const row = await runsGate.getById(runId as string, effectiveWorkspaceId);
        if (row) {
          const refusal = refuseNonResumeJob(
            { status: row.status, parentRunId: (row.parentRunId as string | null) ?? null },
            (job as unknown as { attemptsMade?: number }).attemptsMade ?? 0,
          );
          if (refusal) {
            console.warn(`[runs:worker] skipped run ${runId}: ${refusal.reason} (status ${row.status})`);
            return { skipped: true, reason: refusal.reason, status: row.status, runId };
          }
        }
      } catch (err) {
        // Fail-open: a guard-read failure must not block delivery; the
        // executor re-fetches the row and enforces its own refusal.
        console.warn(`[runs:worker] run-state guard read failed for ${runId}:`, (err as Error)?.message || err);
      }
    }

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

    // SH-002 (XD-016 worker leg): bullmq runs must execute inside the
    // workspace's ALS handle, or bare getDb() writes inside the runtime
    // (artifacts, run transitions) resolve the ambient pool — lost or
    // cross-tenant rows in split-DB deployments. Same fallback semantics as
    // executeRunScoped (register-socket-server.ts:327-341): a local-only or
    // unknown workspace degrades to the unscoped path. Only the resolver is
    // caught — a failing run must reject once so BullMQ retries stay intact.
    const execute = (runtimeGate as unknown as { execute: (req: unknown) => Promise<unknown> }).execute;
    const runRequest = {
      agent,
      channelId,
      workspaceId: effectiveWorkspaceId,
      userInput,
      broker,
      explicitRuntime,
      preferredRuntime,
      librarianAgentId: "agent-librarian",
      runId: (runId as string | undefined) ?? null,
      resumeContext: resumeContext as unknown as null,
      operatorContext,
    };
    let scopedExecute: ((req: unknown) => Promise<unknown>) | null = null;
    try {
      const { runWithDb, dbForWorkspace } = await import("../shared/config/database.js");
      const db = await dbForWorkspace(effectiveWorkspaceId).catch(() => null);
      if (db) scopedExecute = (req) => runWithDb(db, () => execute(req));
    } catch {}
    const result = await (scopedExecute ?? execute)(runRequest);

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

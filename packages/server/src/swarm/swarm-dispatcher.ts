import { randomUUID } from "node:crypto";
import type { ContextPacket } from "../runtime/types.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";
import { updateSwarmTaskStatus } from "./swarm-repository.js";
import type { SwarmPlan, SwarmPlanTask, SwarmWorkerResult } from "./swarm-types.js";
import { delegate as delegateDelegation, completeDelegation as completeDelegationGate, DelegationRejectedError } from "./delegation-service.js";

export type WorkerExecutor = (
  task: SwarmPlanTask,
  ctx: { packet: ContextPacket; broker: EventBroker; runId: string }
) => Promise<string>;

/**
 * Default fan-out width. Every worker is a full LLM call plus tool loop, so an
 * unbounded batch is an unbounded provider bill and an unbounded number of
 * concurrent tool subprocesses. Override with SWARM_MAX_CONCURRENCY.
 */
export const DEFAULT_SWARM_CONCURRENCY = 4;

export function resolveSwarmConcurrency(): number {
  const raw = process.env.SWARM_MAX_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_SWARM_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SWARM_CONCURRENCY;
  return Math.floor(n);
}

/** Per-task wall-clock ceiling. A hung worker must not stall the whole DAG. */
export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveTaskTimeoutMs(): number {
  const raw = process.env.SWARM_TASK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 * A rejected item resolves to { ok: false } instead of rejecting the batch, so
 * one dead worker can never cancel its siblings.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Race a worker against a wall-clock ceiling.
 *
 * The abandoned promise is NOT cancelled — it has no signal of its own, and
 * faking cancellation would be a lie. It is left to settle into nothing while
 * its task is reported as failed. The timer is unref'd so a fast worker does
 * not keep the process alive.
 */
async function withTimeout<R>(work: () => Promise<R>, ms: number, label: string): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DispatchInput {
  plan: SwarmPlan;
  runId: string;
  packet: ContextPacket;
  broker: EventBroker;
  workerExecutor?: WorkerExecutor;
  abortSignal?: AbortSignal;
  /** Max workers in flight (default SWARM_MAX_CONCURRENCY ?? 4). */
  maxConcurrency?: number;
  /** Per-task ceiling in ms (default SWARM_TASK_TIMEOUT_MS ?? 5min). */
  taskTimeoutMs?: number;
}

function validateDag(tasks: SwarmPlanTask[]): string | null {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) return `task ${t.id} dependsOn unknown ${dep}`;
      if (dep === t.id) return `task ${t.id} self-depends`;
    }
  }
  // cycle check
  const adj = new Map<string, string[]>(tasks.map((t) => [t.id, t.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of adj.get(id) ?? []) if (dfs(dep)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const t of tasks) if (dfs(t.id)) return `cycle detected including ${t.id}`;
  return null;
}

async function defaultWorkerExecutor(
  task: SwarmPlanTask,
  ctx: { packet: ContextPacket; broker: EventBroker; runId: string }
): Promise<string> {
  // Default honest inline worker when no executor injected.
  // SwarmRuntime injects a real LLM-backed executor via swarmGate.dispatch(..., workerExecutor);
  // This fallback is honest (not mocked) and used only for isolated dispatcher unit tests.
  throw new Error(`No worker executor provided for swarm task ${task.id} — inject executor via SwarmRuntime or test harness (honest fallback, not mocked)`);
}

export async function dispatchSwarmTasks(input: DispatchInput): Promise<Map<string, SwarmWorkerResult>> {
  const { plan, runId, packet, broker, abortSignal } = input;
  const workerExecutor = input.workerExecutor ?? defaultWorkerExecutor;
  const maxConcurrency = input.maxConcurrency ?? resolveSwarmConcurrency();
  const taskTimeoutMs = input.taskTimeoutMs ?? resolveTaskTimeoutMs();

  const dagError = validateDag(plan.tasks);
  if (dagError) {
    throw new Error(`[swarmDispatcher] invalid DAG: ${dagError}`);
  }

  const status = new Map<string, "pending" | "running" | "completed" | "failed" | "blocked">();
  for (const t of plan.tasks) status.set(t.id, "pending");
  const results = new Map<string, SwarmWorkerResult>();

  const isAborted = () => abortSignal?.aborted === true || packet.abortSignal?.aborted === true;

  // lease reuse: keep agent working during dispatch
  try {
    const { markAgentWorking, markAgentIdle } = await import("../shared/core/agent-heartbeat.js");
    markAgentWorking(packet.agentId);
    // Ensure idle on exit
    const finalize = () => markAgentIdle(packet.agentId);
    // Attach one-time
    (global as unknown as { __swarmLeaseCleanup?: () => void }).__swarmLeaseCleanup = finalize;
  } catch {}

  let iterationGuard = 0;
  while (true) {
    if (isAborted()) break;
    if (iterationGuard++ > 100) break; // safety
    const pending = plan.tasks.filter((t) => status.get(t.id) === "pending");
    if (pending.length === 0) break;

    const completedIds = new Set(
      [...status.entries()].filter(([, s]) => s === "completed").map(([id]) => id)
    );
    const failedIds = new Set(
      [...status.entries()].filter(([, s]) => s === "failed" || s === "blocked").map(([id]) => id)
    );

    // Mark blocked where dependencies failed
    const newlyBlocked: SwarmPlanTask[] = [];
    for (const t of pending) {
      const hasFailedDep = t.dependsOn.some((dep) => failedIds.has(dep));
      if (hasFailedDep) newlyBlocked.push(t);
    }
    for (const t of newlyBlocked) {
      status.set(t.id, "blocked");
      const reason = `blocked: dependency failed (${t.dependsOn.filter((d) => failedIds.has(d)).join(",")})`;
      results.set(t.id, { taskId: t.id, status: "failed", error: reason });
      await updateSwarmTaskStatus(t.id, "failed", reason).catch(() => {});
    }
    if (newlyBlocked.length > 0) continue;

    const executable = pending.filter(
      (t) => t.dependsOn.every((dep) => completedIds.has(dep))
    );
    if (executable.length === 0) {
      // No executable but still pending → remaining are blocked due to unavailable deps (should have been caught)
      // Mark them blocked to avoid infinite loop
      for (const t of pending) {
        if (status.get(t.id) !== "pending") continue;
        status.set(t.id, "blocked");
        const reason = `blocked: unsatisfied dependencies ${t.dependsOn.join(",")}`;
        results.set(t.id, { taskId: t.id, status: "failed", error: reason });
        await updateSwarmTaskStatus(t.id, "failed", reason).catch(() => {});
      }
      break;
    }

    // Fan-out: run executable batch concurrently; linear chain naturally has batch size 1.
    const batch = executable;

    // Mark running before dispatch (lease tracking via status)
    for (const t of batch) {
      status.set(t.id, "running");
      await updateSwarmTaskStatus(t.id, "running").catch(() => {});
    }

    // Bounded fan-out (P2): every worker is a full LLM call plus tool loop.
    // Promise.allSettled over the whole batch made concurrency a function of
    // plan size — 40 tasks meant 40 simultaneous provider calls and 40
    // concurrent tool subprocesses. mapWithConcurrency caps in-flight work
    // while keeping per-task isolation (one failure never cancels siblings).
    const batchResults = await mapWithConcurrency(batch, maxConcurrency, async (task) => {
        if (isAborted()) throw new Error(`aborted before worker ${task.id} start`);
        const start = Date.now();
        // SW-2 central dispatcher: enforce depth≤2 + visited-set cycle before enqueue
        let childRunId: string | null = null;
        let delegated = false;
        if (runId) {
          childRunId = `${runId}::${task.id}::${randomUUID().slice(0, 8)}`;
          try {
            await delegateDelegation({
              parentRunId: runId,
              childRunId,
              taskId: task.id,
              broker,
              workspaceId: packet.workspaceId,
              producerAgent: packet.agentId,
            });
            delegated = true;
          } catch (err) {
            if (err instanceof DelegationRejectedError) {
              const durationMs = Date.now() - start;
              throw { task, error: (err as Error).message, durationMs } as unknown as Error;
            }
            console.warn(`[swarmDispatcher] delegation pre-check failed for ${task.id}, proceeding without guard:`, (err as Error)?.message || err);
            childRunId = null;
            delegated = false;
          }
        }
        try {
          // Per-task ceiling: a hung worker fails its OWN task honestly instead
          // of holding the batch (and the run) open forever.
          const output = await withTimeout(
            () => workerExecutor(task, { packet, broker, runId }),
            taskTimeoutMs,
            `swarm worker ${task.id} timed out`,
          );
          const durationMs = Date.now() - start;
          // SW-2: summarize child result (≤500 tokens + artifact pointer)
          if (delegated && childRunId) {
            try {
              const { summary } = await completeDelegationGate({
                parentRunId: runId,
                childRunId,
                fullOutput: output,
                broker,
                workspaceId: packet.workspaceId,
                producerAgent: packet.agentId,
              });
              return { task, output: summary, durationMs } as const;
            } catch (e) {
              console.warn(`[swarmDispatcher] completeDelegation failed for ${task.id}:`, (e as Error)?.message || e);
            }
          }
          return { task, output, durationMs } as const;
        } catch (err) {
          const durationMs = Date.now() - start;
          throw { task, error: err instanceof Error ? err.message : String(err), durationMs } as unknown as Error;
        }
      });

    for (let i = 0; i < batch.length; i++) {
      const task = batch[i];
      const settled = batchResults[i];
      if (settled.ok) {
        const { output, durationMs } = settled.value as { task: SwarmPlanTask; output: string; durationMs: number };
        const outStr = typeof output === "string" ? output : String(output ?? "");
        status.set(task.id, "completed");
        results.set(task.id, { taskId: task.id, status: "completed", output: outStr, durationMs });
        await updateSwarmTaskStatus(task.id, "completed", outStr.slice(0, 20000)).catch(() => {});
        // reuse run heartbeat leases: touch checkpoint watermark
        try {
          if (runId) {
            const { runsGate } = await import("../runs/runs-gate.js");
            // touch checkpoint with watermark = completed count proxy (not seq) — honest heartbeat reuse
            await runsGate.touchCheckpoint(runId, { watermarkSeq: results.size }).catch(() => {});
          }
        } catch {}
      } else {
        const reason = settled.error as unknown as { task?: SwarmPlanTask; error?: string; durationMs?: number };
        const errMsg = typeof reason === "object" && reason && "error" in reason
          ? String((reason as { error: string }).error)
          : reason instanceof Error ? reason.message : String(reason);
        status.set(task.id, "failed");
        const durationMs = typeof reason === "object" && reason && "durationMs" in reason
          ? Number((reason as { durationMs: number }).durationMs)
          : undefined;
        results.set(task.id, { taskId: task.id, status: "failed", error: errMsg, durationMs });
        await updateSwarmTaskStatus(task.id, "failed", errMsg.slice(0, 5000)).catch(() => {});
      }
      if (isAborted()) break;
    }
  }

  try {
    const { markAgentIdle } = await import("../shared/core/agent-heartbeat.js");
    markAgentIdle(packet.agentId);
  } catch {}

  return results;
}

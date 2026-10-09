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

export const MAX_SWARM_CONCURRENCY = 32;

export function resolveSwarmConcurrency(): number {
  const raw = process.env.SWARM_MAX_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_SWARM_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SWARM_CONCURRENCY;
  return Math.min(MAX_SWARM_CONCURRENCY, Math.floor(n));
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
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) return `duplicate task id ${t.id}`;
    seen.add(t.id);
  }
  const ids = seen;
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

/**
 * Plans come from an LLM and are not trusted: an unbounded fan-out is an
 * unbounded provider bill. 50 is far past any real DAG and turns a runaway
 * plan into a loud failure instead of 500 simultaneous tool loops.
 */
export const MAX_SWARM_TASKS = 50;

export async function dispatchSwarmTasks(input: DispatchInput): Promise<Map<string, SwarmWorkerResult>> {
  const { plan, runId, packet, broker, abortSignal } = input;
  const workerExecutor = input.workerExecutor ?? defaultWorkerExecutor;
  const maxConcurrency = input.maxConcurrency ?? resolveSwarmConcurrency();
  const taskTimeoutMs = input.taskTimeoutMs ?? resolveTaskTimeoutMs();

  if (plan.tasks.length > MAX_SWARM_TASKS) {
    throw new Error(`[swarmDispatcher] plan has ${plan.tasks.length} tasks (max ${MAX_SWARM_TASKS})`);
  }

  const dagError = validateDag(plan.tasks);
  if (dagError) {
    throw new Error(`[swarmDispatcher] invalid DAG: ${dagError}`);
  }

  const status = new Map<string, "pending" | "running" | "completed" | "failed" | "blocked">();
  for (const t of plan.tasks) status.set(t.id, "pending");
  const results = new Map<string, SwarmWorkerResult>();

  const isAborted = () => abortSignal?.aborted === true || packet.abortSignal?.aborted === true;

  const persistStatus = async (taskId: string, next: "running" | "completed" | "failed" | "blocked", outputRef?: string) => {
    await updateSwarmTaskStatus(runId, taskId, next, outputRef).catch((e) => console.warn(`[swarmDispatcher] persist ${next} failed for ${taskId}:`, (e as Error)?.message || e));
  };

  // lease reuse: keep agent working during dispatch
  type SwarmLease = { agentId: string; cleanup: () => void };
  const g = global as unknown as { __swarmLeaseCleanup?: SwarmLease };
  let finalizeLease: (() => void) | null = null;
  try {
    const { markAgentWorking, markAgentIdle } = await import("../shared/core/agent-heartbeat.js");
    markAgentWorking(packet.agentId);
    const lease: SwarmLease = {
      agentId: packet.agentId,
      cleanup: () => {
        // Only the current owner drops the lease: an earlier dispatch finishing
        // late must not idle an agent a newer dispatch is still using.
        if (g.__swarmLeaseCleanup !== lease) return;
        g.__swarmLeaseCleanup = undefined;
        markAgentIdle(packet.agentId);
      },
    };
    // A leftover cleanup for a DIFFERENT agent releases that agent (no orphan
    // lease). For the SAME agent it would delete the lease just registered and
    // hand a live agent to the orphan sweeper, so it is skipped.
    const prev = g.__swarmLeaseCleanup;
    if (prev && prev.agentId !== packet.agentId) {
      try { prev.cleanup(); } catch (e) { console.warn("[swarmDispatcher] previous lease cleanup failed:", (e as Error)?.message || e); }
    }
    g.__swarmLeaseCleanup = lease;
    finalizeLease = lease.cleanup;
  } catch (e) { console.warn("[swarmDispatcher] lease markAgentWorking failed:", (e as Error)?.message || e); }

  // Dispatch body runs in a closure so the lease is released in a finally —
  // including the iteration-guard throw, which previously leaked the lease.
  const runDispatch = async (): Promise<Map<string, SwarmWorkerResult>> => {
  let iterationGuard = 0;
  while (true) {
    if (isAborted()) break;
    if (iterationGuard++ > 100) {
      for (const t of plan.tasks.filter((t) => status.get(t.id) === "pending")) {
        status.set(t.id, "failed");
        const reason = "swarm dispatcher iteration guard exceeded (possible scheduler stall)";
        results.set(t.id, { taskId: t.id, status: "failed", error: reason });
        await persistStatus(t.id, "failed", reason);
      }
      throw new Error("[swarmDispatcher] iteration guard exceeded (>100 rounds) — remaining tasks marked failed");
    }
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
      // SW-05: map agrees with the persisted row status.
      results.set(t.id, { taskId: t.id, status: "blocked", error: reason });
      // Persist as "blocked" (not "failed"): the row's own status is what a
      // reader sees after the run, and "blocked" is in the swarm_task_status enum.
      await persistStatus(t.id, "blocked", reason);
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
        results.set(t.id, { taskId: t.id, status: "blocked", error: reason });
        await persistStatus(t.id, "blocked", reason);
      }
      break;
    }

    // Fan-out: run executable batch concurrently; linear chain naturally has batch size 1.
    const batch = executable;

    // Mark running before dispatch (lease tracking via status)
    for (const t of batch) {
      status.set(t.id, "running");
      await persistStatus(t.id, "running");
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
          // delegations.child_run_id is uuid-typed (FK to runs.id), so the child
          // id must be a real uuid — a composite `${runId}::${taskId}::...` was
          // rejected by the column. Task linkage stays on delegations.task_id.
          childRunId = randomUUID();
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
        await persistStatus(task.id, "completed", outStr.slice(0, 20000));
        // NOTE: no runs checkpoint watermark here — watermarkSeq is the tool-call
        // resume cursor owned by agentic-runtime; writing results.size corrupts it.
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
        await persistStatus(task.id, "failed", errMsg.slice(0, 5000));
      }
      // NOTE: no abort break here — every settled result is persisted, otherwise
      // an abort mid-batch discarded completed work and left rows stuck in
      // "running". The loop top stops the next round instead.
    }
  }

  if (isAborted()) {
    // Abort leaves tasks pending (never dispatched) or running (abandoned):
    // settle them so no row sits in a non-terminal state and aggregation sees
    // the truth.
    for (const t of plan.tasks) {
      const s = status.get(t.id);
      if (s !== "pending" && s !== "running") continue;
      const reason = s === "running" ? "aborted before completion" : "aborted before dispatch";
      status.set(t.id, "failed");
      results.set(t.id, { taskId: t.id, status: "failed", error: reason });
      await persistStatus(t.id, "failed", reason);
    }
  }

  return results;
  };

  try {
    return await runDispatch();
  } finally {
    if (finalizeLease) finalizeLease();
  }
}

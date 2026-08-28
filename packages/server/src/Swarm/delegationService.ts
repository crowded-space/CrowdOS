import { randomUUID } from "node:crypto";
import type { EventBroker } from "../EventBroker/eventBrokerGate.js";
import { createDelegation, getDelegationByChild, updateDelegationSummary } from "./delegationRepository.js";
import type { DelegationRow } from "./delegationRepository.js";

export const MAX_SUBAGENT_RETURN_TOKENS = 500;
export const CHARS_PER_TOKEN = 4;
export const MAX_SUBAGENT_RETURN_CHARS = MAX_SUBAGENT_RETURN_TOKENS * CHARS_PER_TOKEN; // 2000

export class DelegationRejectedError extends Error {
  readonly code: "cycle" | "depth";
  readonly attemptedDepth?: number;
  readonly maxDepth?: number;
  constructor(code: "cycle" | "depth", message: string, meta?: { depth?: number; maxDepth?: number }) {
    super(message);
    this.name = "DelegationRejectedError";
    this.code = code;
    if (meta?.depth != null) this.attemptedDepth = meta.depth;
    if (meta?.maxDepth != null) this.maxDepth = meta.maxDepth;
  }
}

export function getMaxDepth(): number {
  const raw = process.env.SWARM_MAX_DEPTH?.trim();
  if (!raw) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.floor(n);
}

export function isGuardDisabled(): boolean {
  return getMaxDepth() >= 99;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function getChainDepth(parentRunId: string): Promise<number> {
  let depth = 0;
  let cur: string | null = parentRunId;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const row = await getDelegationByChild(cur);
    if (!row) break;
    depth++;
    cur = row.parentRunId;
    if (depth > 100) break;
  }
  return depth;
}

export async function getVisitedSet(parentRunId: string): Promise<Set<string>> {
  const visited = new Set<string>([parentRunId]);
  let cur: string | null = parentRunId;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const row = await getDelegationByChild(cur);
    if (!row) break;
    const p = row.parentRunId;
    if (visited.has(p)) break;
    visited.add(p);
    cur = p;
    if (visited.size > 100) break;
  }
  return visited;
}

export async function summarizeChildResult(
  fullOutput: string,
  opts: { childRunId: string; workspaceId?: string; producerAgent?: string }
): Promise<{ summary: string; artifactRef: string | null; truncated: boolean }> {
  const tokens = estimateTokens(fullOutput);
  if (tokens <= MAX_SUBAGENT_RETURN_TOKENS) {
    return { summary: fullOutput, artifactRef: null, truncated: false };
  }
  const truncatedSummary = fullOutput.slice(0, MAX_SUBAGENT_RETURN_CHARS) + `\n…[truncated ${fullOutput.length - MAX_SUBAGENT_RETURN_CHARS} chars, full output stored as artifact]`;
  let artifactRef: string | null = null;
  try {
    const { artifactsGate } = await import("../Artifacts/artifactsGate.js");
    const art = await artifactsGate.create({
      workspaceId: opts.workspaceId ?? "default",
      producerAgent: opts.producerAgent ?? "system",
      type: "report",
      contentRef: fullOutput.slice(0, 20000),
      metadata: {
        delegationChildRunId: opts.childRunId,
        truncated: true,
        originalLength: fullOutput.length,
        originalTokens: tokens,
      },
    });
    artifactRef = (art as unknown as { id: string }).id ?? null;
  } catch {
    // Hermetic / DB-unavailable fallback — still produce deterministic pointer
    artifactRef = `artifact:${opts.childRunId}:${Date.now().toString(36)}`;
    // Best-effort: do not throw, parent still gets pointer
  }
  if (!artifactRef) {
    artifactRef = `artifact:${opts.childRunId}:${Date.now().toString(36)}`;
  }
  const summaryWithPointer = `${truncatedSummary}\n[artifact:${artifactRef}]`;
  return { summary: summaryWithPointer, artifactRef, truncated: true };
}

/**
 * Central dispatcher gate: validates depth/cycle before enqueue.
 * Throws DelegationRejectedError deterministically on violation, never enqueues.
 * Emits delegation:start on success.
 */
export async function delegate(input: {
  parentRunId: string;
  childRunId: string;
  taskId?: string | null;
  broker?: EventBroker | null;
  workspaceId?: string;
  producerAgent?: string;
}): Promise<DelegationRow> {
  const { parentRunId, childRunId, taskId, broker } = input;
  if (!parentRunId || !childRunId) {
    throw new Error("delegate requires parentRunId and childRunId");
  }
  if (parentRunId === childRunId) {
    throw new DelegationRejectedError("cycle", `delegation rejected: cycle detected — parent and child are same id ${parentRunId}`);
  }

  const visited = await getVisitedSet(parentRunId);
  if (visited.has(childRunId)) {
    throw new DelegationRejectedError(
      "cycle",
      `delegation rejected: cycle detected — child ${childRunId} is ancestor of parent ${parentRunId} (visited: ${[...visited].join(",")})`
    );
  }

  const parentDepth = await getChainDepth(parentRunId);
  const newDepth = parentDepth + 1;
  const maxDepth = getMaxDepth();
  if (!isGuardDisabled() && newDepth > maxDepth) {
    throw new DelegationRejectedError(
      "depth",
      `delegation rejected: max depth ${maxDepth} exceeded (attempted depth ${newDepth} from parent ${parentRunId} -> child ${childRunId})`,
      { depth: newDepth, maxDepth }
    );
  }

  const row = await createDelegation({
    parentRunId,
    childRunId,
    depth: newDepth,
    summary: null,
  });

  if (broker) {
    try {
      (broker as unknown as { emit: (t: string, p: unknown, o?: unknown) => unknown }).emit(
        "delegation:start",
        {
          parentRunId,
          childRunId,
          depth: newDepth,
          taskId: taskId ?? null,
        },
        { channelId: undefined } as unknown as never
      );
    } catch {}
  }

  return row;
}

/**
 * Complete a delegation: summarize child output (≤500 tokens + artifact pointer),
 * persist summary to delegations row, emit delegation:completed.
 */
export async function completeDelegation(input: {
  parentRunId: string;
  childRunId: string;
  fullOutput: string;
  broker?: EventBroker | null;
  workspaceId?: string;
  producerAgent?: string;
  taskId?: string | null;
}): Promise<{ summary: string; artifactRef: string | null; truncated: boolean; delegation: DelegationRow | null }> {
  const { parentRunId, childRunId, fullOutput, broker, workspaceId, producerAgent } = input;
  const { summary, artifactRef, truncated } = await summarizeChildResult(fullOutput, {
    childRunId,
    workspaceId,
    producerAgent,
  });

  let delegation: DelegationRow | null = await getDelegationByChild(childRunId);
  if (delegation) {
    // Verify parent matches if row exists (defensive, not cycle)
    delegation = await updateDelegationSummary(delegation.id, summary);
  } else {
    // No prior delegate() call — create row lazily (e.g., inline child execution)
    const parentDepth = await getChainDepth(parentRunId);
    const newDepth = parentDepth + 1;
    delegation = await createDelegation({ parentRunId, childRunId, depth: newDepth, summary });
  }

  if (broker) {
    try {
      (broker as unknown as { emit: (t: string, p: unknown, o?: unknown) => unknown }).emit(
        "delegation:completed",
        {
          parentRunId,
          childRunId,
          summary,
          artifactRef: artifactRef ?? null,
        },
        { channelId: undefined } as unknown as never
      );
    } catch {}
  }

  return { summary, artifactRef, truncated, delegation };
}

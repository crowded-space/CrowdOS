import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { runs, runsCompensation, type RunStatus, type RunCheckpoint, type CompensationInverseOp } from "../db/schema.js";
import { transition } from "./run-state-machine.js";

export type RunRow = typeof runs.$inferSelect;
export type CompensationRow = typeof runsCompensation.$inferSelect;
export type { RunCheckpoint, CompensationInverseOp } from "../db/schema.js";

export interface CreateRunInput {
  parentRunId?: string | null;
  agentId: string;
  channelId: string;
  workspaceId?: string | null;
  runtimeType: string;
}

export interface CheckpointPatch {
  watermarkSeq?: number;
  completedCallIds?: string[];
  historyRef?: string;
}

export interface TransitionOptions {
  reason?: string | null;
  errorCode?: string | null;
}

export interface TransitionResult {
  row: RunRow;
  from: RunStatus;
  to: RunStatus;
  changed: boolean;
  reason: string | null;
}

export function isRunsEnabled(): boolean {
  return process.env.RUNS_ENABLED !== "false";
}

export async function createRun(input: CreateRunInput): Promise<RunRow | null> {
  if (!isRunsEnabled()) return null;
  // C3 local-first, record-only DB: no ledger without the workspace's record
  // database — the executor runs run-less (null, never throws for local).
  // Env URLs are CLI-only, never read.
  const { dbForWorkspace, isNoDatabaseError } = await import("../shared/config/database.js");
  let db: Awaited<ReturnType<typeof dbForWorkspace>>;
  try {
    db = await dbForWorkspace(input.workspaceId ?? null);
  } catch (err) {
    if (isNoDatabaseError(err)) return null;
    throw err;
  }
  const [row] = await db
    .insert(runs)
    .values({
      parentRunId: input.parentRunId ?? null,
      agentId: input.agentId,
      channelId: input.channelId,
      workspaceId: input.workspaceId ?? null,
      runtimeType: input.runtimeType,
      status: "created",
    })
    .returning();
  return row ?? null;
}

/**
 * RUN-1: single choke point for every run-status write. Reads the current
 * status, validates the move against runStateMachine, then updates with a
 * WHERE status = from guard so concurrent writers cannot skip the machine.
 * Returns null on illegal transitions and terminal-immutability violations;
 * returns changed=false for idempotent same-state no-ops.
 */
export async function applyTransition(
  runId: string,
  to: RunStatus,
  options: TransitionOptions = {}
): Promise<TransitionResult | null> {
  if (!isRunsEnabled()) return null;
  const db = getDb();
  const [current] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!current) return null;

  const verdict = transition(current.status, to);
  if (!verdict.ok) return null;
  if (verdict.noop) {
    return { row: current, from: current.status, to, changed: false, reason: options.reason ?? null };
  }

  const [row] = await db
    .update(runs)
    .set({ status: to, errorCode: options.errorCode ?? null, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, current.status)))
    .returning();
  if (!row) return null;
  return { row, from: verdict.from, to, changed: true, reason: options.reason ?? null };
}

export async function completeRun(runId: string): Promise<RunRow | null> {
  const result = await applyTransition(runId, "completed");
  return result?.row ?? null;
}

export async function failRun(runId: string, errorCode?: string | null): Promise<RunRow | null> {
  const result = await applyTransition(runId, "failed", { errorCode: errorCode ?? "RUN_FAILED" });
  return result?.row ?? null;
}

export async function cancelRun(runId: string): Promise<RunRow | null> {
  await applyTransition(runId, "cancelling");
  const result = await applyTransition(runId, "cancelled");
  return result?.row ?? null;
}

export async function getRunById(runId: string): Promise<RunRow | null> {
  if (!isRunsEnabled()) return null;
  const db = getDb();
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row ?? null;
}

export async function touchCheckpoint(runId: string, patchOrSeq: number | CheckpointPatch): Promise<void> {
  if (!isRunsEnabled()) return;
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  try {
    if (typeof patchOrSeq === "number") {
      const seq = patchOrSeq;
      // P04: single-statement atomic merge — no read-modify-write, so parallel
      // executeBatch writers cannot lose completedCallIds. Watermark monotonic.
      await db
        .update(runs)
        .set({
          checkpoint: sql`jsonb_set(jsonb_set(jsonb_set(coalesce(${runs.checkpoint}, '{}'::jsonb), '{watermarkSeq}', to_jsonb(greatest(coalesce((${runs.checkpoint}->>'watermarkSeq')::bigint, 0), ${seq}))), '{completedCallIds}', coalesce(${runs.checkpoint}->'completedCallIds', '[]'::jsonb)), '{updatedAt}', to_jsonb(${nowIso}::text))`,
          checkpointSeq: sql`greatest(coalesce(${runs.checkpointSeq}, 0), ${seq})`,
          updatedAt: now,
        })
        .where(eq(runs.id, runId));
      return;
    }
    const patch = patchOrSeq as CheckpointPatch;
    // P04: same single-statement merge; new ids unioned with stored ids in-DB.
    let checkpointExpr = sql`coalesce(${runs.checkpoint}, '{}'::jsonb)`;
    if (patch.watermarkSeq !== undefined) {
      const seq = patch.watermarkSeq;
      checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{watermarkSeq}', to_jsonb(greatest(coalesce((${runs.checkpoint}->>'watermarkSeq')::bigint, 0), ${seq})))`;
    } else {
      checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{watermarkSeq}', to_jsonb(coalesce((${runs.checkpoint}->>'watermarkSeq')::bigint, 0)))`;
    }
    const newIds = patch.completedCallIds ?? [];
    if (newIds.length > 0) {
      checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{completedCallIds}', (select coalesce(jsonb_agg(distinct elem), '[]'::jsonb) from jsonb_array_elements_text(coalesce(${runs.checkpoint}->'completedCallIds', '[]'::jsonb) || ${JSON.stringify(newIds)}::jsonb) as t(elem)))`;
    } else {
      checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{completedCallIds}', coalesce(${runs.checkpoint}->'completedCallIds', '[]'::jsonb))`;
    }
    if (patch.historyRef !== undefined) {
      checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{historyRef}', to_jsonb(${patch.historyRef}::text))`;
    }
    checkpointExpr = sql`jsonb_set(${checkpointExpr}, '{updatedAt}', to_jsonb(${nowIso}::text))`;
    await db
      .update(runs)
      .set({
        checkpoint: checkpointExpr,
        ...(patch.watermarkSeq !== undefined
          ? { checkpointSeq: sql`greatest(coalesce(${runs.checkpointSeq}, 0), ${patch.watermarkSeq})` }
          : {}),
        updatedAt: now,
      })
      .where(eq(runs.id, runId));
  } catch (err) {
    console.warn(`[runsRepository] touchCheckpoint failed for ${runId}:`, (err as Error)?.message || err);
  }
}

export async function touchRunHeartbeat(runId: string): Promise<void> {
  if (!isRunsEnabled()) return;
  try {
    const db = getDb();
    await db.update(runs).set({ updatedAt: new Date() }).where(eq(runs.id, runId));
  } catch (err) {
    console.warn(`[runsRepository] touchRunHeartbeat failed for ${runId}:`, (err as Error)?.message || err);
  }
}

export function buildCompensationInverse(args: { existed: boolean; priorContent?: string | null; path: string }): CompensationInverseOp {
  if (!args.existed) {
    return { op: "delete", path: args.path };
  }
  const prior = args.priorContent ?? "";
  const priorHash = createHash("sha256").update(prior, "utf8").digest("hex");
  const truncated = prior.length > 20000 ? prior.slice(0, 20000) : prior;
  return { op: "restore", path: args.path, priorHash, priorContentRef: truncated };
}

export async function addCompensation(runId: string, entry: { toolName: string; targetPath: string; inverseOp: CompensationInverseOp }): Promise<CompensationRow | null> {
  if (!isRunsEnabled()) return null;
  const db = getDb();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [row] = await db.insert(runsCompensation).values({
        id: randomUUID(),
        runId,
        seq: sql`(select coalesce(max(seq), 0) + 1 from runs_compensation where run_id = ${runId})`,
        toolName: entry.toolName,
        targetPath: entry.targetPath,
        inverseOp: entry.inverseOp,
      }).returning();
      return row ?? null;
    } catch (err) {
      if ((err as { code?: string })?.code === "23505" && attempt === 0) continue;
      console.warn(`[runsRepository] addCompensation failed for ${runId}:`, (err as Error)?.message || err);
      return null;
    }
  }
  return null;
}

export async function listCompensations(runId: string): Promise<CompensationRow[]> {
  if (!isRunsEnabled()) return [];
  const db = getDb();
  try {
    return await db.select().from(runsCompensation).where(eq(runsCompensation.runId, runId)).orderBy(runsCompensation.seq);
  } catch {
    return [];
  }
}

export async function getCompensation(runId: string, compId: string): Promise<CompensationRow | null> {
  const db = getDb();
  const [row] = await db.select().from(runsCompensation).where(and(eq(runsCompensation.runId, runId), eq(runsCompensation.id, compId))).limit(1);
  return row ?? null;
}

export async function deleteCompensation(compId: string): Promise<void> {
  const db = getDb();
  await db.delete(runsCompensation).where(eq(runsCompensation.id, compId));
}

export async function listRunsByStatus(statuses: RunStatus[], staleBefore?: Date, limit = 50): Promise<RunRow[]> {
  const db = getDb();
  try {
    const { inArray, lt } = await import("drizzle-orm");
    if (staleBefore) {
      return await db.select().from(runs).where(and(inArray(runs.status, statuses), lt(runs.updatedAt, staleBefore))).limit(limit);
    }
    return await db.select().from(runs).where(inArray(runs.status, statuses)).limit(limit);
  } catch {
    return [];
  }
}

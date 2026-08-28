import { inArray, lt, and } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { runs, type RunCheckpoint } from "../db/schema.js";
import { applyTransition, getRunById } from "./runsRepository.js";
import type { EventBroker } from "../EventBroker/eventBrokerGate.js";

const ORPHAN_AFTER_MS = (() => {
  const raw = Number(process.env.ORPHAN_AFTER_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

function resolveSweepIntervalMs(): number {
  const raw = Number(process.env.ORPHAN_SWEEP_MS);
  if (Number.isFinite(raw) && raw >= 5_000) return raw;
  return 30_000;
}

const ORPHAN_CANDIDATE_STATUSES: Array<(typeof runs.$inferSelect)["status"]> = [
  "running",
  "starting",
  "completing",
  "waiting_for_tool",
  "waiting_for_approval",
  "retrying",
  "compacting",
  "verifying",
  "queued",
];

function emitStatus(broker: EventBroker, row: { id: string; agentId: string; channelId: string; workspaceId: string | null; runtimeType: string; status: string; errorCode: string | null }, from: string, to: string, reason: string | null) {
  try {
    broker.emit("run.status_changed", {
      runId: row.id,
      agentId: row.agentId,
      channelId: row.channelId,
      workspaceId: row.workspaceId,
      runtimeType: row.runtimeType,
      status: to as unknown as never,
      from: from as unknown as never,
      reason,
      errorCode: row.errorCode,
    } as never, { channelId: row.channelId } as never);
  } catch {}
}

export async function sweepOrphanedRuns(broker: EventBroker): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS);
  let swept = 0;
  try {
    const stale = await db
      .select()
      .from(runs)
      .where(and(inArray(runs.status, ORPHAN_CANDIDATE_STATUSES as never), lt(runs.updatedAt, cutoff)))
      .limit(50);
    for (const run of stale) {
      const toOrphan = await applyTransition(run.id, "orphaned", { reason: "orphan_sweep_stale" });
      if (!toOrphan || !toOrphan.changed) continue;
      emitStatus(broker, toOrphan.row, toOrphan.from, toOrphan.to, toOrphan.reason);
      const toResumable = await applyTransition(run.id, "resumable", { reason: "orphan_marked_resumable" });
      if (toResumable && toResumable.changed) {
        emitStatus(broker, toResumable.row, toResumable.from, toResumable.to, toResumable.reason);
      }
      swept++;
    }
  } catch (err) {
    console.warn("[orphanSweep] sweep failed:", (err as Error)?.message || err);
  }
  return swept;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startRunOrphanSweeper(broker: EventBroker): void {
  if (started) return;
  started = true;
  const interval = resolveSweepIntervalMs();
  timer = setInterval(() => { void sweepOrphanedRuns(broker); }, interval);
  timer.unref?.();
  console.log(`[orphanSweep] Active — sweep every ${interval}ms, orphan threshold ${ORPHAN_AFTER_MS}ms`);
}

export function stopRunOrphanSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

export function resetOrphanSweepForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

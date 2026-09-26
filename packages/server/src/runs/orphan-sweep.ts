import { inArray, lt, and, asc, or } from "drizzle-orm";
import { getDb, isDatabaseConfigured, runWithDb } from "../shared/config/database.js";
import { forEachWorkspaceDb } from "../workspace/workspace-gate.js";
import { runs } from "../db/schema.js";
import { applyTransition } from "./runs-repository.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

const ORPHAN_AFTER_MS = (() => {
  const raw = Number(process.env.ORPHAN_AFTER_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

// Non-heartbeating states (created = queued-to-BullMQ wait, queued = waiting for
// pickup) sit still until an executor touches them, so the 60s live threshold
// would reap a merely-slow queue. ponytail: 10× derived factor, no env flag —
// raise this to its own ORPHAN_PENDING_AFTER_MS if backlogs outrun 10 min.
const PENDING_ORPHAN_AFTER_MS = ORPHAN_AFTER_MS * 10;
const PENDING_ORPHAN_STATUSES = ["created", "queued"] as const;

function resolveSweepIntervalMs(): number {
  const raw = Number(process.env.ORPHAN_SWEEP_MS);
  if (Number.isFinite(raw) && raw >= 5_000) return raw;
  return 30_000;
}

const LIVE_ORPHAN_STATUSES: Array<(typeof runs.$inferSelect)["status"]> = [
  // P01: waiting_for_approval intentionally excluded — approval waits (up to
  // 5min) + long LLM calls outlive the 60s threshold; live runs stay fresh
  // via the 15s touchRunHeartbeat in runtime-executor.
  "running",
  "starting",
  "completing",
  "waiting_for_tool",
  "retrying",
  "compacting",
  "verifying",
  // Self-heal: a crash between the orphaned→resumable hops (or between
  // cancelling→cancelled in cancelRun) strands these rows forever since the
  // second hop never ran. Re-select them so the next sweep finishes the move.
  "orphaned",
  "cancelling",
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
  const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS);
  const pendingCutoff = new Date(Date.now() - PENDING_ORPHAN_AFTER_MS);
  let swept = 0;
  const sweepOneDb = async () => {
    try {
      const db = getDb();
      const stale = await db
        .select()
        .from(runs)
        .where(
          or(
            and(inArray(runs.status, LIVE_ORPHAN_STATUSES as never), lt(runs.updatedAt, cutoff)),
            and(inArray(runs.status, PENDING_ORPHAN_STATUSES as never), lt(runs.updatedAt, pendingCutoff))
          )
        )
        .orderBy(asc(runs.updatedAt))
        .limit(50)
        .for("update", { skipLocked: true });
      for (const run of stale) {
        // Self-heal stranded intermediate states from a prior crashed sweep.
        if (run.status === "orphaned") {
          const healed = await applyTransition(run.id, "resumable", { reason: "orphan_marked_resumable" });
          if (healed && healed.changed) {
            emitStatus(broker, healed.row, healed.from, healed.to, healed.reason);
            swept++;
          }
          continue;
        }
        if (run.status === "cancelling") {
          const healed = await applyTransition(run.id, "cancelled", { reason: "cancel_sweep_heal" });
          if (healed && healed.changed) {
            emitStatus(broker, healed.row, healed.from, healed.to, healed.reason);
            swept++;
          }
          continue;
        }
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
  };
  await forEachWorkspaceDb((db) => runWithDb(db, sweepOneDb));
  // Workspace-less creates land on the shared handle (resolveDb's fallback);
  // sweep it too or those rows are immortal. Best-effort: no DATABASE_URL
  // configured means nothing to sweep.
  if (isDatabaseConfigured()) await sweepOneDb();
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

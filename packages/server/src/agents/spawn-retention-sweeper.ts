import { and, isNotNull, lt } from "drizzle-orm";

import { getDb, runWithDb } from "../shared/config/database.js";
import { forEachWorkspaceDb } from "../workspace/workspace-gate.js";
import { agents, channels, taskFiles } from "../db/schema.js";

const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface SpawnRetentionSweepResult {
  purgedTaskFiles: number;
  purgedAgents: number;
  purgedChannels: number;
}

async function purgeArchivedBefore(table: typeof agents | typeof channels | typeof taskFiles, cutoff: Date): Promise<number> {
  const db = getDb();
  const purged = await db
    .delete(table)
    .where(and(isNotNull(table.archivedAt), lt(table.archivedAt, cutoff)))
    .returning({ id: table.id });
  return purged.length;
}

/**
 * DB-3 archive-then-purge lifecycle: hard-deletes spawn artifacts whose
 * archived_at predates the retention window (RETENTION_DAYS, default 30).
 * Standalone-callable so it can move behind a job queue without reshaping.
 */
export async function runSpawnRetentionSweep(now: Date = new Date()): Promise<SpawnRetentionSweepResult> {
  const retentionDays = numEnv("RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const totals = { purgedTaskFiles: 0, purgedAgents: 0, purgedChannels: 0 };
  await forEachWorkspaceDb(async (db) => {
    await runWithDb(db, async () => {
      totals.purgedTaskFiles += await purgeArchivedBefore(taskFiles, cutoff);
      totals.purgedAgents += await purgeArchivedBefore(agents, cutoff);
      totals.purgedChannels += await purgeArchivedBefore(channels, cutoff);
    });
  });

  if (totals.purgedTaskFiles + totals.purgedAgents + totals.purgedChannels > 0) {
    console.log(
      `[SpawnRetention] Purged ${totals.purgedTaskFiles} task_files, ${totals.purgedAgents} agents, ${totals.purgedChannels} channels archived before ${cutoff.toISOString()}.`
    );
  }

  return totals;
}

let started = false;

/** Test-only: clear the once-per-process guard. */
export function resetSpawnRetentionSweeperForTests(): void {
  started = false;
}

export function startSpawnRetentionSweeper(): void {
  if (started) return;
  started = true;

  const intervalMs = numEnv("RETENTION_SWEEP_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const timer = setInterval(() => {
    void runSpawnRetentionSweep().catch((err) => {
      console.error(`[SpawnRetention] Sweep failed: ${(err as Error)?.message || err}`);
    });
  }, intervalMs);
  timer.unref?.();

  console.log(`[SpawnRetention] Sweeper active every ${intervalMs}ms (retention ${numEnv("RETENTION_DAYS", DEFAULT_RETENTION_DAYS)}d).`);
}
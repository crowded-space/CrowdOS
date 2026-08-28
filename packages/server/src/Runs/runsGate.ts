import {
  createRun,
  completeRun,
  failRun,
  cancelRun,
  touchCheckpoint,
  applyTransition,
  getRunById,
  addCompensation,
  listCompensations,
  getCompensation,
  deleteCompensation,
  buildCompensationInverse,
} from "./runsRepository.js";
import type { CreateRunInput, RunRow, TransitionResult, CheckpointPatch, CompensationRow } from "./runsRepository.js";
import { isTerminal } from "./runStateMachine.js";
import type { RunState, TransitionVerdict } from "./runStateMachine.js";
import type { RunStatus, RunCheckpoint, CompensationInverseOp } from "../db/schema.js";

export type { CreateRunInput, RunRow, TransitionResult, CheckpointPatch, CompensationRow, RunCheckpoint, CompensationInverseOp };
export type { RunStatus } from "../db/schema.js";
export type { RunState, TransitionVerdict };
export { isTerminal };

async function resumeRun(runId: string): Promise<{ run: RunRow; checkpoint: RunCheckpoint | null } | null> {
  const current = await getRunById(runId);
  if (!current) return null;
  if (current.status !== "resumable") return null;
  const result = await applyTransition(runId, "queued", { reason: "resume_requested" });
  if (!result) return null;
  try {
    const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
    const broker = new EventBroker();
    broker.emit("run.status_changed", {
      runId: result.row.id,
      agentId: result.row.agentId,
      channelId: result.row.channelId,
      workspaceId: result.row.workspaceId,
      runtimeType: result.row.runtimeType,
      status: result.to,
      from: result.from,
      reason: result.reason,
      errorCode: result.row.errorCode,
    } as never, { channelId: result.row.channelId } as never);
  } catch {}
  const checkpoint = (result.row.checkpoint as RunCheckpoint | null) ?? (current.checkpoint as RunCheckpoint | null) ?? null;
  return { run: result.row, checkpoint };
}

async function undoCompensation(runId: string, compId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await getCompensation(runId, compId);
  if (!row) return { ok: false, error: "compensation not found" };
  const inverse = row.inverseOp as CompensationInverseOp;
  try {
    const { getDb } = await import("../Shared/config/database.js");
    const db = getDb();
    let workspaceRoot: string | null = null;
    try {
      const run = await getRunById(runId);
      const wsId = run?.workspaceId ?? "default";
      const ws = await (db.query as unknown as { workspaces: { findFirst: (opts: unknown) => Promise<{ rootPath: string } | null> } }).workspaces.findFirst({ where: (await import("drizzle-orm")).eq((await import("../db/schema.js")).workspaces.id, wsId) });
      workspaceRoot = ws?.rootPath ?? null;
    } catch {}
    if (!workspaceRoot) {
      const pathMod = await import("node:path");
      workspaceRoot = pathMod.join(process.cwd(), "sandbox", row.runId ? "default" : "default");
    }
    const { Guard } = await import("../tools/safety/Guard.js");
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    if (inverse.op === "delete") {
      const resolved = Guard.validatePath(inverse.path, workspaceRoot);
      try { await fs.unlink(resolved); } catch (e: unknown) { const code = (e as { code?: string })?.code; if (code !== "ENOENT") throw e; }
    } else if (inverse.op === "restore") {
      const resolved = Guard.validatePath(inverse.path, workspaceRoot);
      await fs.mkdir(pathMod.dirname(resolved), { recursive: true });
      const content = inverse.priorContentRef ?? "";
      await fs.writeFile(resolved, content, "utf8");
    }
    await deleteCompensation(compId);
    try {
      const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
      const broker = new EventBroker();
      const entries = await listCompensations(runId);
      broker.emit("run.compensations" as never, { runId, entries } as never, { channelId: (await getRunById(runId))?.channelId } as never);
    } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const runsGate = {
  create: createRun,
  complete: completeRun,
  fail: failRun,
  cancel: cancelRun,
  touchCheckpoint,
  transition: (
    runId: string,
    to: RunStatus,
    reason?: string | null,
    errorCode?: string | null
  ): Promise<TransitionResult | null> => applyTransition(runId, to, { reason, errorCode }),
  getById: getRunById,
  resumeRun,
  addCompensation,
  listCompensations,
  getCompensation,
  undoCompensation,
  buildCompensationInverse,
  sweepOrphanedRuns: async (broker: unknown) => {
    const mod = await import("./orphanSweep.js");
    return (mod as unknown as { sweepOrphanedRuns: (b: unknown) => Promise<number> }).sweepOrphanedRuns(broker as never);
  },
  startRunOrphanSweeper: async (broker: unknown) => {
    const mod = await import("./orphanSweep.js");
    return (mod as unknown as { startRunOrphanSweeper: (b: unknown) => void }).startRunOrphanSweeper(broker as never);
  },
};

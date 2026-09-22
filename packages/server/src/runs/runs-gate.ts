import {
  createRun,
  completeRun,
  failRun,
  cancelRun,
  touchCheckpoint,
  touchRunHeartbeat,
  applyTransition,
  getRunById,
  addCompensation,
  listCompensations,
  getCompensation,
  deleteCompensation,
  buildCompensationInverse,
} from "./runs-repository.js";
import type { CreateRunInput, RunRow, TransitionResult, CheckpointPatch, CompensationRow } from "./runs-repository.js";
import { isTerminal } from "./run-state-machine.js";
import type { RunState, TransitionVerdict } from "./run-state-machine.js";
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
  if (!result || !result.changed) return null;
  try {
    const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
    const broker = getSharedBroker();
    if (broker) {
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
    } else {
      console.warn("[Runs] dropped run.status_changed: no shared broker registered");
    }
  } catch {}
  const checkpoint = (result.row.checkpoint as RunCheckpoint | null) ?? (current.checkpoint as RunCheckpoint | null) ?? null;
  return { run: result.row, checkpoint };
}

async function undoCompensation(runId: string, compId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await getCompensation(runId, compId);
  if (!row) return { ok: false, error: "compensation not found" };
  const inverse = row.inverseOp as CompensationInverseOp;
  try {
    let workspaceRoot: string | null = null;
    // Channel-mount-aware root: Zone B mount when one resolves, else Zone A
    // workspace-local. Same resolver the Repo panel and file tools use.
    try {
      const run = await getRunById(runId);
      const { channelMountGate } = await import("../channel-mounts/channel-mount-gate.js");
      const root = await channelMountGate.effectiveRoot({
        channelId: run?.channelId ?? null,
        workspaceId: run?.workspaceId ?? "default",
      });
      workspaceRoot = root.path;
    } catch {}
    if (!workspaceRoot) {
      // No resolvable root is a configuration error, not a licence to write
      // into the server's own tree. Fail loudly.
      return { ok: false, error: "no resolvable workspace root for compensation undo" };
    }
    const { Guard } = await import("../tools/safety/guard.js");
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    if (inverse.op === "delete") {
      const resolved = await Guard.validatePath(inverse.path, workspaceRoot);
      try { await fs.unlink(resolved); } catch (e: unknown) { const code = (e as { code?: string })?.code; if (code !== "ENOENT") throw e; }
    } else if (inverse.op === "restore") {
      const resolved = await Guard.validatePath(inverse.path, workspaceRoot);
      await fs.mkdir(pathMod.dirname(resolved), { recursive: true });
      const content = inverse.priorContentRef ?? "";
      await fs.writeFile(resolved, content, "utf8");
    }
    await deleteCompensation(compId);
    try {
      const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
      const broker = getSharedBroker();
      if (broker) {
        const entries = await listCompensations(runId);
        broker.emit("run.compensations" as never, { runId, entries } as never, { channelId: (await getRunById(runId))?.channelId } as never);
      } else {
        console.warn("[Runs] dropped run.compensations: no shared broker registered");
      }
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
  touchRunHeartbeat,
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
    const mod = await import("./orphan-sweep.js");
    return (mod as unknown as { sweepOrphanedRuns: (b: unknown) => Promise<number> }).sweepOrphanedRuns(broker as never);
  },
  startRunOrphanSweeper: async (broker: unknown) => {
    const mod = await import("./orphan-sweep.js");
    return (mod as unknown as { startRunOrphanSweeper: (b: unknown) => void }).startRunOrphanSweeper(broker as never);
  },
};

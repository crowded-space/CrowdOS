import {
  createRun,
  completeRun,
  failRun,
  cancelRun,
  touchCheckpoint,
  touchRunHeartbeat,
  applyTransition,
  getRunById,
  getRunsMetaByIds,
  addCompensation,
  listCompensations,
  getCompensation,
  deleteCompensation,
  deleteRunCompensation,
  buildCompensationInverse,
  listRunsByStatus,
} from "./runs-repository.js";
import { resumeRun, undoCompensation } from "./runs-service.js";
import type { CreateRunInput, RunRow, RunMeta, TransitionResult, CheckpointPatch, CompensationRow } from "./runs-repository.js";
import { isTerminal } from "./run-state-machine.js";
import type { RunState, TransitionVerdict } from "./run-state-machine.js";
import type { RunStatus, RunCheckpoint, CompensationInverseOp } from "../db/schema.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

export type { CreateRunInput, RunRow, TransitionResult, CheckpointPatch, CompensationRow, RunCheckpoint, CompensationInverseOp };
export type { RunMeta } from "./runs-repository.js";
export type { RunStatus } from "../db/schema.js";
export type { RunState, TransitionVerdict };
export { isTerminal };

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
    errorCode?: string | null,
    workspaceId?: string | null
  ): Promise<TransitionResult | null> => applyTransition(runId, to, { reason, errorCode, workspaceId }),
  getById: getRunById,
  // RUN-012/XD-012: batched metadata for cross-domain readers.
  getMetaByIds: getRunsMetaByIds,
  resumeRun,
  addCompensation,
  listCompensations,
  getCompensation,
  deleteCompensation,
  // RUN-013: scoped variant (runId in WHERE). Prefer over deleteCompensation.
  deleteRunCompensation,
  listRunsByStatus,
  undoCompensation,
  buildCompensationInverse,
  sweepOrphanedRuns: async (broker: EventBroker) => {
    const mod = await import("./orphan-sweep.js");
    return mod.sweepOrphanedRuns(broker);
  },
  startRunOrphanSweeper: async (broker: EventBroker): Promise<void> => {
    const mod = await import("./orphan-sweep.js");
    mod.startRunOrphanSweeper(broker);
  },
};

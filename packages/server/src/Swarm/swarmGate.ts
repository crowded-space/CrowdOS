import { createSwarmTasks, updateSwarmTaskStatus, listSwarmTasksByRun, getSwarmTaskById, deleteSwarmTasksByRun, resetSwarmRepositoryForTests } from "./swarmRepository.js";
import { generateSwarmPlan, parsePlanJson, buildFallbackLinearPlan, buildSupervisorPrompt } from "./swarmPlanner.js";
import { dispatchSwarmTasks } from "./swarmDispatcher.js";
import type { WorkerExecutor } from "./swarmDispatcher.js";
import { aggregateSwarmOutputs } from "./swarmAggregator.js";
import { verifySwarm } from "./swarmVerifier.js";
import type { SwarmPlan, SwarmPlanTask, SwarmTaskRow, SwarmTaskStatus, SwarmWorkerResult, SwarmAggregationResult, SwarmVerificationResult, SwarmReport } from "./swarmTypes.js";
import { isSwarmV1Enabled, isSwarmLegacyEnabled } from "./swarmTypes.js";
import {
  createDelegation,
  getDelegationByChild,
  listDelegationsByParent,
  updateDelegationSummary,
  listAllDelegations,
  resetDelegationRepositoryForTests,
} from "./delegationRepository.js";
import type { DelegationRow } from "./delegationRepository.js";
import {
  delegate,
  completeDelegation,
  summarizeChildResult,
  getChainDepth,
  getVisitedSet,
  estimateTokens,
  getMaxDepth,
  isGuardDisabled,
  DelegationRejectedError,
  MAX_SUBAGENT_RETURN_TOKENS,
  MAX_SUBAGENT_RETURN_CHARS,
} from "./delegationService.js";

export type { SwarmPlan, SwarmPlanTask, SwarmTaskRow, SwarmTaskStatus, SwarmWorkerResult, SwarmAggregationResult, SwarmVerificationResult, SwarmReport };
export type { WorkerExecutor };
export type { DelegationRow };
export { DelegationRejectedError };

export const swarmGate = {
  isV1Enabled: isSwarmV1Enabled,
  isLegacyEnabled: isSwarmLegacyEnabled,

  // Repository
  createTasks: createSwarmTasks,
  updateTaskStatus: updateSwarmTaskStatus,
  listByRun: listSwarmTasksByRun,
  getById: getSwarmTaskById,
  deleteByRun: deleteSwarmTasksByRun,
  resetForTests: () => {
    resetSwarmRepositoryForTests();
    resetDelegationRepositoryForTests();
  },

  // Planner
  plan: generateSwarmPlan,
  parsePlanJson,
  buildFallbackPlan: buildFallbackLinearPlan,
  buildSupervisorPrompt,

  // Dispatcher
  dispatch: dispatchSwarmTasks,

  // Aggregator
  aggregate: aggregateSwarmOutputs,

  // Verifier
  verify: verifySwarm,

  // Delegation contracts (SW-2)
  createDelegation,
  getDelegationByChild,
  listDelegationsByParent,
  updateDelegationSummary,
  listAllDelegations,
  resetDelegationForTests: resetDelegationRepositoryForTests,
  delegate,
  completeDelegation,
  summarizeChildResult,
  getChainDepth,
  getVisitedSet,
  estimateTokens,
  getMaxDepth,
  isGuardDisabled,
  MAX_SUBAGENT_RETURN_TOKENS,
  MAX_SUBAGENT_RETURN_CHARS,
};

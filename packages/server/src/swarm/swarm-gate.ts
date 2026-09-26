// Swarm domain gate — the ONLY file outside ./Swarm/ may import.
// Ports = what production consumes (swarm-runtime.ts). Test-only helpers and
// delegation internals are imported directly by in-domain tests.
import { createSwarmTasks, listSwarmTasksByRun, deleteSwarmTasksByRun } from "./swarm-repository.js";
import { generateSwarmPlan } from "./swarm-planner.js";
import { dispatchSwarmTasks } from "./swarm-dispatcher.js";
import { aggregateSwarmOutputs } from "./swarm-aggregator.js";
import { verifySwarm } from "./swarm-verifier.js";
import { resolveWorker, loadWorkerCandidates } from "./swarm-worker-resolver.js";
import { isSwarmV1Enabled } from "./swarm-types.js";

export const swarmGate = {
  isV1Enabled: isSwarmV1Enabled,

  // Repository
  createTasks: createSwarmTasks,
  listByRun: listSwarmTasksByRun,
  deleteByRun: deleteSwarmTasksByRun,

  // Planner
  plan: generateSwarmPlan,

  // Dispatcher
  dispatch: dispatchSwarmTasks,

  // Worker resolution (roster → agent for plan assignees)
  resolveWorker,
  loadWorkerCandidates,

  // Aggregator
  aggregate: aggregateSwarmOutputs,

  // Verifier
  verify: verifySwarm,
};

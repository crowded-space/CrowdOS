# Swarm Domain - Contracts (Phase 2)

## Facade (swarm-gate.ts:12-31)
Matches Domain Spec "Ports" claim of 10 production ports; no type re-exports (types live in swarm-types.ts; in-domain tests import internals directly).

| Port | Impl | Shape | Consumer |
| ---- | ---- | ----- | -------- |
| isV1Enabled | swarm-types.ts:58 | () => boolean (trim/lower === "true") | swarm-runtime.ts:27 |
| createTasks | swarm-repository.ts:132 | (runId, SwarmPlanTask[]) => Promise<SwarmTaskRow[]> | swarm-runtime.ts:70 |
| listByRun | swarm-repository.ts:233 | (runId) => Promise<SwarmTaskRow[]> (limit 500) | swarm-runtime.ts:162 |
| deleteByRun | swarm-repository.ts:289 | (runId) => Promise<void> | swarm-runtime.ts:66 |
| plan | swarm-planner.ts:146 | (packet, kernel, broker?) => Promise<PlanResult>; never throws | swarm-runtime.ts:55 |
| dispatch | swarm-dispatcher.ts:152 | (DispatchInput) => Promise<Map<string,SwarmWorkerResult>> | swarm-runtime.ts:152 |
| resolveWorker | swarm-worker-resolver.ts:79 | (assignee, candidates, opts) => ResolvedWorker; throws WorkerUnavailableError | swarm-runtime.ts:110 |
| loadWorkerCandidates | swarm-worker-resolver.ts:192 | (workspaceId) => Promise<AgentProfile[]>; rethrows roster errors | swarm-runtime.ts:52 |
| aggregate | swarm-aggregator.ts:51 | (tasks, results) => SwarmAggregationResult (pure) | swarm-runtime.ts:163 |
| verify | swarm-verifier.ts:48 | ({goal, aggregatedContent, packet, broker, kernel, aggregationSummary}) => Promise<SwarmVerificationResult> | swarm-runtime.ts:175 |

## Gate-to-gate (outbound)
- agents-gate: agentGate.list (swarm-worker-resolver.ts:33-34,196) - only call.
- artifacts-gate: artifactsGate.create (delegation-service.ts:89 dynamic; swarm-runtime.ts:230).
- event-broker-gate: type-only EventBroker (planner:2, dispatcher:3, verifier:2, delegation-service:2, runtime:2).
- runtime/types: ContextPacket (allowed by check-gates EXTRA_ALLOWED).
- No gate-to-gate cycles observed; no inbound gate imports other than runtime.

## Events
- delegation:start {parentRunId, childRunId, depth, taskId, workspaceId} (delegation-service.ts:166-177).
- delegation:completed {parentRunId, childRunId, summary, artifactRef, workspaceId} (delegation-service.ts:236-245).
- Drift: event-types.ts:120-132 payload interfaces omit workspaceId though it is emitted and load-bearing for socket room scoping (register-socket-server.ts:444); emits use untyped casts.
- No in-server listener beyond socket onAny; client consumes via message/timeline types.

## Tables owned / writes
- swarm_tasks: insert repo:174; status/output update repo:208-212; delete-by-run repo:297.
- delegations: insert deleg-repo:93; summary update deleg-repo:188.

## Flags / config
SWARM_V1, SWARM_MAX_DEPTH (default 2, >=99 disables), SWARM_MAX_CONCURRENCY (default 4, cap 32), SWARM_TASK_TIMEOUT_MS (default 300000), SWARM_GUARD_DISABLED; hermetic mode when __SOCKET_FAKE_DB__=1 or NODE_ENV=test or no DATABASE_URL (repo:60, deleg-repo:61).

## Contract drift list
1. event-types.ts delegation payloads lack workspaceId (emitted anyway).
2. env.ts:216-217 SWARM_V1 describe says "BullMQ/leases via heartbeats"; implementation is in-process bounded fan-out + heartbeat lease (no BullMQ import in domain).
3. schema.ts:552 child FK vs migration 0024 (dropped).
4. RuntimeRouter (runtime-router.ts:90-92) duplicates the SWARM_V1 reader instead of using the gate.

# Swarm Domain - Invariants (Phases 3-4)

INV-1 Plan strictness: parsePlanJson returns null (never partial) on empty tasks, missing id/assignee, duplicate ids, unknown/self deps, cycles, >50 tasks (swarm-planner.ts:14-76,38).
INV-2 plan never throws: invalid JSON/LLM failure -> 2-task linear fallback with fallbackUsed + reason (swarm-planner.ts:146-172; planner tests).
INV-3 dispatch validates DAG before any worker and throws on invalid plan; plan > MAX_SWARM_TASKS=50 throws (swarm-dispatcher.ts:150,158-165).
INV-4 Terminal task rows are immutable: ALLOWED_TRANSITIONS + canTransition reject rewinds with a warning (swarm-repository.ts:40-51,194-197). CAVEAT SW-01: check consults mem only.
INV-5 Task ids are namespaced per run ("runId::taskId") so bare plan ids ("task-1") can repeat across runs (swarm-repository.ts:9-25; swarm-repository.test.ts:18-44).
INV-6 Mem coherence: memOnly rows are authoritative over PG; process cap 500 with PG-backed rows evicted first (swarm-repository.ts:53-58,99-113,242).
INV-7 Bounded fan-out: default concurrency 4, cap 32, invalid env falls back; per-task timeout default 5 min (swarm-dispatcher.ts:18-39,276; mapWithConcurrency never rejects the batch, :46-67).
INV-8 Blocked propagation: failed deps mark dependents blocked without executing; unsatisfiable leftovers force-blocked; 100-round iteration guard fails leftovers and throws (swarm-dispatcher.ts:208-260).
INV-9 Abort settles pending/running tasks as failed with honest reasons; settled batch results are still persisted (swarm-dispatcher.ts:339-380).
INV-10 Delegation guards: self-delegation and visited-set cycles rejected; depth > SWARM_MAX_DEPTH rejected; rejection never writes a row; >=99 disables depth only (delegation-service.ts:121-154; delegation.test.ts:25-122).
INV-11 Summary contract: <=500 tokens (2000 chars) pass verbatim; longer truncates + artifact pointer; artifact failure yields deterministic fallback ref (delegation-service.ts:6-8,81-113).
INV-12 Aggregation never fabricates success: missing results -> failed/blocked with reason; blocked bucket never double-counted; honest "Completed X/Y" summary (swarm-aggregator.ts:62-102; aggregator tests).
INV-13 Verifier fallback fails empty plans, fails 0 completions, and passes only when the artifact carries the "Completed X/Y" marker - even when completed === total (swarm-verifier.ts:83-106; verifier tests).
INV-14 Worker resolution: only L3 workers; requesting agent excluded by default; every substitution disclosed; WorkerUnavailableError when no L3 exists (swarm-worker-resolver.ts:79-177; resolver tests).
INV-15 Facade surface: exactly 10 ports, no logic, no type re-exports; sole prod consumer swarm-runtime (swarm-gate.ts:12-31; check-gates 0 violations).
INV-16 Lease ownership: globalThis.__swarmLeaseCleanup; only the owner releases; same-agent overlap does not idle a live agent (swarm-dispatcher.ts:177-203,385-389; dispatcher test CRITICAL-2).
INV-17 Delegation events carry workspaceId for workspace-room fan-out (delegation-service.ts:174,242; delegation.test.ts:284-302).
INV-18 Honest worker failure: worker status != completed throws, so the task fails instead of counting error text as output (swarm-runtime.ts:143-147).

# Runtime Domain — Inventory + Map
Scope: packages/server/src/runtime | Facades: runtime-gate.ts + context-gate.ts | READ-ONLY PHASES 1-4

## Facades (exact)
- runtime-gate.ts: re-exports RuntimeExecutor, RuntimeRouter, interpret, ContextAssembler, RuntimeKernel, ProviderRegistry, Google/Anthropic/OpenAI/Ollama/Custom adapters, Conversational/Agentic/Swarm/Coding/Research/Base runtimes, contextPipeline, ContextPipelineManager, agentCompleteTool, AGENT_COMPLETE, isLifecycleTool + types (ExecuteRequest, RoutingContext, AssembleOptions, ContextPacket, InterpreterOutput, InteractionMode, RuntimePacket, RuntimeResult, RuntimeEvent, RuntimePolicy, RuntimeType, IRuntime, LLMRequest, LLMResponse, RawToolCall, ToolCallRecord, ModelModuleConfig, IProviderAdapter, HistoryMessage, ContextBuildContext, MutableContextPacket, IContextMiddleware, LLMToolDefinition, AgentCompleteInput). runtimeGate ports: init, execute, route, interpret, assembleContext, useMiddleware, registerProvider, getProvider, hasProvider, isLifecycleTool, agentCompleteTool, invalidateModelModuleCache.
- context-gate.ts: re-exports contextPipeline, ContextPipelineManager, ContextAssembler, runtimeGate + types. NOTE: re-exports runtimeGate wholesale (see B-09).
- index.ts: export * from runtime-gate.js.

## Files
- root: types.ts, runtime-router.ts, runtime-executor.ts, interpreter.ts, agent-control-tools.ts
- kernel/: runtime-kernel.ts, context-assembler.ts, context-pipeline-manager.ts, context-types.ts, context-budget.ts, re-act-stream-parser.ts, middlewares/ x10 (constraint-safety 10, instruction-stack 15, identity-authority 20, channel-awareness 21, skill-context 30, tool-schema 40, memory-retrieval 60, visibility-matrix 70, history-compression 80, context-limit 85)
- providers/: index.ts (registerProviders x5), provider-registry.ts (Map register/get/has/list), anthropic/google/open-ai/ollama/custom adapters, provider-http.ts, provider-errors.ts, tool-provider-adapter.ts, __fixtures__/sse-fixtures.ts
- runtimes/: base-runtime.ts (abstract + quiet-kernel + persistMemories/stateless opts), conversational/agentic/coding/research/swarm-runtime.ts
- bridges/: pi-event-bridge.ts, pi-tool-bridge.ts

## Execution map (caller -> gate port -> impl)
userInput -> register-socket-server.ts:323 executeRun defaults to runtimeGate.execute(req) -> RuntimeExecutor.execute() [runtime-executor.ts:60]
 -> interpret() [interpreter.ts:31 lexical CODING/RESEARCH_RE + MENTION_RE] -> RuntimeRouter.route/decide [runtime-router.ts:107 precedence explicit>librarian>pin>intent>tier + applyRollback RESEARCH_V1/SWARM_V1]
 -> runsGate.getById/create + stateGate.applyRunTransition walk [runtime-executor.ts:88/197/239] + 15s touchRunHeartbeat [136]
 -> ContextAssembler.assemble [kernel/context-assembler.ts:53] -> contextPipeline.assemble [kernel/context-pipeline-manager.ts:74] -> 10 middlewares + model resolve via moduleGate.model.get + decrypt [100-130] -> packet (policies.allowToolCalls agentic/coding/research/swarm; allowSpawn/Delegation swarm-only [63-67])
 -> runtimeMap[type].execute(packet, broker): conversational single callLLM+persist; agentic loop maxIterations + enforcePerIterationBudget + toolsGate + agent_complete; coding/research variants; swarm plan->swarmGate.createTasks->workers (quiet kernel)->aggregate
 -> RuntimeKernel.callLLM [kernel/runtime-kernel.ts:59 ProviderRegistry.get(provider).call + stream coalesce STREAM_BATCH_MS + ReAct parse] / persistMessage via messageGate.append [198]
 -> closeRun [executor 206: completed->completing/verifying/completed; cancelled->cancelling/cancelled; else failed] + fire-and-forget TokenTracker.trackUsage [152]
Persistence: runsGate (create/getById/touchHeartbeat/touchCheckpoint/addCompensation/buildCompensationInverse), stateGate.applyRunTransition (sole mutator), messageGate.append, moduleGate.model.get, memories createMemoryNote (reflection HQ3), swarmGate (loadWorkerCandidates/plan/createTasks/deleteByRun/isV1Enabled).
Events/routes/jobs/config: broker emit tool:start/complete, agent:thinking/status, message:stream/new, loop:detected, budget:exceeded; worker.ts:30 runtimeGate.init(); studio.ts:160 invalidateModelModuleCache + :201 contextPipeline.assemble DIRECT (bypass, B-10); module-service.ts:98 invalidateModelModuleCache; socket type RunExecutor=typeof runtimeGate.execute [:312]; queue/run-worker.ts + routes/runs.ts import gate (run lifecycle consumers); config flags RESEARCH_V1/SWARM_V1/PER_ITERATION_BUDGET/STREAM_BATCH_MS.


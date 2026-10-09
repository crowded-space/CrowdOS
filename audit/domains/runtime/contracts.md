# Runtime Domain — Contracts (facade truth)
Source: runtime-gate.ts + context-gate.ts. Code is truth; no drift vs impl found in port list.

## runtimeGate ports -> impl
| Port | Signature | Impl |
|---|---|---|
| init | () => void | registerProviders() x5 adapters |
| execute | (req: ExecuteRequest) => Promise<RuntimeResult> | RuntimeExecutor.execute: interpret->route->openRun/walk->assemble->runtime.execute->closeRun |
| route | (ctx: RoutingContext) => RuntimeType | RuntimeRouter.route/decide + logMetric router.decision |
| interpret | ({content, explicitRuntime}) => InterpreterOutput | interpreter.ts lexical stabilize only |
| assembleContext | (opts: AssembleOptions) => Promise<ContextPacket & {_modelConfig}> | ContextAssembler.assemble via contextPipeline |
| useMiddleware | (mw: IContextMiddleware) => this | contextPipeline.use + resort |
| registerProvider/getProvider/hasProvider | adapter/name | ProviderRegistry Map (get throws when missing) |
| isLifecycleTool | (name) => boolean | name === agent_complete |
| agentCompleteTool | LLMToolDefinition | agent_complete {response} schema |
| invalidateModelModuleCache | (moduleId?) => void | TtlCache prefix clear |

## ExecuteRequest / RoutingContext / ContextPacket / RuntimeResult
ExecuteRequest {agent, channelId, workspaceId, userInput, broker, preferredRuntime?, explicitRuntime?, librarianAgentId?, abortSignal?, runId?, resumeContext?}.
RoutingContext {agent, channelName?, preferredRuntime?, explicitRuntime?, librarianAgentId?, interpreterOutput?}. Precedence: explicit > librarian > pin (tier-gated) > intent (tier-gated) > tier default. Rollback: research/swarm -> agentic when flag off, reason=rollback.
RuntimeResult {requestId, agentId, channelId, finalResponse, internalMonologue?, toolCalls?, memoryCandidates?, artifacts?, runtimeEvents, usage, status: completed|failed|loop_detected|budget_exceeded|cancelled}.

## External gate dependencies (all gate-to-gate OK)
runsGate (create/getById/touchHeartbeat/touchCheckpoint/addCompensation), stateGate.applyRunTransition (dynamic import, cycle-avoid), messageGate.append, moduleGate.model.get (dynamic import, cycle-avoid), toolsGate/toolRegistry, swarmGate (loadWorkerCandidates/plan/createTasks/deleteByRun/isV1Enabled), memoriesGate.createMemoryNote (dynamic), observabilityGate.startSpan/endSpan (dynamic, nullable), filesystemGate (tests), agentGate types only.
Direct-domain violation: routes/studio.ts:201 calls contextPipeline.assemble directly (bypasses assembleContext port). See ledger B-10.

## Events emitted (via broker)
agent:thinking, agent:status, message:stream, message:new, tool:start, tool:complete, loop:detected, budget:exceeded, delegation:start, spawn:start (type union; spawn/delegation only swarm path).


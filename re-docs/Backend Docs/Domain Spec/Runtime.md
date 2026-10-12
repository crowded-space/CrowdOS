# Runtime

## Purpose
Agent execution engine. It routes each request to a runtime flavor, assembles the LLM-ready context packet through the middleware pipeline, drives provider adapters (streaming, tool loops, checkpoints), and opens/closes the Runs row around the work — while Queue owns delivery and Runs owns the row.

## Feature Scope
In-scope:
- Semantic interpretation (`interpret`: raw @-targets, mode hint, execution hints — lexical only, no planning/tools/memory).
- Request routing (`RuntimeRouter`: explicit override → librarian/tag match → authority-level default, with research/swarm rollback pins).
- Run bookkeeping around execution: open (`created → starting → running`), resume walks, close (`completing → verifying → completed` / `failed` / `cancelling → cancelled`), 15s heartbeat, per-tool checkpoint touches.
- Context assembly via `ContextAssembler` + the 10-middleware pipeline (identity, instructions, tools, memory, limits).
- Five runtime flavors: conversational (single call), agentic (tool loop), coding (pi-core session), research (decompose → search → synthesize), swarm (plan → DAG → aggregate).
- Provider registry + 5 adapters (google, anthropic, openai, ollama, custom) with streaming coalescing, pre-stream retry, and timeout guards.
- Lifecycle tool `agent_complete`, per-iteration context budget, token-usage accounting handoff.
Division of labor (Runs vs Queue vs Runtime):
- Runs owns run rows, the transition state machine, checkpoints, and compensation — Runtime only calls `runsGate` ports and emits `run.status_changed` per hop; it never writes run tables directly.
- Queue owns delivery: jobIds, retries, repeatables, worker slots — Runtime never enqueues except the Research sub-run trace hook; it just executes what it is handed.
- Runtime owns everything between run-open and run-close: routing, context, LLM calls, tool loops, message persistence, status flips, usage tracking.
Non-goals (other domains):
- Queue transport/retries/repeatables → Queue (`queueGate.enqueueRun`, `scheduleMaintenance`).
- Run state guard/checkpoint merge semantics → Runs (`applyTransition`, `touchCheckpoint`).
- Tool implementations, approval gating, R/W classification → Tools (`toolsGate.executeBatch`, `tool-executor.ts`).
- Web search backends → SearchProviders (Runtime only consumes `searchProviderGate.search`).
- Swarm DAG storage/dispatch → Swarm (`swarmGate.plan/dispatch`); memory persistence → Memories; artifact storage → Artifacts.
- Agent CRUD/retention → Agents; message transport/auth → Routes/Sockets (they call `runtimeGate.execute`, never embed logic).

## Expect
- [Observed] Every `execute` opens or adopts exactly one run row; a state-machine-rejected walk throws and refuses to execute with stale state (`runtime-executor.ts:111`, `runtime-executor.ts:251-252`).
- [Observed] `RESEARCH_V1=false` / `SWARM_V1=false` pins research/swarm → agentic once in the router; the executor trusts `resolvedType` with no flag checks (pin-once).
- [Observed] Unknown `resolvedType` falls back to agentic with a warning, never throws (`runtime-executor.ts:80-84`).
- [Observed] `execute` itself never rejects on agent failure: unexpected errors close the run as `failed` and return a failed `RuntimeResult` with `requestId: 'error'` (`runtime-executor.ts:194`).
- [Observed] User cancel is not failure: any `abortSignal.aborted` path returns `status: 'cancelled'` with zeroed usage and persists nothing extra (`base-runtime.ts:72`, `agentic-runtime.ts:52`).
- [Observed] Agentic resume skips re-execution of `completedCallIds` and marks them `[resumed]` in-order; ordering of results is always call order regardless of read/write concurrency (`agentic-runtime.ts:161`, `agentic-runtime.ts:187`).
- [Observed] Tool output fed back into history is clamped to 8000 chars with an omission note — unbounded output never re-rides every subsequent call (`agentic-runtime.ts:14`, `agentic-runtime.ts:227`).
- [Observed] `ProviderRegistry.get` throws when no adapter is registered for the packet's provider — a misconfigured model module fails the run, not the process (`provider-registry.ts:10`).
- [Observed] The agent's model module is resolved with the execution workspace before adapter selection; an unassigned module or missing workspace row keeps the built-in Google default (`context-pipeline-manager.ts:79-125`).
- [Inferred] `closeRun` is awaited inline at settle and on failure (`runtime-executor.ts:146`, `runtime-executor.ts:174`): finalization does not race the response return.
- [Inferred] Token tracking is best-effort off the hot path — budget enforcement downstream may lag or drop usage on process crash (`runtime-executor.ts:174`).

## Flow
0. Interpret: `execute` stabilizes intent via `interpret({ content, explicitRuntime })` — raw @-tokens, mode hint (explicit wins, else lexical coding/research, else `auto`), execution hints (`multi-target`, `lock_in-requested`, `code-context`); bare input is `ambiguous` with the refused assumption listed (`runtime/interpreter.ts`). The Router stays authoritative — intent rides `packet.interpreterOutput` for runtimes, routing precedence unchanged.
1. Route: `runtimeGate.route` delegates to the singleton router (`runtime-gate.ts:119`); explicit `explicitRuntime` wins (with research/swarm rollback pins), else librarian-agent match → channel-tag match (`coding|dev`, `research|data`, `swarm|ops`) → authority level (L0-1 agentic, L2 swarm-or-agentic, L3+ conversational) (`runtime-router.ts:21`, `runtime-router.ts:36`, `runtime-router.ts:59`).
2. Executor pins: `execute` re-pins research/swarm → agentic when flags are off, resolves the runtime map (research maps to the shared agentic instance when disabled, hot-swapped per call), and falls back to agentic for unknown types (`runtime-executor.ts:49`, `runtime-executor.ts:80-84`).
3. Run adoption: with `requestedRunId`, the executor fetches the row; `resumeContext` + `queued` walks `starting → running`, `resumeContext` + `resumable` walks `queued → starting → running`, other non-running states throw; fresh `created/queued/starting` rows are adopted and walked, never duplicated; missing row + `resumeContext` throws, missing row without it opens a new run (`runtime-executor.ts:111`).
4. Open: `openRun` creates the row (`status created`) then walks `starting → running`, one `runsGate.transition` per hop with `run.status_changed` emitted only on `changed` hops (`runtime-executor.ts:187-199`, `state-gate.ts:23-31`).
5. Assemble: `assembler.assemble` runs `contextPipeline.assemble`, resolves the agent's model module through `moduleGate.model.get(id, ctx.workspaceId)` under a DB+module+workspace cache key, and only retains the built-in `google`/Gemini default when no row resolves; then it overrides `allowToolCalls` (agentic/coding/research/swarm only), `allowSpawn`/`allowDelegation` (swarm only), stamps a fresh `randomUUID` requestId, and attaches `runId` + `abortSignal` (`context-assembler.ts:49`, `context-assembler.ts:58`, `runtime-executor.ts:141`); resume packets also carry `resumeContext` (`runtime-executor.ts:150`).
6. Heartbeat: a 15s `touchRunHeartbeat` interval (unref'd) guards the run against the orphan sweep for the whole execution, cleared in `finally` (`runtime-executor.ts:131-144`).
7. Conversational: cancel-check → working + thinking → one `callLLM` → persist thoughts (internal) + content → idle → `completed` (`conversational-runtime.ts:12`, `conversational-runtime.ts:31`).
8. Agentic loop: working + thinking, then per iteration (max `policies.maxIterations`): abort-check → snapshot history → `enforcePerIterationBudget` (preview dropped after iteration 1 unless `PER_ITERATION_BUDGET=false`) → `callLLM` → accumulate usage → persist thoughts + fire-and-forget reflection note → `agent_complete` native call breaks with its `response` → executable calls run via `toolsGate.executeBatch` (resume-skipped ids short-circuit) → `tool:start`/`tool:complete` emits, clamped tool-result persisted as internal message with structured record, checkpoint touched per callId, outcome appended as `tool` history → repeat; final visible message persisted, idle, `completed` (or `cancelled` when aborted) (`agentic-runtime.ts:35`, `agentic-runtime.ts:67`, `agentic-runtime.ts:107`, `agentic-runtime.ts:174`, `agentic-runtime.ts:202`, `agentic-runtime.ts:248`, `agentic-runtime.ts:278`).
9. Coding: cancel-check → working + thinking → builds a `PiModelAdapter` over the registered provider adapter and runs an `@crowdos/pi-core` `AgentSession`; file writes emit `sandbox:updated` via the global broker; ends idle with `completed`/`failed`/`cancelled` (`coding-runtime.ts:58`, `coding-runtime.ts:88`, `coding-runtime.ts:243`, `coding-runtime.ts:436`).
10. Research: working + thinking → decompose query to sub-questions (LLM or template) → bounded pool (max 3) of isolated sub-runs, each creating an optional child run row and calling `searchProviderGate.search(subQ, { limit: 8, timeoutMs: 6000 })` with top-2 fetch enrichment; raw snippets never touch `packet.history` → URL+similarity dedupe → freshness sort → `EvidenceBundle` → synthesis LLM → token-delta warn check → persist `citations` + `report` artifacts (best-effort) → persist report as the sole visible message → idle (`research-runtime.ts:386`, `research-runtime.ts:414`, `research-runtime.ts:447`, `research-runtime.ts:495`, `research-runtime.ts:556`, `research-runtime.ts:591`, `research-runtime.ts:618`, `research-runtime.ts:626-636`).
11. Swarm: `SWARM_V1` off delegates wholesale to `AgenticRuntime`; on: supervisor plan → wipe + create `swarm_tasks` → DAG-respecting leaf dispatch via per-task `callLLM` worker executor → aggregate/verify/report → idle (`swarm-runtime.ts:13`, `swarm-runtime.ts:39`, `swarm-runtime.ts:47`, `swarm-runtime.ts:63`).
12. LLM call: `RuntimeKernel.callLLM` resolves the adapter from `packet.metadata.provider`, streams chunks through the `STREAM_BATCH_MS` coalescer (`message:stream`), falls back to `ReActStreamParser` when no native tool calls exist, and records `llm.call` timings (`runtime-kernel.ts:75`, `runtime-kernel.ts:112`, `runtime-kernel.ts:257`).
13. Persist/status: `messageGate.append` reserves the channel sequence and inserts atomically in one transaction, then emits `message:new` (`message-service.ts:387-406`); the insert carries nullable `workspace_id` from the packet (migration `0016`; absent on older writers → NULL); `agentGate.setStatus` flips `agents` + `runtimeStates` atomically, refreshes the heartbeat and lease, and emits `agent:status` (`agent-service.ts:250-273`). The kernel keeps only tracing/metrics/streaming around both calls (`runtime-kernel.ts:154-206`).
14. Close + accounting: `closeRun` walks `completing → verifying → completed`, `cancelling → cancelled`, or direct `failed` (`runtime-executor.ts:206-229`); usage is handed to `TokenTracker.trackUsage` in a detached async block (`runtime-executor.ts:174`).
15. Provider resilience: pre-stream connect/network failures retry twice with 1s/2s backoff; post-stream-start failures and caller aborts never retry (`base-runtime.ts:124`); provider HTTP layers enforce connect/idle timeouts around every fetch (`provider-http.ts:20`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `runtime/runtime-gate.ts` | Facade: lazy singletons (executor/router/assembler), class + type re-exports, `initRuntime`, `runtimeGate` ports (incl. `interpret`) |
| `runtime/interpreter.ts` | Pure `interpret`: §24 stabilization (targets/mode/hints), no I/O, no planning |
| `runtime/runtime-executor.ts` | `execute`: interpret → route → run adopt/open → assemble (+`interpreterOutput`) → heartbeat → dispatch → close + usage |
| `runtime/runtime-router.ts` | Pure routing: override → librarian/tags → authority level, with flag pins |
| `runtime/types.ts` | `ContextPacket`, `RuntimePacket` (alias), `RuntimeResult`, `RuntimeType`, `IRuntime`, `IProviderAdapter`, `LLMRequest/Response`, history/tool types |
| `runtime/kernel/runtime-kernel.ts` | `callLLM` + streaming coalescer, transactional `persistMessage`, `setAgentStatus`, thinking/events, failed-result builder |
| `runtime/kernel/context-assembler.ts` | `ContextAssembler`: pipeline call + policy overrides + runId/abortSignal stamping |
| `runtime/kernel/context-pipeline-manager.ts` | 10-middleware pipeline, workspace-scoped model-module resolve + decrypt + 30s workspace-aware cache, parallel lane |
| `runtime/kernel/context-budget.ts` | Token accounting, cap resolution, history trim, per-iteration enforcement |
| `runtime/runtimes/base-runtime.ts` | Abort mapping, error-message persist, pre-stream retry, reflection-note helper |
| `runtime/runtimes/conversational-runtime.ts` | Single-call runtime, no tools |
| `runtime/runtimes/agentic-runtime.ts` | Tool-loop runtime with resume skip, checkpoint touches, budget re-check |
| `runtime/runtimes/coding-runtime.ts` | pi-core session runtime with patch/diff + sandbox emits |
| `runtime/runtimes/research-runtime.ts` | Decompose → isolated search → evidence bundle → synthesis → artifacts |
| `runtime/runtimes/swarm-runtime.ts` | Swarm delegation: plan → tasks → leaf workers → aggregate |
| `runtime/providers/` | Registry + google/anthropic/openai/ollama/custom adapters + HTTP timeout guard + error types |
| `runtime/agent-control-tools.ts` | `AGENT_COMPLETE` name, `isLifecycleTool`, completion tool definition |
| `runtime/bridges/` | pi-core tool/event bridges (coding stream + tool parity) |

## Ports
- `RuntimeExecutor` — end-to-end execution class.
- `RuntimeRouter` — routing class.
- `interpret` — pure intent stabilizer (`{ content, explicitRuntime? } → InterpreterOutput`).
- `InterpreterOutput` — `{ targets, mode, executionHints, ambiguous, assumptions }` (§26 `interpreter_output`).
- `InteractionMode` — `chat | agentic | coding | research` type.
- `ContextAssembler` — context assembly class.
- `RuntimeKernel` — LLM-call, persist, status, streaming kernel class.
- `ProviderRegistry` — adapter registry (`register/get/has/list`).
- `GoogleAdapter` — `provider: 'google'` adapter.
- `AnthropicAdapter` — `provider: 'anthropic'` adapter.
- `OpenAIAdapter` — `provider: 'openai'` adapter.
- `OllamaAdapter` — `provider: 'ollama'` adapter.
- `CustomAdapter` — `provider: 'custom'` OpenAI-compatible adapter.
- `ConversationalRuntime` — single-call runtime class.
- `AgenticRuntime` — tool-loop runtime class.
- `SwarmRuntime` — swarm runtime class.
- `CodingRuntime` — pi-core session runtime class.
- `ResearchRuntime` — evidence-bundle research class.
- `BaseRuntime` — shared abstract base (abort mapping, pre-stream retry).
- `contextPipeline` — shared pipeline manager singleton.
- `ContextPipelineManager` — pipeline class.
- `agentCompleteTool` — completion tool definition.
- `AGENT_COMPLETE` — `'agent_complete'` name constant.
- `isLifecycleTool` — true for lifecycle tool names.
- `ExecuteRequest` — `{ agent, channelId, workspaceId, userInput, broker, channelTags?, explicitRuntime?, librarianAgentId?, abortSignal?, runId?, resumeContext? }`.
- `RoutingContext` — router input type.
- `AssembleOptions` — assembler input type.
- `ContextPacket` — assembled packet type (plus `_modelConfig`, `runId`, `resumeContext`, `interpreterOutput` at runtime).
- `RuntimePacket` — spec §26 alias of `ContextPacket` (both names compile; `interpreter_output` landed, remaining future: `visible_capabilities`, `state_updates`, `artifacts`).
- `RuntimeResult` — `{ requestId, agentId, channelId, finalResponse, runtimeEvents, usage, status }` (+ `toolCalls?`, `internalMonologue?`, `memoryCandidates?`).
- `RuntimeEvent` — typed event envelope.
- `RuntimePolicy` — budgets/permission flags type.
- `RuntimeType` — `conversational | agentic | swarm | coding | research`.
- `IRuntime` — `{ type, execute(packet, broker) }` interface.
- `LLMRequest` — provider request type.
- `LLMResponse` — provider response type.
- `RawToolCall` — raw model tool-call type.
- `ToolCallRecord` — recorded tool-call type.
- `ModelModuleConfig` — resolved provider/model config type.
- `IProviderAdapter` — provider interface (`call`, `supportsStreaming`, `supportsTools`).
- `HistoryMessage` — history entry type.
- `ContextBuildContext` — pipeline build-context type.
- `MutableContextPacket` — in-assembly packet type.
- `IContextMiddleware` — middleware interface.
- `LLMToolDefinition` — tool schema type.
- `AgentCompleteInput` — `{ response }` completion input.
- `initRuntime` — registers all five adapters at boot.
- `runtimeGate.init` — same as `initRuntime`.
- `runtimeGate.execute` — singleton-executor `execute`.
- `runtimeGate.route` — singleton-router `route`.
- `runtimeGate.interpret` — pure `interpret` via the gate.
- `runtimeGate.assembleContext` — singleton-assembler `assemble`.
- `runtimeGate.useMiddleware` — appends middleware to the shared pipeline (note: named `useMiddleware`, not `use`).
- `runtimeGate.registerProvider` — registers an adapter.
- `runtimeGate.getProvider` — gets an adapter by name (throws when missing).
- `runtimeGate.hasProvider` — true when an adapter exists.
- `runtimeGate.isLifecycleTool` — lifecycle-name check.
- `runtimeGate.agentCompleteTool` — completion tool definition.
- `runtimeGate.invalidateModelModuleCache` — prefix-invalidates cached model-module configs by id across workspaces, or clears the full cache when no id is given.

## Relations
Gates this domain calls:
- `runs-gate.ts` — `create/getById/transition/touchCheckpoint/touchRunHeartbeat` from executor, agentic loop, and research child-run traces (`runtime-executor.ts:3`, `agentic-runtime.ts:251`, `research-runtime.ts:452`).
- `message-gate.ts` — `messageGate.append` for every agent/tool/final persist; the kernel keeps tracing/metrics/streaming but never inserts into `messages` directly (`runtime-kernel.ts:154-197`).
- `agent-gate.ts` — `agentGate.setStatus` for every working/idle flip; the kernel never writes `agents`/`runtime_states` directly (`runtime-kernel.ts:199-206`).
- `tools-gate.ts` — `toolsGate.executeBatch` for agentic tool calls (`agentic-runtime.ts:174`).
- `swarm-gate.ts` — `isV1Enabled/plan/dispatch/createTasks/deleteByRun` from the swarm runtime (`swarm-runtime.ts:4`).
- `artifacts-gate.ts` — `create` for research `citations` + `report` artifacts, best-effort (`research-runtime.ts:537`, `research-runtime.ts:575`).
- `memories-gate.ts` — `createMemoryNote` for fire-and-forget reflection notes (`base-runtime.ts:34`).
- `search-provider-gate.ts` — `search` (+ `normalizeUrl`) from the research runtime (`research-runtime.ts:4`).
- `event-broker-gate.ts` — type-only; live brokers are passed in by callers, never constructed here (Queue constructs per job).
- `module-gate.ts` — dynamic `moduleGate.model.get(id, ctx.workspaceId)` inside the context pipeline, keeping model rows behind Modules and the lookup scoped to the executing workspace.
- Non-gate internals used: `db/schema.ts` (`modelModules` direct reads for the pipeline), `shared/config/database.ts` (`withTransaction`), `shared/core/sequence-number.ts` + `ulid.ts` (via `messageGate.append`), `shared/core/agent-heartbeat.ts` (no longer — lease marks moved into `agentGate.setStatus`), `shared/core/token-tracker.ts` (`TokenTracker.trackUsage`), `shared/core/model-routing.ts` (log-only routing), `shared/core/secret-box.ts` (key decrypt), `observability/tracing.ts` (spans), `@crowdos/pi-core` (coding session).
Verified outside callers of `runtimeGate`:
- Queue: `queue/run-worker.ts` (`execute` per job).
- Sockets: `Shared/sockets/register-socket-server.ts` (injectable `executeRun`, defaults to `runtimeGate.execute`).
- Routes: `routes/runs.ts` (inline resume `execute`); `routes/studio.ts` (`invalidateModelModuleCache`, direct `contextPipeline.assemble` for inspect-prompt).
- Boot: `worker.ts` + `create-app.ts` (`initRuntime`); `index.ts` sweeper paths.
- Modules: `modules/module-service.ts` (`invalidateModelModuleCache` on model-module update/delete).
Tables owned elsewhere, written only through owner gates (never direct):
- `messages` via `messageGate.append` (agent/tool/final rows; socket/agent/tool/queue/thread/librarian/tracker rows go through the same port).
- `agents` + `runtime_states` via `agentGate.setStatus` (working/idle flips with heartbeat; CRUD/lifecycle/orphan-sweep stay in Agents).
- `model_modules` (pipeline reads config; Modules owns writes).
- `swarm_tasks` (swarm runtime wipes/creates per run; Swarm owns the table).

## Emits-Listens
- `run.status_changed` (emits, per walked hop)
- `message:new` (emits, thought/tool-result/final persists)
- `message:stream` (emits, coalesced token chunks)
- `agent:status` (emits, working/idle flips)
- `agent:thinking` (emits, execution start)
- `tool:start` (emits, per executable call, agentic + pi bridge)
- `tool:complete` (emits, per tool result, agentic + pi bridge)
- `sandbox:updated` (emits, coding file writes)

## Owns
- No table or queue outright and no direct table writes. `messages` persists via `messageGate.append`, status flips via `agentGate.setStatus` — see Relations.

## Flags
- `RESEARCH_V1` — `true` enables `ResearchRuntime`; default `false` pins research → agentic (`runtime-executor.ts:42`).
- `SWARM_V1` — `true` enables swarm DAG path; default `false` pins swarm → agentic (`runtime-executor.ts:46`).
- `STREAM_BATCH_MS` — stream coalesce window, default 50; `0` restores per-token emission (`runtime-kernel.ts:28`).
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` — google fallback chain (adapter + pipeline default) (`google-adapter.ts:214`, `context-pipeline-manager.ts:81`).
- `ANTHROPIC_API_KEY` — anthropic fallback (`anthropic-adapter.ts:17`).
- `OPENAI_API_KEY` — openai fallback (`open-ai-adapter.ts:17`).
- `OLLAMA_API_KEY` — ollama fallback (`ollama-adapter.ts:17`).
- `CUSTOM_API_KEY` — custom-adapter fallback (`custom-adapter.ts:17`).
- `PER_ITERATION_BUDGET` — `false` disables per-iteration re-check (assembly-time cap only, preview every iteration) (`agentic-runtime.ts:35`).
- `PIPELINE_PARALLEL` — `false` forces serial middleware execution (`context-pipeline-manager.ts:167`).
- `PROVIDER_CONNECT_TIMEOUT_MS` — headers deadline, default 10000 (`provider-http.ts:20`).
- `PROVIDER_IDLE_TIMEOUT_MS` — inter-chunk deadline, default 120000 (`provider-http.ts:20`).

## Decisions
- [Observed] Pin-once in the router — neither explicit overrides nor tag matches can slip into a disabled runtime, and the executor holds no flag checks.
- [Observed] `created → starting → running` is walked one durable transition per hop with an emit each — the honest chain replaces a single jump (`runtime-executor.ts:195-199`).
- [Observed] Resume reuses the caller's row and skips completed call ids instead of re-executing — crashed runs resume without redoing finished tool work (`runtime-executor.ts:117`, `agentic-runtime.ts:161`).
- [Observed] Stale-state refusal: any rejected walk throws rather than executing against a row another writer moved (`runtime-executor.ts:251-252`).
- [Observed] Stale-state refusal: any rejected walk throws rather than executing against a row another writer moved (`runtime-executor.ts:251-252`); reusing a non-running row without a walk now throws too (B-02 fixed, was warn-and-continue). Swarm cleanup failure fails the run instead of mixing stale rows with a new plan (B-03 fixed).
- [Observed] Stale-state refusal: any rejected walk throws rather than executing against a row another writer moved (`runtime-executor.ts:251-252`); reusing a non-running row without a walk now throws too (B-02 fixed, was warn-and-continue). Swarm cleanup failure fails the run instead of mixing stale rows with a new plan (B-03 fixed). Run reads + heartbeats thread the workspace handle (RUN-007 fixed).
- [Observed] Stale-state refusal: any rejected walk throws rather than executing against a row another writer moved (`runtime-executor.ts:251-252`); reusing a non-running row without a walk now throws too (B-02 fixed, was warn-and-continue). Swarm cleanup failure fails the run instead of mixing stale rows with a new plan (B-03 fixed). Run reads + heartbeats thread the workspace handle (RUN-007 fixed). Socket inline execution runs inside the message workspace ALS (XD-016 fixed).
- [Observed] Cancel is a first-class status threaded through abort signals, loop checkpoints, provider fetches, and run-close — never conflated with failure (`base-runtime.ts:72`).
- [Observed] Per-iteration budget re-check with newest-self-turn preservation stops O(n²) prompt growth in long tool loops (`context-budget.ts:127`, `agentic-runtime.ts:67`).
- [Observed] 8k tool-output clamp keeps history append-only but bounded — full fidelity stays in the persisted message, not the prompt (`agentic-runtime.ts:14`).
- [Observed] Research isolation: raw snippets never enter main history; only the synthesized report does, guarded by a token-delta warn and a leak invariant check (`research-runtime.ts:601`, `research-runtime.ts:611`).
- [Observed] Stream coalescing batches token emits per batch window and flushes on LLM completion — socket churn drops without losing trailing tokens (`runtime-kernel.ts:257`, `runtime-kernel.ts:307`).
- [Observed] Pre-stream-only retry (2×, 1s/2s): connect/network failures before the first chunk retry; mid-stream failures never do, avoiding duplicate side effects (`base-runtime.ts:124`).
- [Observed] Model-module configs are cached 30s/200-keys under `dbScope:modelModuleId:workspaceId`, invalidated by module-id prefix (or wholesale), and decrypted only at the single pipeline resolver — adapters never see ciphertext (`context-pipeline-manager.ts:24`, `context-pipeline-manager.ts:64-66`, `context-pipeline-manager.ts:89-123`).
- [Observed] Token accounting and reflection notes are detached from the hot path — usage/budget lag is accepted to keep responses fast (`runtime-executor.ts:148-160`, `base-runtime.ts:32`).
- [Inferred] Lazy gate singletons keep the facade importable without booting providers; `initRuntime` registration order (google first) only matters for the default-model fallback (`runtime-gate.ts:48`, `runtime-gate.ts:111`).

## User Decision:

## Architectural Standard (Target)

> Status: Target — documents the invariant new work must satisfy. Current code still contains the fail-open path noted in Failure + Resume; do not claim this as already implemented.

* Durable-run prerequisite: execute MUST open or adopt exactly one run row before any side-effecting work (LLM calls with tool loops, message persists, status flips, usage accounting). If run creation fails, execution MUST fail closed — it MUST NOT continue untracked with a null run.
* Explicit non-durable mode (if ever needed) MUST be a separately labelled path that cannot perform side effects; the default path is always durable.
* Research child-run creation MUST go through runsGate.create with parentRunId (no direct repository import). The Runs vs Runtime contradiction on this point is resolved in favor of the gate path; see Open Question in User Decision if an exception is desired.
* Close-walk observability: callers MUST be able to distinguish a pinned/routed fallback from genuine routing (log-only pins are insufficient for operators).

## User Decision (Open — awaiting operator choice)

* Q1: Is there any legitimate case for untracked execution (e.g. dry-run prompt inspection)? If yes, what explicit label and side-effect ban defines it? If no, confirm fail-closed as absolute.
* Q2: Confirm Research child runs always carry parentRunId via the gate — or document the sanctioned exception.

## Failure + Resume
- Routing: unknown type warns and falls back to agentic; disabled research/swarm pin silently with a log line — callers cannot distinguish pin from genuine routing (`runtime-executor.ts:80-84`).
- Run open failure: `openRun` catches, logs, and continues with `run: null` — execution proceeds untracked with no run row, heartbeat, or close walk (`runtime-executor.ts:216`).
- Stale run: rejected transition throws `refusing to execute with stale state`; top-level catch closes the (stale) run as `failed` with `EXECUTION_FAILED` and returns a failed result (`runtime-executor.ts:251-252`, `runtime-executor.ts:172-174`).
- Missing provider: `ProviderRegistry.get` throws inside `callLLM`; per-runtime catch resets status to idle and returns `buildFailedResult` (which persists a warning message) while the executor additionally closes the run failed (`provider-registry.ts:10`, `base-runtime.ts:91`).
- Model-module miss: an unassigned `modelModuleId` or a scoped read that returns no row keeps the built-in Google/Gemini default; a valid workspace row instead carries its stored provider through `packet.metadata.provider` (`context-pipeline-manager.ts:79-125`, `context-pipeline-manager.ts:225-227`).
- Cancel: abort at any checkpoint yields `cancelled` with zeroed usage; `closeRun` still walks `cancelling → cancelled` so the row reflects the cancel (`base-runtime.ts:72`, `runtime-executor.ts:214-221`).
- Checkpoint touches warn-and-continue (fire-and-forget); a lost touch only narrows resume granularity, never fails the run (`agentic-runtime.ts:248`).
- Token-track failures log only; the result is already returned (`runtime-executor.ts:148-160`).
- Research: child-run create/transition, search, fetch-enrich, and artifact stores are each individually best-effort — an empty evidence set still synthesizes and returns a report (`research-runtime.ts:450`, `research-runtime.ts:511`, `research-runtime.ts:602-604`).
- Coding: pi-core/bridge errors reset status to idle and return a failed result via `buildFailedResult` (`coding-runtime.ts:450`).
- Resume: only `queued`/`resumable` (+ already-`running`) rows execute; anything else throws stale-state; second resume of the same checkpoint re-skips the same call ids (idempotent by set-union) (`runtime-executor.ts:117`).

## Gaps
- Research `dedupeEvidence`/`sortByFreshness`/`decomposeQuery`/`synthesizeReport` helpers live in `research-runtime.ts` but are not gate ports — reuse requires importing past the gate (`research-runtime.ts:31`, `research-runtime.ts:66`).
- Research child-run creation bypasses the gate (`runsGate.create` has no `parentRunId`) and falls back to a direct `runs-repository` import — same bypass noted in Runs.md Gaps (`research-runtime.ts:454`, `research-runtime.ts:466`).
- Pipeline env-key fallback covers only google/anthropic/openai; ollama/custom rely solely on stored (decrypted) keys — whether intentional is unverified (`context-pipeline-manager.ts:101`).
- `model-routing.ts` resolution runs `logOnly: true` — routing decisions are observed but never applied; cutover semantics unknown (`context-pipeline-manager.ts:128`).
- `COMPOSER_MODE_TO_RUNTIME` maps `chat → conversational` and includes a `swarm` entry — composer-driven swarm routing uses the map entry (`runtime/types.ts:227-234`).
- `loop:detected` / `budget:exceeded` exist as `RuntimeEventType` values but no in-domain emit was found — emitters (loop-arbiter/token-tracker) were not traced to these events (`runtime/types.ts:171-172`).
- `memoryCandidates` on `RuntimeResult` is populated by no observed runtime — producer unknown (`runtime/types.ts:121`).
- `historyRef` resume (large-history offload) is threaded through types but no loader was observed — deep-history resume fidelity unverified (`runtime/types.ts:73-77`).
- `AgentSession` abort/lease interplay in the coding runtime (pi-core loop vs 15s heartbeat vs orphan sweep) was not traced end to end (`coding-runtime.ts:88`).
- `sandbox:updated` emit sites in coding vs tools were not exhaustively reconciled (who owns the sandbox feed) (`coding-runtime.ts:243`).

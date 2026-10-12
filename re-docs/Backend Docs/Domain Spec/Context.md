# Context

## Purpose
Prompt-construction half of Runtime: resolves the agent's model config, then runs the 10-middleware pipeline that turns `(agent, channel, userInput)` into an LLM-ready `ContextPacket` (system prompt, history, tools, policies, metadata). Pure assembly — no execution, no state writes.

## Feature Scope
In-scope:
- `ContextAssembler`: single-call wrapper that runs the shared pipeline, applies runtime-type policy flags, and stamps request/run/abort correlation.
- `ContextPipelineManager`: default middleware registration, priority ordering, model-module resolve + decrypt + TTL cache, parallel-lane vs serial-tail execution, per-middleware error isolation, prompt-block join.
- Context budget accounting: token estimation, cap resolution, history trim, per-iteration re-check helpers.
- Middleware contract (`IContextMiddleware`) and build/packet types.
Non-goals (other domains):
- Execution, run rows, heartbeats, provider calls → Runtime (`runtime-executor.ts`, `runtime-kernel.ts`, `runtimeGate.execute`).
- Delivery/retries → Queue; run state machine → Runs.
- Tool implementations/schemas source data → Tools and Skills (pipeline only embeds what their middlewares fetch).
- Memory storage/retrieval backends → Memories (`MemoryRetrievalMiddleware` only calls out).
- Model-module CRUD/encryption → Modules (pipeline only reads + decrypts + caches).
- Prompt inspection transport/auth → Routes (`routes/studio.ts` calls `contextPipeline` directly).

## Expect
- [Observed] Middleware failures never abort assembly: each `process` is individually try/caught, logged, and skipped (`context-pipeline-manager.ts:168`).
- [Observed] Prompt-block order is precedence, not registration order: blocks sort by `priority` ascending, with `safety_constraints(10) > instruction_stack(15) > identity_authority(20)` asserted by integrity tests (`context-pipeline-manager.ts:192-193`, `context-assembler.ts:12`).
- [Observed] Model resolution precedence: explicit `ctx.modelConfig` wins; else the agent's `modelModuleId` row resolved workspace-scoped via `moduleGate.model.get(id, ctx.workspaceId)` (cached 30s/200-keys under a DB+module+workspace key); else assembly rejects with `MODEL_MODULE_NOT_CONFIGURED` — no provider, model, or key default is assumed (`context-pipeline-manager.ts`).
- [Observed] Env-key fallback covers only google/anthropic/openai rows; other providers depend entirely on the stored (decrypted) key (`context-pipeline-manager.ts:101`).
- [Observed] `ContextAssembler` always mints a fresh `randomUUID` requestId — the pipeline's `ctx_${Date.now()}` id never survives assembly (`context-assembler.ts:67`, `context-pipeline-manager.ts:194`).
- [Observed] Policy flags are derived from `runtimeType`, then `policyOverrides` win over everything (`context-assembler.ts:58`).
- [Observed] Parallel lane is priority `<= 70`; `HistoryCompression (80)` and `ContextLimit (85)` always run sequentially last because they consume assembled history/metadata (`context-pipeline-manager.ts:21`, `context-pipeline-manager.ts:176`).
- [Observed] `PIPELINE_PARALLEL=false` restores the legacy fully-serial loop with identical per-middleware error semantics (`context-pipeline-manager.ts:183`).
- [Inferred] The pipeline never writes: model-module misses only populate the in-memory TTL cache; no DB table is mutated on any path.
- [Observed] §12 lock state is DURABLE and WORKSPACE-SCOPED: `agentLockStore` persists to `<workspaceFolder>/vfs/.crowdos/locks/<workspaceId>/locks.json (canon 2026-09-22)` keyed `<channelId>:<agentId>` instead of an in-process Map, so `lock_in` survives a restart and applies in the bullmq worker process too. `VisibilityMatrixMiddleware` (70) and `ChannelAwarenessMiddleware` (21) `await` the lookup — the store is file-backed, and the await does not move either stage across the parallel-lane boundary (both are `<= PARALLEL_LANE_MAX_PRIORITY`).
- [Observed] A channel with no resolvable workspace (unknown row, dead gate, no DB) resolves to the documented `UNSCOPED_WORKSPACE` (`"__unscoped__"`) scope rather than throwing — the local-first path where channel rows may not exist yet still enforces lock state, and it can never merge into a real workspace's file.
- [Observed] `lock_in`/`lock_out` (`tool-registry.ts`) call the same store, so a lock taken by a tool is immediately visible to both middlewares and to any process reading the same workspace store.

## Flow
1. Entry: `ContextAssembler.assemble({ agent, channelId, workspaceId, userInput, runtimeType, policyOverrides?, abortSignal?, runId? })` opens an `assemble` tracing span keyed by runId, then delegates to `contextPipeline.assemble` (`context-assembler.ts:42`, `context-assembler.ts:49`).
2. Model default: without `ctx.modelConfig`, the pipeline starts from google/`gemini-2.0-flash`/0.7/2048/`topP` 0.95 with `GEMINI_API_KEY || GOOGLE_API_KEY` (`context-pipeline-manager.ts:81`).
3. Module resolve: with `agent.modelModuleId`, it checks the DB+module+workspace-keyed 30s/200-entry `TtlCache`, else loads the `modelModules` row workspace-scoped via `moduleGate.model.get(id, ctx.workspaceId)`, picks the env fallback by provider, decrypts the stored key (single choke point feeding adapters), and caches the result (`context-pipeline-manager.ts:91`, `context-pipeline-manager.ts:109`, `context-pipeline-manager.ts:120`).
4. Routing note: when routing is enabled, `resolveModelModule` runs `logOnly: true` — the decision is logged, the pinned module is kept (`context-pipeline-manager.ts:128`).
5. Packet seed: a `MutableContextPacket` starts empty (blocks/tools/history) with default policies (128k budget, 10 iterations, tool calls on, spawn/delegation off, loop detection + streaming on) (`context-pipeline-manager.ts:142`).
6. Middleware run: `PIPELINE_PARALLEL !== 'false'` runs priorities `<= 70` concurrently and the tail sequentially; otherwise all run in priority order; every stage is error-isolated (`context-pipeline-manager.ts:167`, `context-pipeline-manager.ts:176`, `context-pipeline-manager.ts:183`).
7. Join: blocks sort by priority and join with `\n\n`; history entries are re-mapped (dropping internal-only fields); the final packet carries `requestId: ctx_${Date.now()}`, metadata (runtimeType/provider/model/startedAt), and `_modelConfig` (`context-pipeline-manager.ts:192-193`).
8. Assembler finish: policies are re-derived (`allowToolCalls` for agentic/coding/research/swarm; `allowSpawn`/`allowDelegation` for swarm only; `policyOverrides` last), the packet is rebuilt with a `randomUUID`, `memoryPreviewBlock` passthrough, `_modelConfig`, `abortSignal`, and `runId`, and the span closes with history/tool counts (`context-assembler.ts:58`, `context-assembler.ts:66`, `context-assembler.ts:90`).
9. Budget re-check: agentic iterations call `enforcePerIterationBudget` (drop preview after iteration 1, trim history-only oldest-non-self-first with newest-self-turn preserved, stamp `perIterationBudget` metadata; identical reference returned when under cap) (`context-budget.ts:189`, `context-budget.ts:127`).
10. Inspect path: `POST /api/studio/inspect-prompt` resolves the agent workspace-scoped via `agentGate.getById(id, request.db, workspaceId)`, assembles with that workspace (request header wins, agent row is the fallback; 400 when neither names one) under a 15s abort timeout, and returns char/token estimates — 404 on missing agent, 503 on timeout (`studio.ts`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `runtime/context-gate.ts` | Child facade: re-exports pipeline pieces + lazy `contextGate.assemble/use` |
| `runtime/kernel/context-pipeline-manager.ts` | Pipeline: middleware registry, model resolve + cache, parallel/serial run, packet join |
| `runtime/kernel/context-assembler.ts` | `ContextAssembler`: pipeline call, policy derivation, correlation stamping, tracing |
| `runtime/kernel/context-types.ts` | `ContextBuildContext`, `MutableContextPacket`, `IContextMiddleware` contracts |
| `runtime/kernel/context-budget.ts` | Token estimate, cap resolution, history trim, per-iteration enforcement |
| `runtime/kernel/middlewares/` | 11 stages (see priority table below), each appending blocks/tools/history |

Middleware order (priority → packet contribution): `ConstraintSafetyMiddleware` 10 → `InstructionStackMiddleware` 15 → `IdentityAuthorityMiddleware` 20 → `ChannelAwarenessMiddleware` 21 → `OperatorContextMiddleware` 22 (single `[OPERATOR CONTEXT]` block with the operator's name/tag/preference, pushed only when a preference is set, else nothing) → `SkillContextMiddleware` 30 → `ToolSchemaMiddleware` 40 → `MemoryRetrievalMiddleware` 60 (+ `memoryPreviewBlock`) → `VisibilityMatrixMiddleware` 70 → `HistoryCompressionMiddleware` 80 → `ContextLimitMiddleware` 85 (clamps `policies.maxTokenBudget` to the effective cap, must run last).

## Ports
- `contextPipeline` — shared `ContextPipelineManager` singleton (re-exported via both gates).
- `ContextPipelineManager` — pipeline class (`assemble/use/invalidateModelModuleCache/registerDefaultMiddlewares`).
- `ContextAssembler` — single-call assembler class.
- `runtimeGate` — full runtime facade re-export (assembly callers usually want `assembleContext`, not this).
- `ContextBuildContext` — `{ agent, channelId, workspaceId, userInput, runtimeType, modelConfig?, abortSignal?, customOverrides? }`.
- `MutableContextPacket` — in-assembly packet (blocks, tools, history, userPrompt, policies, metadata).
- `IContextMiddleware` — `{ name, priority, process(packet, ctx) }` interface.
- `HistoryMessage` — history entry type.
- `LLMToolDefinition` — tool schema type.

## Relations
Gates this domain calls:
- `module-gate.ts` — `moduleGate.model.get(id, ctx.workspaceId)` for workspace-scoped model-module resolve (dynamic import, cycle-safe); decrypt via `shared/core/secret-box.ts` stays local (`context-pipeline-manager.ts`).
- Shared helpers (exempt): `shared/core/ttl-cache.ts`, `shared/core/perf-metrics.ts` (`timeAsync`), `shared/core/model-routing.ts` (log-only), `shared/core/agent-lock-store.ts` (the §12 lock store — Shared is exempt, so the middlewares import it directly without a cross-gate edge), `shared/core/local-file.ts` (its file backend), `observability-gate.ts` (assembler spans only, via gate).
- `channel-gate.ts` — the lock store resolves a channel's owning workspace through `channelGate.get(channelId).workspaceId` (dynamic import inside Shared, cycle-safe) to pick the lock file scope.
Verified outside callers:
- `runtime/kernel/context-assembler.ts` (`ContextAssembler` → `contextPipeline.assemble`).
- `runtime/runtime-executor.ts` (via `ContextAssembler`, not the pipeline directly).
- `routes/studio.ts` (workspace-scoped `agentGate.getById` + `contextPipeline.assemble` for inspect-prompt; workspace-scoped module reads for manifest slots; `runtimeGate.invalidateModelModuleCache` after manifest mutation).
- `modules/module-service.ts` (`runtimeGate.invalidateModelModuleCache` — invalidates THIS domain's cache).
- Tests only: `kernel/context-pipeline.test.ts`, `kernel/context-assembly.perf.test.ts`.
- No outside callers of `contextGate.assemble`/`contextGate.use` were found — the live paths use `runtimeGate`/`ContextAssembler`/`contextPipeline` directly (see Gaps).
Tables shared with other domains (all read-only from here, via Modules gate):
- `model_modules` (reads config rows through `moduleGate.model.get`; Modules owns writes).

## Emits-Listens
- None. Assembly emits no broker events (thinking/stream/status emits belong to Runtime execution, not this child).

## Owns
- Nothing. No table or queue is written on any assembly path (cache-only mutation).

## Flags
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` — default-model key and google-row fallback (`context-pipeline-manager.ts:81`).
- `ANTHROPIC_API_KEY` — anthropic-row fallback (`context-pipeline-manager.ts:103`).
- `OPENAI_API_KEY` — openai-row fallback (`context-pipeline-manager.ts:104`).
- `PIPELINE_PARALLEL` — `false` forces serial middleware execution (`context-pipeline-manager.ts:167`).

## Decisions
- [Observed] Constraints > instructions > persona precedence is encoded as block priorities and pinned by integrity tests, not by registration order (`context-assembler.ts:12`, `context-pipeline-manager.ts:45`).
- [Observed] Parallel lane (≤70) vs serial tail split: independent-source stages run concurrently, history-consuming stages stay sequential (`context-pipeline-manager.ts:15`, `context-pipeline-manager.ts:176`).
- [Observed] Per-middleware error isolation keeps one bad stage (e.g. memory backend down) from failing the whole prompt (`context-pipeline-manager.ts:168`).
- [Observed] Model config cached 30s/200 DB+module+workspace-keyed entries — hot mention paths share one query per workspace; mutations invalidate explicitly (`context-pipeline-manager.ts:24`, `context-pipeline-manager.ts:66`).
- [Observed] Decrypt-once at the resolver: adapters receive plaintext config and never touch ciphertext or the secret box (`context-pipeline-manager.ts:107`).
- [Observed] Trim-history-only budget policy: system prompt, user input, preview, and tool schemas are never dropped to fit the cap (`context-budget.ts:118`).
- [Observed] `ContextLimit` runs last so it accounts for the summary/compression blocks appended just before it (`context-pipeline-manager.ts:55`).
- [Inferred] `context-gate.ts` is a plain re-export of `runtime-gate.ts` — it adds no async boundary and no `assemble`/`use` ports of its own (`context-gate.ts:1-14`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Pipeline ordering and error isolation stay; public path and cap precedence are the gaps.
One public assembly path exists: runtimeGate assembleContext plus ContextAssembler. contextGate.assemble and use are either the canonical path with callers or removed.
Middleware registration is synchronous on the shared pipeline. Promise-late registration that can miss in-flight assemblies is forbidden.
Token-cap precedence agent over custom over budget rests on real columns wired end to end. Phantom-column precedence is forbidden.
Compression triggers and the enableCompression flag have documented thresholds and interplay, not ordering-only docs.
Token estimation states its tokenizer, error bounds, and the 1000-token floor safety rule. Silent heuristic enforcement is not acceptable.
## Failure + Resume
- Any middleware throw is caught, `console.error`d with the stage name, and skipped — the packet completes without that stage's blocks (`context-pipeline-manager.ts:168`).
- Model-module miss (no row, or agent has no `modelModuleId` and no explicit `ctx.modelConfig`) rejects with `MODEL_MODULE_NOT_CONFIGURED`; decrypt/DB errors propagate only if the row lookup itself throws — callers (`ContextAssembler`, studio route) surface those (`context-pipeline-manager.ts`, `context-assembler.ts:92`).
- Routing-decision failures log and continue with the pinned module (`context-pipeline-manager.ts:137`).
- `ContextAssembler` span errors are recorded on the span and rethrown — assembly has no fallback packet (`context-assembler.ts:92`).
- Inspect-prompt maps abort/timeout to HTTP 503 instead of leaking a stack (`studio.ts:201`).
- Budget helpers are total: unknown caps return `null` (no enforcement), already-under-cap returns the identical reference, and trim preserves the newest self turn even when the cap cannot be met (`context-budget.ts:45`, `context-budget.ts:135`, `context-budget.ts:152`).
- Resume is N/A: assembly is stateless per call — retry by re-calling `assemble`; the TTL cache makes immediate retry cheap.

## Gaps
- `contextGate` defines no `assemble`/`use` ports (plain re-export) and has no verified outside callers — whether the child gate is the intended public path or dead surface is unverified (`context-gate.ts:1-14`).
- `no `use` port exists on the child gate — middleware registers via `runtimeGate.useMiddleware`; ordering vs in-flight assemblies unverified (`context-gate.ts:1-14`).
- `customOverrides.contextTokenCap` flows through `ContextBuildContext` but the pipeline's own cap inputs were only verified at the budget-helper level — end-to-end override wiring unconfirmed (`context-types.ts:14`, `context-budget.ts:33`).
- `agentContextTokenCap` is read off `(row as any)`-style access in Agents, suggesting the column may not exist in schema — cap precedence head (`agent > custom > budget`) may rest on a phantom field (`context-budget.ts:39`).
- `taskClassForRuntime` mapping and `MODEL_ROUTE` values that flip `routingEnabled()` were not enumerated — which runtimes route where is unverified (`context-pipeline-manager.ts:128`).
- History-compression trigger thresholds (when 80 fires vs passes through) and the `enableCompression` module flag interplay were not read — compression behavior beyond ordering is unverified (`context-pipeline-manager.ts:53`).
- `CHARS_PER_TOKEN = 4` is a heuristic with a 1000-token enforcement floor — accuracy vs real tokenizers and reasoning-safety at the floor are unverified (`context-budget.ts:14`, `context-budget.ts:17`).

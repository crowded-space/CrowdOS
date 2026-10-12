# Context assembly pipeline
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Raw `(agent, channel, userInput)` is not LLM-ready. This pipeline exists to turn it into a single `ContextPacket` (system prompt, history, tools, policies, provider/model metadata) with deterministic precedence and bounded size, without executing anything or writing any state.

## Architectural decision
Eleven middlewares run in priority order — not registration order — with constraints (10) > instructions (15) > persona (20), pinned by integrity tests [Observed]. The operator stage (22) appends one `[OPERATOR CONTEXT]` block carrying the sender's advisory name/tag/preference, or nothing when no preference is set [Observed]. Independent-source stages (priority ≤ 70) run concurrently while history-consuming stages (`HistoryCompression` 80, `ContextLimit` 85) always run sequentially last [Observed]. Every stage is error-isolated: one bad middleware (e.g. memory backend down) is logged and skipped, never aborts assembly [Observed]. Model config is resolved once, decrypted once at the single pipeline resolver, and cached 30s/200 scope-keyed entries — adapters receive plaintext and never touch ciphertext [Observed].

## How it works
`ContextAssembler.assemble` delegates to the shared `ContextPipelineManager`, then re-derives policy flags from `runtimeType` (`allowToolCalls` for agentic/coding/research/swarm; `allowSpawn`/`allowDelegation` for swarm only; `policyOverrides` win last) and stamps a fresh `randomUUID` requestId plus `runId`/`abortSignal` correlation. The pipeline resolves the model config (explicit `ctx.modelConfig` → agent's `modelModuleId` row with env-key fallback for google/anthropic/openai → google/`gemini-2.0-flash` default), seeds an empty packet with default policies, runs the middleware lane (parallel ≤ 70, serial tail, or fully serial when `PIPELINE_PARALLEL=false`), joins prompt blocks by priority, and returns the packet with `_modelConfig` attached. Budget is enforced twice against the same cap: `ContextLimit` clamps `policies.maxTokenBudget` at assembly, and agentic iterations re-check per call (preview dropped after iteration 1, history-only trim preserving the newest self turn) so long tool loops can't grow prompts past the cap.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Context.md> | Owns the assembler, the 11-middleware pipeline, model resolve + cache, and budget accounting |
| <../Domain Spec/Runtime.md> | Owns execution around assembly; consumes the packet and re-checks budget per agentic iteration |
| <../Domain Spec/Tools.md> | Supplies tool schemas embedded by `ToolSchemaMiddleware` |
| <../Domain Spec/Skills.md> | Supplies skill prompts embedded by `SkillContextMiddleware` |
| <../Domain Spec/Memories.md> | Supplies recall embedded by `MemoryRetrievalMiddleware` (call-out only, backend owned there) |

## Current state
Real: 11 middlewares with priority ordering, parallel lane + serial tail, per-middleware error isolation, model resolve/decrypt/cache, assembler policy derivation and correlation stamping, assembly-time cap clamp plus per-iteration re-check. Flag-gated: parallel lane (`PIPELINE_PARALLEL=false` restores serial). Stub: none.

## Alignment notes
- 2026-09-16 D2 (§26): `RuntimePacket` is now a type alias of `ContextPacket` (both names compile; gate re-exports both). Future §26 fields (`interpreter_output`, `visible_capabilities`, `state_updates`, `artifacts`) land with their features, not as cosmetic renames.
- Interpreter (§24): `execute` computes `interpret({ content, explicitRuntime })` and the assembler stamps it as `packet.interpreterOutput` (§26 `interpreter_output`); Router precedence unchanged, intent rides the packet. Remaining §26 fields (`visible_capabilities`, `state_updates`, `artifacts`) still land with their features.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* One public assembly path stays: runtimeGate assembleContext plus ContextAssembler. Promise-late registration missing in-flight assemblies is forbidden.
* Cap precedence agent over custom over budget rests on real columns wired end to end. Phantom-column precedence is forbidden.
* Compression triggers plus enableCompression interplay have documented thresholds. Token estimation states tokenizer, error bounds, and floor safety. Authority: Context, Runtime, Modules standards.
## Open gaps
- `customOverrides.contextTokenCap` end-to-end wiring past the budget helpers is unconfirmed.
- `agentContextTokenCap` may rest on a phantom column (snake-case fallback read in Agents) — cap precedence head unverified.
- History-compression trigger thresholds and the `enableCompression` module-flag interplay were not read — behavior beyond ordering unverified.
- `CHARS_PER_TOKEN = 4` with a 1000-token enforcement floor is a heuristic — accuracy vs real tokenizers unverified.

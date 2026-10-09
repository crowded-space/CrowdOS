# Runtime Domain — Invariants (must hold)
1. Router precedence fixed: explicit > librarian > pin > intent > tier (runtime-router.ts:107-155). Pin/intent tier-gated; forbidden pin falls through, never obeyed.
2. Rollback honesty: research/swarm with flag off -> agentic + reason=rollback + rolledBackFrom (runtime-router.ts:95-99).
3. Interpreter never plans/picks tools/reads memory; lexical only (interpreter.ts:1-30). Targets raw @-tokens; resolution in dispatch.
4. Tiers: L0/L1 {research,agentic,conversational,coding}, L2 +swarm, L3 {agentic,conversational,coding} never swarm engine (runtime-router.ts:58-75). Union covers all five; no single tier reaches all.
5. Assembler policy override: allowToolCalls only agentic/coding/research/swarm; allowSpawn/Delegation swarm-only (context-assembler.ts:63-67).
6. CTX-2 precedence: constraints(10) > instructions(15) > persona(20); ContextLimit(85) runs last (pipeline-manager + assembler 17-27).
7. Run lifecycle honest chain: created->starting->running ... completing->verifying->completed | cancelling->cancelled | failed, via stateGate sole mutator (runtime-executor.ts:193-255). No .catch(()=>null) fork (line 87 note).
8. Cancellation is user-abort only, never socket disconnect (ExecuteRequest.abortSignal; checkpoints in agentic/conversational/swarm).
9. Swarm workers run quiet kernel (persistMessages=false returns 0, no channel writes) + stateless (no memory accumulation) (runtime-kernel.ts:34-46, base-runtime.ts:18-40).
10. agent_complete is lifecycle-only, filtered from executable tools (agentic-runtime.ts:113-125).
11. Tool output clamped 8000 chars to bound context O(n2) (agentic-runtime.ts:13-22).
12. Composer/pin read split: composerModeToRuntime for UI mode, runtimeTypeFromString for pinned_runtime (types.ts:236-257) — fixed past defect.
13. Secrets: api_key decrypted only at pipeline resolver (context-pipeline-manager.ts:115-130).


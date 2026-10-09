# Types Folder (packages/server/src/types) — Inventory (Phase 1)

> **Post-fix update 2026-10-07 (dom-types task, fix phase):** index.ts and provider.types.ts deleted; ToolCall removed; TokenUsage.provider field removed; SpawnRequest/TaskFile/ScheduledTask/SpawnStatus/SpawnFailurePolicy/TaskPriority removed (SubtaskDefinition kept, priority inlined); RuntimeOverride/RuntimeOverrideType/RuntimeState removed. Remaining surface: mention.types.ts (3 exports, all live), runtime.types.ts (RuntimeStatus/InstructionPatch/PermissionPatch, all live), task.types.ts (SubtaskDefinition only), tool.types.ts (TokenUsage only). Folder went from 6 files / 175 LOC of dead surface to 4 files, all exports live. Verification: tsc exit 2 with ONLY the 2 pre-existing errors in shared/sockets/register-socket-server.ts; word-regexp greps for every deleted name = 0 hits in packages/server/src.

Read-only audit. Baseline commit 22bb8a0 "UX Update Phase B-G" (main, dirty tree pre-existing; this folder has NO working-tree changes — `git status -- packages/server/src/types` empty).

## Folder role

- Ungated shared type layer. `packages/server/scripts/check-gates.mjs` treats folders without a `*-gate.ts` as boundary-free ("internals stay freely importable"), and `types` is NOT in `EXEMPT_IMPORTERS` (shared/lib/config). Consequence: this folder MUST NOT import from gated domains' internals — e.g. `types/tool.types.ts` importing `../modules/module-types.js` would be a lint:gates violation (modules is a gated domain, module-types is not a gate entry).
- No tests exist for this folder (pure type declarations; nothing to execute).

## Files and exports (liveness verified by repo-wide word-regexp greps over packages, e2e, scripts)

| File | Export | Kind | Live? | Importers (excluding self/index.ts) |
|---|---|---|---|---|
| index.ts | StandardMessage | interface | DEAD | none (definition-only) |
| index.ts | GenerationResult | interface | DEAD | none |
| index.ts | StreamChunk | interface | DEAD | none |
| index.ts | TokenBudget | interface | DEAD | none |
| index.ts | TokenUsageLog | interface | DEAD | none |
| index.ts | (imports) ToolCall, TokenUsage from tool.types | import | DEAD | only used by the dead interfaces above |
| index.ts | re-exports 9 agent-gate types + 8 module-gate types + 6 runtime.types types | re-export | DEAD | whole barrel has ZERO importers repo-wide |
| mention.types.ts | MentionType | union | LIVE | shared/core/mention-parser.ts:2 |
| mention.types.ts | MentionFlag | union | LIVE | mention-parser.ts:2,167 |
| mention.types.ts | MentionMetadata | interface | LIVE | mention-parser.ts, messages/message-types.ts:2, db/schema.ts:19, ~~core/prompt-formatter.ts:1~~ [stale: file deleted 2026-10-07, unstaged; see audit/domains/core/inventory.md], runtime/types.ts:16 |
| provider.types.ts | ProviderEngine | union | DEAD (dup) | only tool.types.ts:1 (which is itself dead except via the barrel) — byte-identical duplicate of modules/module-types.ts:1 |
| provider.types.ts | GenerationModelProfile | interface | DEAD | none (routes/providers.ts uses raw DB rows; its "GenerationModelProfile" strings are 404 messages only) |
| provider.types.ts | EmbeddingModelProfile | interface | DEAD | none |
| provider.types.ts | IndexingModelProfile | interface | DEAD | none |
| runtime.types.ts | RuntimeStatus | union | LIVE | agents/agent-types.ts:1, agents/agent-service.ts:18, event-broker/event-types.ts:2, runtime/kernel/runtime-kernel.ts:6 |
| runtime.types.ts | InstructionPatch | interface | LIVE | db/schema.ts:21 (jsonb $type) |
| runtime.types.ts | PermissionPatch | interface | LIVE | db/schema.ts:21 |
| runtime.types.ts | RuntimeOverride | interface | DEAD | none (client has its own mirror type in packages/client/types/crowdOs.ts:222) |
| runtime.types.ts | RuntimeOverrideType | union | DEAD | used only inside runtime.types.ts (by RuntimeOverride) |
| runtime.types.ts | RuntimeState | interface | DEAD | none |
| task.types.ts | SubtaskDefinition | interface | LIVE | db/schema.ts:20 (jsonb $type) |
| task.types.ts | SpawnFailurePolicy | union | DEAD | none |
| task.types.ts | SpawnStatus | union | DEAD | none |
| task.types.ts | TaskPriority | union | DEAD | none |
| task.types.ts | SpawnRequest | interface | DEAD | none |
| task.types.ts | TaskFile | interface | DEAD | none (~~memory-builder.ts:170,179~~ [stale: file deleted 2026-10-07, unstaged; see audit/domains/core/inventory.md] are comments) |
| task.types.ts | ScheduledTask | interface | DEAD | none |
| tool.types.ts | ToolCall | interface | DEAD | only the dead index.ts |
| tool.types.ts | TokenUsage | interface | LIVE | runtime/types.ts:1 (re-export + LLMResponse/RuntimeResult) |
| tool.types.ts | TokenUsage.provider field | field | DEAD | never written (all 5 adapters build usage without it), never read (`rg '\.usage\??\.provider'` = 0 hits) |

## Key commands (evidence)

- `rg -n "types/index" . --glob "!node_modules" --glob "!dist" --glob "!audit"` -> 0 hits (barrel unused).
- `rg -n "from ['\"](...)?types(/[a-z.-]+)?\.js['\"]" packages e2e` -> 0 hits (no directory imports).
- `rg --word-regexp "<name>" packages e2e scripts` per export -> liveness column above.
- `npx tsc -p tsconfig.json --noEmit` (cwd packages/server) -> EXIT 1, 2 pre-existing errors OUTSIDE this folder: src/shared/sockets/register-socket-server.ts(332,15) TS2339 workspace-gate.dbForWorkspace missing; (335,143) TS2322 Promise<RuntimeResult> vs Promise<Promise<...>>. Zero errors in types/.

## Related existing docs (must stay in sync with any change)

- re-docs/Backend Docs/Domain Spec/Modules.md:164 — "Type-only: types/index.ts (re-exports all 8 module types)." (becomes stale if the barrel is deleted).
- re-docs/Backend Docs/Domain Spec/EventBroker.md:67 — cites RuntimeStatus from types/runtime.types.ts (stays true).
- re-docs/Backend Docs/Domain Spec/Messages.md:77 — cites MentionMetadata (stays true).
- re-docs/Backend Docs/Feature and Flow Spec/Legacy L3 dispatch (retired).md — spawn_requests/task_files tables intentionally retained (types removal must not touch tables).
- audit/domains/modules/inventory.md:37 — lists types/index.ts:14 as a type-only re-export target.

## Deliverables of this audit

- bug-ledger.csv (TYPES-001..TYPES-008)
- plan.md (ordered minimal-fix plan; no implementation this turn — see RESULT block)

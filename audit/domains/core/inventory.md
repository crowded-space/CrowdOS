# Core Domain — Phase 1 Inventory (read-only audit, 2026-10-07)

Scope: `packages/server/src/core/` — an empty, ungated legacy folder. Its last two files, `memory-builder.ts` (530 lines) and `prompt-formatter.ts` (54 lines), are deleted in the working tree (unstaged, uncommitted). Read-only audit: no production edits, no branch, no commit.

Method: directory listing (`Get-ChildItem -Force` -> 0 entries); `git status --porcelain`; `git diff --numstat`; `git show HEAD:<file>`; repo-wide ripgrep; `npx tsc -p tsconfig.json --noEmit` (cwd `packages/server`) -> exit 0.

## 1. Current state

| Fact | Evidence |
| --- | --- |
| `packages/server/src/core/` exists with 0 entries (empty dir) | `Get-ChildItem -Force` -> COUNT=0 |
| Index (HEAD) still lists both files | `git ls-files -- packages/server/src/core` -> `memory-builder.ts`, `prompt-formatter.ts` |
| Both files deleted in worktree, unstaged | `git status --porcelain` -> ' D' x2 |
| Deletion size 530 + 54 = 584 lines | `git diff --numstat` -> 0/530 and 0/54; diffstat: 584 deletions |
| Deletion date recorded elsewhere: 2026-10-07 | `re-docs/Backend Docs/Domain Spec/Modules.md:163`, `Messages.md:86` |
| No gate: folder is ungated | no `*-gate.ts`; AGENTS.md section 2 requires scaffolding a gate before any future code lands here |
| No test file ever existed here | all-time file list (git log --all) has zero `*.test.*` / `*.spec.*` under `src/core/` — see `test-gaps.md` |
| tsc clean | `npx tsc -p tsconfig.json --noEmit` (cwd packages/server) -> exit 0 |

Historical note: `git log --all --name-only -- packages/server/src/core` shows earlier PascalCase variants (LoopArbiter.{ts,yaml,acad.yaml}, MemoryBuilder.{ts,yaml,acad.yaml}, PromptFormatter.{ts,yaml,acad.yaml}) plus the current kebab-case pair; last commit touching the folder: 228ec60 "nightly v0.1.1" (2026-09-26).

## 2. Importers (repo-wide: zero)

`rg 'memory-builder|prompt-formatter'` (excluding node_modules/.git/dist) -> zero source importers. All hits are docs, archives, or stale build output:

| Hit | Kind | Action |
| --- | --- | --- |
| `audit/domains/types/inventory.md:25,41` | stale audit refs | annotated 2026-10-07 (this task) |
| `audit/domains/types/bug-ledger.csv` TYPES-005, TYPES-006 | stale audit refs | annotated 2026-10-07 (this task) |
| `audit/domains/modules/inventory.md:34` | stale audit ref | annotated 2026-10-07 (this task) |
| `re-docs/Backend Docs/Domain Spec/Modules.md:163`, `Messages.md:86` | deletion already recorded | none needed |
| `_archive/...` (Workspace Flow Audit.md, TO DO/DOMAIN_AUDIT/00-plan.md) | historical archive | leave as-is |
| `packages/server/dist/core/*.js` | stale build output (gitignored, .gitignore:7 dist/) | clean build drops them; see CORE-003 |

No file under `packages/server/src/`, `e2e/`, or `scripts/` imports either module; tsc exit 0 confirms nothing depends on them.

## 3. Successors (where the behavior lives now)

| Legacy (deleted) | Successor | Evidence |
| --- | --- | --- |
| Prompt assembly (MemoryBuilder.buildPrompt) | `runtime/kernel/context-pipeline-manager.ts` + middlewares | manager wires IdentityAuthority, ChannelAwareness, InstructionStack, SkillContext, ToolSchema, ConstraintSafety, MemoryRetrieval (p60), ContextLimit (p75), HistoryCompression (p80), VisibilityMatrix |
| moduleGate.model/instruction/toolkit.get reads | `runtime/kernel/context-pipeline-manager.ts:90-91` (model, dynamic import); `runtime/kernel/middlewares/instruction-stack-middleware.ts` (instruction modules + runtimeOverrides); `runtime/kernel/middlewares/constraint-safety-middleware.ts:20` | audit/domains/modules/inventory.md:32-33 |
| XML message formatting + escaping (formatMessageForAgent, escapeXmlAttr) | `shared/core/untrusted-wrapper.ts` (wrapUntrusted) | importers: `memories/memory-retrieval.ts:9`, `runtime/kernel/middlewares/visibility-matrix-middleware.ts:3`, `runtime/kernel/middlewares/channel-awareness-middleware.ts:4`, `runtime/kernel/context-integrity.test.ts` (7 sites) |
| History summarization (compressedSummaries) | writer `shared/core/librarian-runtime.ts:356`; reader `runtime/kernel/middlewares/history-compression-middleware.ts:28` | rg hits |
| Memory retrieval | `runtime/kernel/middlewares/memory-retrieval-middleware.ts` (priority 60) via `memories-gate` | middleware source |
| task_files raw reads | none (tables retained, no new writes — TYPES-005 retention decision) | audit/domains/types/bug-ledger.csv TYPES-005 |
| runtime_overrides raw reads | `runtime/kernel/middlewares/instruction-stack-middleware.ts:62` | audit/domains/types/bug-ledger.csv TYPES-006 |

## 4. Stale refs (all 5 annotated in place, 2026-10-07)

1. `audit/domains/types/inventory.md:25` — MentionMetadata evidence cited `core/prompt-formatter.ts:1`.
2. `audit/domains/types/inventory.md:41` — TaskFile evidence cited `memory-builder.ts:170,179`.
3. `audit/domains/types/bug-ledger.csv` TYPES-005 — evidence cited `memory-builder.ts:170,179` and `memory-builder.ts:117,269`.
4. `audit/domains/types/bug-ledger.csv` TYPES-006 — evidence cited `memory-builder.ts:77`.
5. `audit/domains/modules/inventory.md:34` — importer row `core/memory-builder.ts:58-68`.

Each now carries a stale marker ([stale: file deleted 2026-10-07 ...] in CSV; strikethrough + note in Markdown) pointing here.

## 5. Key commands (evidence)

- `git status --porcelain -- packages/server/src/core` -> ' D' x2 (unstaged deletion).
- `git diff --numstat -- packages/server/src/core` -> 0/530 and 0/54.
- `git ls-tree -r HEAD --name-only -- packages/server/src/core` -> both files still in HEAD.
- `rg -n 'memory-builder|prompt-formatter' -g '!node_modules' -g '!.git' -g '!dist' .` -> docs/archive/dist only (see section 2).
- `npx tsc -p tsconfig.json --noEmit` (cwd packages/server) -> exit 0.
- `node scripts/check-gates.mjs` (cwd packages/server) -> exit 1 with 4 pre-existing violations in `threads/thread-service.ts` (channel/message local-store imports; unrelated to core; recorded for the record).

## 6. Related docs (keep in sync)

- `audit/domains/core/bug-ledger.csv` (CORE-001..003), `audit/domains/core/test-gaps.md` (this folder).
- `audit/domains/types/inventory.md`, `audit/domains/types/bug-ledger.csv`, `audit/domains/modules/inventory.md` (refs annotated 2026-10-07).
- `re-docs/Backend Docs/Domain Spec/Modules.md:163`, `Messages.md:86` (deletion already recorded).
- AGENTS.md section 2: any future code here needs a gate scaffold first; folder is currently empty and ungated.

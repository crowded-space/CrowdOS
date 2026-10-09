# Core Domain — Test Gaps (Phase 1, 2026-10-07)

Scope: `packages/server/src/core/` — empty folder; `memory-builder.ts` (530 lines) + `prompt-formatter.ts` (54 lines) deleted unstaged. See `inventory.md` (this folder) and `bug-ledger.csv` CORE-001..003.

## 1. Did any test ever exist under src/core?

No. All-time file list under the folder (`git log --all --pretty=format: --name-only -- packages/server/src/core | sort -u`):

- LoopArbiter.ts, LoopArbiter.yaml, LoopArbiter.acad.yaml
- MemoryBuilder.ts, MemoryBuilder.yaml, MemoryBuilder.acad.yaml
- PromptFormatter.ts, PromptFormatter.yaml, PromptFormatter.acad.yaml
- memory-builder.ts, prompt-formatter.ts

Zero `*.test.*` / `*.spec.*` paths in the folder's entire git history; the current index (`git ls-files`) and worktree contain no test files either. The folder is empty, so no suite can currently match it.

## 2. Successor coverage pointers (where tests live now)

| Successor area | Test file(s) | Notes |
| --- | --- | --- |
| Runtime context pipeline (prompt-assembly successor) | packages/server/src/runtime/kernel/context-pipeline.test.ts; context-budget.test.ts; context-integrity.test.ts; context-model-routing.test.ts; context-assembly.perf.test.ts; discovery-context.test.ts; safety-dedupe.test.ts; stream-parity.test.ts; tool-deferral-invariant.test.ts; re-act-stream-parser.test.ts | richest coverage of the area that replaced memory-builder |
| Untrusted wrapper (XML/escaping successor) | runtime/kernel/context-integrity.test.ts (wrapUntrusted at 7 call sites) | direct; covers escaping and injection cases |
| Librarian compressedSummaries writer | none found (rg 'librarian' in *.test.ts hits only routing/queue ids; no test imports librarian-runtime) | writer covered only indirectly |
| History compression reader | none direct (rg 'HistoryCompression|compressedSummaries' in *.test.ts = 0 hits) | middleware class not directly tested; pipeline-level suites only |
| Memory retrieval middleware | memories/memories.test.ts; memory-retrieval.perf.test.ts; embeddings.test.ts | gate functions consumed by the middleware are covered; the middleware class itself has no direct test |
| Module routing reads | shared/core/model-routing.test.ts; runtime/kernel/context-model-routing.test.ts | successor of moduleGate reads |

## 3. Residual gaps

| # | Gap | Risk | Suggested test |
| --- | --- | --- | --- |
| G-1 | formatMessageForAgent / escapeXmlAttr (deleted) never had a direct unit test; no regression surface remains (zero importers) | Low | None needed; if the legacy XML shape must be preserved, pin wrapUntrusted output in a focused test |
| G-2 | librarian-runtime.ts writer path (compressedSummaries insert at :356) has no dedicated test | Medium | Unit: assert insert shape/semantics with a test DB harness |
| G-3 | No test asserts the 'src/core has zero importers' invariant; drift could reappear | Low | Optional CI grep guard: rg over packages/server/src for memory-builder or prompt-formatter must return 0 hits |
| G-4 | compressedSummaries writer/reader seam (librarian-runtime.ts:356 -> history-compression-middleware.ts:28) has no end-to-end test | Medium | Round-trip test with test DB: write summary, assert reader picks it up |

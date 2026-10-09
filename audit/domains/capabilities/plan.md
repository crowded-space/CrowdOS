# Capabilities — Plan (ordered, incremental)

Decision: INCREMENTAL — no rewrite. 4 source files, thin gate matches docs, 40 domain tests + 19 flow tests green, 0 gate violations, no security divergence from ToolExecutor. Rewrite would risk packet contract for zero gain.

## Ordered fix plan (each step: code + docs in SAME task per AGENTS.md §6; stop for review before commit)
1. CAP-005 (Tools domain): declare tool_id in open_detail schema + description. Smallest user-visible win; extend open-detail-expansion.test.ts.
2. CAP-002 + T9: deep-freeze catalog descriptors (or freeze per-descriptor) + immutability test.
3. CAP-008 + T4: warn on non-array tools in manifest; add override-fallback tests.
4. T1–T3, T5–T7, T10: test-only task pinning isolation, expand-hide, authority-throw, deep copy, gate surface, get() misuse, available semantics.
5. CAP-004: JSDoc "diagnostics-only" on get + (optionally) a lint/test guard.
6. CAP-007: one-line Domain Spec clarification that ExpandedCapability.tools = filtered schema names.
7. CAP-003: defer — add TtlCache for manifest only if profiling shows cost (no evidence today).
8. CAP-006, CAP-009: notes only; revisit if resolver gains workspace scoping or naming codemod runs.

## Constraints honored
- Read-only audit: no production edits; only audit/domains/capabilities/* written.
- No branch, no commit; git main untouched (capabilities sources clean).
- Docs NOT edited (noted, not performed) — sync owed when fixes 1–6 land.
- Baseline reproduced: tsc exit 2 (1 unrelated pre-existing error), domain tests 40/40, flow tests 19/19, check-gates 0 violations.

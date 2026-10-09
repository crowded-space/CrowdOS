# search-providers — Invariant Probe Log

Probe script (audit-only): `audit/domains/search-providers/probe/dedupe-probe.ts`.
Command: `node_modules\.bin\tsx.cmd audit/domains/search-providers/probe/dedupe-probe.ts` (repo root) → exit 0.

```
C1 distinct-urls-empty-snippets: kept=1 dropped=[{url:https://b.com/2, reason:near_duplicate_snippet}]
C2 empty+real:                  kept=2
C3 dedupeByUrl distinct:        kept=2
C4 short-token-snippets:        kept=1
C5 normalize('not a url')='not a url'; :8443 kept; :80/:443 stripped
C6 sort order: 2,1,3            (newest, then input order for missing/garbage)
C7 identical-snippets-distinct-urls: kept=1 reason=near_duplicate_snippet sim=1
```

Interpretation:
- C1/C4/C7 confirm SP-01: `jaccard(∅,∅) = 1` (service.ts:78) makes any two rows with
  empty (or all-≤2-char-token) snippets near-duplicates — the second distinct URL is DROPPED.
  Research flattens per-sub-question results and runs `dedupeEvidence` (research-runtime.ts:490),
  so multi-provider rows with empty snippets lose evidence silently. Confirmed, S2.
- C2 shows the asymmetry: one real snippet avoids the collapse (non-empty vs empty → 0).
- C3 confirms `dedupeByUrl` (URL-only) is unaffected — the bug is only in `dedupeEvidence`.
- C5/C6 confirm documented normalize/sort semantics.

Environment: Node v22.21.0, vitest 4.1.7 (from repo `node_modules`). No production file was executed with network access;
providers were not called (no keys present in probe process).

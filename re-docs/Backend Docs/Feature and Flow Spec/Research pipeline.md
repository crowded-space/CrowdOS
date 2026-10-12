# Research pipeline
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
A vague question becomes a cited report with receipts. This pipeline exists so one run decomposes the query, searches each sub-question in isolation, dedupes and freshens the evidence, synthesizes only from what was found, and persists both the bundle and the report — saying plainly when the evidence is thin instead of hallucinating.

## Architectural decision
The shape is two linked choices. First, isolation before synthesis: raw snippets never enter main history — each sub-question runs an isolated search (+ top-2 fetch enrichment) and only the synthesized report is persisted as the visible message (`research-runtime.ts:495`, `research-runtime.ts:609-620`) `[Observed]`. Second, graceful degradation at every stage: decompose falls back to a template split, each provider/search/fetch/child-run/artifact step is individually best-effort, and an empty evidence set still synthesizes an honest thin report (`research-runtime.ts:220`, `research-runtime.ts:450`, `research-runtime.ts:602-604`) `[Observed]`. Dedupe is layered accordingly — URL normalization in SearchProviders, then URL + 0.8-Jaccard snippet-similarity + freshness sort in the runtime — so no single layer has to be perfect `[Observed]`.

## How it works
1. The run opens, assembles context, and marks working + thinking; the research runtime takes over with an isolated evidence accumulator, never the packet history (`research-runtime.ts:386`).
2. Decompose: the query is split into sub-questions by a cheap-tier LLM call, falling back to the template splitter when the LLM fails (`research-runtime.ts:137`, `research-runtime.ts:220`, `research-runtime.ts:414`).
3. Parallel search: a bounded pool (max 3) runs each sub-question through `searchProviderGate.search(subQ, { limit: 8, timeoutMs: 6000 })` with the run's abort signal; each creates an optional best-effort child run row for audit (`research-runtime.ts:447`, `research-runtime.ts:495`).
4. Enrich: the top-2 results per sub-question get a fetch upgrade when the page yields 50+ chars beyond the snippet, capped at 1500 chars (`research-runtime.ts:505`).
5. Dedupe: URL-normalize pass, then `dedupeEvidence` at 0.8 Jaccard similarity, then `sortByFreshness` (timestamp-less sorts oldest) into one `EvidenceBundle` (`research-runtime.ts:556`, `research-runtime.ts:572`, `research-runtime.ts:578`).
6. Synthesize: a synthesis LLM turns the bundle into a 300–600-word cited report with footnotes + Sources section, guarded by a token-delta warn and a leak invariant so raw snippets never ride the next prompt (`research-runtime.ts:228`, `research-runtime.ts:592`).
7. Persist evidence: the bundle is stored as a `citations` artifact and the report as a `report` artifact, both best-effort (`research-runtime.ts:537`, `research-runtime.ts:575`).
8. The report persists as the sole visible message, the agent goes idle, and the run closes normally (`research-runtime.ts:626-636`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Runtime.md> | Owns the research flavor: decompose → isolated search → dedupe/sort → synthesis → artifact/message persists |
| <../Domain Spec/SearchProviders.md> | Owns provider fan-out (brave → tavily → serper), per-backend mapping, and URL-normalized union dedupe consumed per sub-question |
| <../Domain Spec/Artifacts.md> | Owns `citations` + `report` artifact storage for the bundle and the final report |
| <../Domain Spec/Runs.md> | Owns the optional child-run audit rows the pipeline creates best-effort per sub-question |

Related: <./Runtime router and flavors.md> (how `research|data` tags and `RESEARCH_V1` route here), <./Context assembly pipeline.md> (what the synthesis prompt is built from), <./Provider adapters and streaming.md> (how decompose/synthesis LLM calls stream).

## Current state
Real: LLM decompose with template fallback, max-3 isolated sub-run pool with audit rows, per-question limit-8 search with 6s timeout, top-2 fetch enrichment, two-layer dedupe + freshness sort, cited synthesis, dual artifact persists, single-message close. Flag-gated: whole flavor (`RESEARCH_V1`, default off → agentic). Stub: none — empty evidence honestly synthesizes a thin report instead.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Child-run parentRunId linkage goes through runsGate.create, never direct repository import. Unlinked child runs are forbidden.
* Citation integrity has a post-synthesis validator for footnote-to-source correspondence. Prompt-only citation enforcement is forbidden.
* Worst-case latency of sequential fan-out times pool versus caller timeout has a documented bound. Silent mid-fan-out abort is forbidden.
* Crashed research resume has an explicit rule for which sub-questions re-run versus reuse bundle artifact. Authority: Runtime, Runs, SearchProviders, Artifacts standards.
## Open gaps
- Child-run `parentRunId` linkage falls back to a direct repository import when the gate lacks the field — whether parent linkage persists is unverified.
- Fetch-enrichment source quality (boilerplate vs article extraction, failure taxonomy) was not traced beyond the length-gain heuristic.
- Citation integrity (footnote `[n]` ↔ bundle source correspondence) is enforced by prompt only — no post-synthesis validator was observed.
- Worst-case latency (sequential provider fan-out × 3-way pool vs the 6s caller timeout aborting later providers) is unverified.
- Resume semantics for a crashed research run (which sub-questions re-run vs reuse the bundle artifact) are unverified.

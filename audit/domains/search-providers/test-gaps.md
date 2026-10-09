# search-providers — Test Gaps

Existing coverage (26 tests, all passing): normalize/dedupe/sort (gate.test), mocked fan-out/limit/early-exit/all-failed (service.test),
mapper shapes + HTTP failure paths + missing-key warn-once (provider-mappers.test), gate mocked in research-runtime.test.

| # | Gap | Why it matters | Suggested test |
|---|---|---|---|
| G1 | `dedupeEvidence` with empty/≤2-char snippets (SP-01) | Distinct URLs silently dropped — reproduced in probe, no test guards it | Unit: two distinct URLs + empty snippets → expect 2 kept (fails today) |
| G2 | Pre-aborted caller `signal` (SP-09) | Cancel-before-fetch path untested | Unit: `signal: AbortSignal.abort()` → provider rejects, no fetch call |
| G3 | `timeoutMs` abort via fake timers (SP-10) | Timeout semantics untested end-to-end | `vi.useFakeTimers()` + hanging fetch → advance → rejects with timeout |
| G4 | Non-finite `timeoutMs` (SP-07) | Immediate-abort surprise | Unit: `timeoutMs: NaN` documented behavior |
| G5 | Single-provider custom priority appending defaults | Only unknown-name case covered | Env `SEARCH_PROVIDER_PRIORITY=tavily` → all 3 run, tavily first |
| G6 | 200 + non-object JSON (e.g. `"str"`) | Mapper returns `[]` silently (only `null` throws) — inconsistent with throw contract | Document or throw |
| G7 | `dedupeEvidence` 200-comparison cap | Behavioral cliff at 201 kept snippets | Boundary test (optional) |
| G8 | Timestamp merge on duplicate (SP-08) | Kept-row freshness loss | Unit: first row no ts, dup with ts → expect kept ts (currently undefined) |

# search-providers — Contracts

## Facade (frozen during audit)
`search-provider-gate.ts:3-13`: `searchProviderGate = { search, normalizeUrl, dedupeByUrl, dedupeEvidence, sortByFreshness }`,
named exports of the same five, type exports `SearchResult | SearchProvider | SearchOptions`. Gate is wire + re-export only (no logic) — PASS per AGENTS.md §2.

## Behavior contract (verified)
1. Non-string query → `[]`, no provider calls (service.ts:174). Blank → `[]` (:175-176). >512 chars truncated (:177).
2. `limit <= 0` → `[]` no calls (:182); non-finite → default behavior (:185); finite → floor (:183).
3. Order: `SEARCH_PROVIDER_PRIORITY` comma/lower/trim; unknown names warn once + dropped; defaults appended so all three run (:144-169).
4. Fan-out: first sequential full-limit + early-exit when deduped ≥ limit (:197-203); rest parallel `Promise.allSettled` with `ceil(limit/n)` (:209-220); every-attempted-failed → one aggregate warn (:221-223); no key anywhere + empty → one `No search provider configured` warn (:224-233).
5. Providers: missing key → warn-once + `[]` (brave.ts:56-62, tavily.ts:47-53, serper.ts:47-53); non-OK/429/JSON-parse → warn + throw (brave.ts:100-115 etc.); title ≤300 / snippet ≤2000 (brave.ts:44); timestamp unparsable → dropped + warn-once-per-call (brave.ts:36-48).
6. `normalizeUrl`: lowercase host, strip `www.`, default-port drop, fragment drop, trailing-slash drop, tracking-param strip (`utm_`,`fbclid`,`gclid`,`igshid`,`mc_eid`), param sort, http→https canonicalization; non-URL fallback trim/lower/strip (service.ts:12-44). Probe: `'not a url'` → `'not a url'`; `:80/:443` stripped; `:8443` kept (probe C5).
7. `dedupeByUrl`: first-seen wins, duplicates `{url, duplicateOf}` (service.ts:46-66).
8. `dedupeEvidence`: URL dedupe + Jaccard snippet similarity ≥ 0.8, capped at 200 kept-snippet comparisons (service.ts:85-124).
9. `sortByFreshness`: newest-first; unparsable/absent timestamps keep input order at end (service.ts:126-138; probe C6: order 2,1,3).

## Invariants (should hold; status)
| # | Invariant | Status | Evidence |
|---|---|---|---|
| I1 | Nothing outside `search-providers/` imports internals | HOLDS | rg + check-gates 0 violations |
| I2 | Gate has no logic/branching | HOLDS | gate.ts is assignments only |
| I3 | Search never throws to callers; failures degrade to `[]` | HOLDS | service.ts:204-238 (catch everywhere); callers rely on it (research-runtime.ts:445-448, tool-registry.ts:523-525) |
| I4 | Distinct URLs are never dropped by dedupe | **VIOLATED** when both snippets empty/short → SP-01 | service.ts:78,101-108; probe C1/C4/C7 |
| I5 | First-seen row (with its data) survives dedupe | HOLDS (documented); freshness nuance → SP-08 | service.ts:54-59 |
| I6 | Missing keys never log secrets; keys only in headers/body | HOLDS | brave.ts:82, serper.ts:69, tavily.ts:67 |
| I7 | No persistence/broker coupling | HOLDS | no imports; docs Emits-Listens/Owns = none |
| I8 | `source` values constrained | **VIOLATED** (free string) → SP-02 | types.ts:7-8 |

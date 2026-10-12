# SearchProviders

## Purpose
Key-gated multi-provider web search with graceful degradation. It fans one query out to Brave, Tavily, and Serper, skips failures per provider, dedupes by normalized URL, and returns the union — so Research and the `web_search` tool get evidence even when zero, one, or two backends are down or unconfigured.

## Feature Scope
In-scope:
- Provider ordering (`SEARCH_PROVIDER_PRIORITY` override, else brave → tavily → serper) with unlisted providers appended, never dropped.
- URL normalization + `dedupeByUrl` (first-seen wins, duplicates reported with `duplicateOf`).
- `searchProviders` fan-out: first provider sequential with early-exit, remaining providers parallel via `Promise.allSettled`, per-provider limit/timeout/signal, final `opts.limit` cap.
- Per-backend HTTP mapping (endpoints, auth headers/body, result-shape mappers, timestamp parse with unparsable-timestamp warning + drop).
Non-goals (other domains):
- Query decomposition, snippet-similarity dedupe, freshness sort, fetch enrichment, synthesis, evidence artifacts → Runtime (`research-runtime.ts` owns the evidence pipeline; it borrows `search` + `dedupeEvidence` + `sortByFreshness` and builds its own bundle object).
- Tool-exposed search → Tools (`tool-registry.ts:499-521` registers `web_search` through the gate).
- Key provisioning/rotation UI → Modules/Workspace config surfaces (this domain only reads env).
- Result persistence/citation storage → Artifacts (`citations`/`report` writes live in Research).

## Expect
- [Observed] Non-string query short-circuits to `[]` with zero provider calls; blank/whitespace query likewise (`search-provider-service.ts:174-176`).
- [Observed] Query longer than 512 chars is truncated before fan-out (`search-provider-service.ts:6`, `search-provider-service.ts:177`).
- [Observed] Limit ≤ 0 (incl. negative) returns `[]` with zero provider calls; non-finite limit (NaN/±Infinity) falls back to default behavior — no final cap, providers use their own 1–20 clamp (`search-provider-service.ts:178-186`).
- [Observed] Missing key per provider warns ONCE per provider module and yields `[]` for that provider (`brave.ts:7`, `brave.ts:56-62`); all-unconfigured additionally warns `No search provider configured` once at service level and returns `[]` — never throws (`search-provider-service.ts:224-233`).
- [Observed] Any single-provider throw (HTTP non-OK, 429, unparseable JSON, abort/timeout) is caught, warned with the provider name + truncated query, and skipped — one backend down never fails the union (`search-provider-service.ts:204-207`, `search-provider-service.ts:212-219`).
- [Observed] When EVERY attempted provider throws, one loud aggregate warn `ALL N attempted providers failed … returning []` fires (`search-provider-service.ts:221-223`) — distinct from a genuine empty result, which emits no such warn.
- [Observed] Union, not failover: results from ALL succeeding providers merge before dedupe, so priority order affects output ordering, not backend selection (`search-provider-service.ts:196-220`).
- [Observed] `dedupeByUrl` keeps the FIRST occurrence and reports later ones as `{ url, duplicateOf }` — provider priority therefore decides which copy survives (`search-provider-service.ts:46-66`).
- [Observed] `dedupeEvidence` near-dup guard: two empty token sets score 0, not 1 (SP-01 fixed) — distinct URLs with empty/short snippets are kept instead of dropped as `near_duplicate_snippet`.
- [Observed] Per-provider `limit` clamps to 1–20 (default 10); the gate `opts.limit` caps the FINAL deduped list (`brave.ts:63`, `search-provider-service.ts:234-238`).
- [Observed] Non-OK HTTP statuses warn with status + 300-char body slice and THROW so the service counts the provider as failed; HTTP 429 additionally names the rate-limit and `Retry-After` when present (`brave.ts:100-110`, `brave.ts:102-107`).
- [Observed] HTTP 200 + unparseable JSON warns and throws instead of silently yielding `[]` (`brave.ts:111-115`).
- [Observed] Abort/timeout surfaces as warn + throw, including caller-signal composition — cancellation is a counted failure at service level, not a silent success (`brave.ts:86-97`, `brave.ts:68-73`).
- [Observed] Unparsable timestamps (e.g. Brave relative `age`) are dropped from the row, warned once per mapper call, and keep NO freshness signal — the freshness sorter keeps such rows in input order at the end instead of sorting them as oldest (`brave.ts:36-48`, `search-provider-service.ts:126-138`).
- [Observed] `SEARCH_PROVIDER_PRIORITY` unknown names warn once listing the valid options; valid providers plus appended defaults still run (`search-provider-service.ts:158-161`).

## Flow
1. Validate: `searchProviders(query, opts?)` rejects non-string, trims, returns `[]` on blank; truncates query to 512 chars; parses `limit` (≤0 → `[]`, non-finite → default) (`search-provider-service.ts:173-186`).
2. Order: `configuredProviders` parses `SEARCH_PROVIDER_PRIORITY` (comma-split, lowercased, blanks dropped); empty/absent falls back to `brave,tavily,serper`; unknown names warn once and are dropped; any default provider missing from a custom list is appended, so all three always run (`search-provider-service.ts:142-171`).
3. Fan out: provider #1 is awaited SEQUENTIALLY first and receives the FULL `limit` so the early-exit can fire; if its deduped results already reach `limit`, the rest never run (`search-provider-service.ts:191-207`). The remaining providers fan out IN PARALLEL via `Promise.allSettled`, each with `ceil(limit/n)`; fulfilled results accumulate, rejects are warned-and-skipped (`search-provider-service.ts:209-220`). When every attempted provider rejected, the aggregate `ALL N attempted providers failed` warn fires (`search-provider-service.ts:221-223`).
4. Brave: key from `BRAVE_API_KEY`, else warn-once + `[]` (`brave.ts:7`, `brave.ts:56-62`); `GET api.search.brave.com/res/v1/web/search?q=&count=` with `X-Subscription-Token`, 5s default timeout composed with `opts.signal`, non-OK/429/JSON-parse → warn + throw, maps `web.results|results` (`url|link`, `title`, `description|snippet|content` ≤2000 chars, `age|page_age|published_date|date` → ISO; unparsable dates warned + dropped) and slices to limit (`brave.ts:63-116`).
5. Tavily: key from `TAVILY_API_KEY`, else warn-once + `[]` (`tavily.ts:7`, `tavily.ts:47-53`); `POST api.tavily.com/search` with `{ api_key, query, max_results, search_depth: basic, include_answer: false, include_images: false }`, same timeout/signal/limit discipline, maps `results` (`url`, `title`, `content|snippet`, `published_date|publishedDate|date`) (`tavily.ts:54-110`).
6. Serper: key from `SERPER_API_KEY`, else warn-once + `[]` (`serper.ts:7`, `serper.ts:47-53`); `POST google.serper.dev/search` with `{ q, num }` + `X-API-KEY`, same discipline, maps `organic|results` (`link|url`, `title`, `snippet|description`, `date|publishedDate|published_date`) (`serper.ts:54-103`).
7. No-key notice: when the union is empty AND no key is set anywhere, one `No search provider configured` warning fires (`search-provider-service.ts:224-233`).
8. Dedupe: `dedupeByUrl` normalizes each URL and keeps first-seen (`search-provider-service.ts:46-66`); normalize lowercases host, strips `www.`, drops default ports and fragments, drops trailing slash, strips `utm_*`/`fbclid`/`gclid`/`igshid`/`mc_eid` params, sorts survivors, and canonicalizes http → https so the same page via either protocol counts once (`search-provider-service.ts:15-35`); unparseable input falls back to trim → lowercase → strip fragment/trailing slash (`search-provider-service.ts:37-42`). Pathname case preserved (lowercasing corrupted case-sensitive URLs - 2026-09-25); near-dup Jaccard capped at 200 comparisons (`search-provider-service.ts:103-104`).
9. Cap: `opts.limit > 0` slices the deduped union; otherwise the full union returns (`search-provider-service.ts:234-238`).
10. Consume: `ResearchRuntime` calls `search(subQ, { limit: 8, signal: abortSignal, timeoutMs: 6000 })` per isolated sub-question (`research-runtime.ts:423`) and applies its OWN second layer (`dedupeEvidence` at `research-runtime.ts:484`, `sortByFreshness` at `research-runtime.ts:485`) before synthesis. The `web_search` tool calls `searchProviderGate.search(query, { limit: 8 })` (`tool-registry.ts:518-521`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `search-providers/search-provider-gate.ts` | thin `searchProviderGate` facade + type re-exports (all logic lives in `search-provider-service.ts`) |
| `search-providers/search-provider-service.ts` | normalize/dedupe/freshness helpers, provider ordering, fan-out with early-exit + allSettled, limit/query validation, aggregate warnings |
| `search-providers/search-provider-types.ts` | `SearchResult`, `SearchProvider`, `SearchOptions` shapes |
| `search-providers/providers/brave.ts` | Brave backend: key guard, GET fetch, shape mapper, `__testMapBraveJson` |
| `search-providers/providers/tavily.ts` | Tavily backend: key guard, POST fetch, shape mapper, `__testMapTavilyJson` |
| `search-providers/providers/serper.ts` | Serper backend: key guard, POST fetch, shape mapper, `__testMapSerperJson` |

## Ports
Gate exports (must equal `search-provider-gate.ts`):
- `searchProviderGate.search` / `searchProviders` — fan-out: first provider sequential with full-limit early-exit, rest parallel via `Promise.allSettled` with `ceil(limit/n)` split; non-string query → [], limit ≤ 0 → [], non-finite limit → default, query truncated to 512; malformed results skipped.
- `searchProviderGate.normalizeUrl` / `normalizeUrl` — URL canonicalizer for dedupe comparison (http/https unified, host/port/path/tracking params normalized).
- `searchProviderGate.dedupeByUrl` / `dedupeByUrl` — `{ deduped, duplicates }` by normalized URL, first-seen wins.
- `searchProviderGate.dedupeEvidence` / `dedupeEvidence` — `{ deduped, duplicates }` by URL + snippet similarity (single owner; runtime re-exports).
- `searchProviderGate.sortByFreshness` / `sortByFreshness` — newest-first sort by timestamp; rows without a parsable timestamp keep input order at the end (single owner; runtime re-exports).
- `SearchResult` — `{ url, title, snippet, timestamp?, source }` record type.
- `SearchProvider` — `{ name, search(query, opts?) }` backend interface type.
- `SearchOptions` — `{ limit?, signal?, timeoutMs? }` options type.

Not gate ports: `__testMapBraveJson` / `__testMapTavilyJson` / `__testMapSerperJson` are domain-internal test hooks consumed only by `providers/provider-mappers.test.ts`.

## Relations
Gates this domain calls:
- None. Zero imports outside its own folder (only type-only `search-provider-types.ts`); key reads are raw `process.env`, no config gate.
Verified outside callers:
- `runtime/runtimes/research-runtime.ts` — `searchProviderGate.search` per sub-question (`research-runtime.ts:423`) plus `dedupeEvidence`/`sortByFreshness` for its own second pass (`research-runtime.ts:484-485`); it does NOT call `normalizeUrl` directly (normalization happens inside the gate's dedupe helpers).
- `tools/tool-registry.ts` — registers the `web_search` tool through `searchProviderGate.search` (`tool-registry.ts:499-521`).
- Tests: `search-providers/search-provider-gate.test.ts` (normalize/dedupe/gate-contract cases), `search-providers/search-provider-service.test.ts` (mocked-provider fan-out, limit split, early-exit, gate wiring), `search-providers/providers/provider-mappers.test.ts` (mappers + failure paths), `runtime/runtimes/research-runtime.test.ts` (mocks the gate).
Tables shared with other domains:
- None. No DB access on any path (HTTP-only + in-memory union).

## Emits-Listens
- None. No broker import, no emits, no subscriptions (all diagnostics are `console.warn`).

## Owns
- Nothing. No table, queue, or persistent state (per-call union only).

## Flags
- `SEARCH_PROVIDER_PRIORITY` — comma-ordered backend priority, e.g. `serper,brave`; unknown names warn once listing valid options, omitted defaults appended (`search-provider-service.ts:144-169`).
- `BRAVE_API_KEY` — Brave credential; absent means Brave contributes `[]` (`brave.ts:9-13`).
- `TAVILY_API_KEY` — Tavily credential; absent means Tavily contributes `[]` (`tavily.ts:9-12`).
- `SERPER_API_KEY` — Serper credential; absent means Serper contributes `[]` (`serper.ts:9-12`).

## Decisions
- [Observed] Union-over-failover: every configured backend is always queried and results merge — recall over cost/latency, ordering carries the priority signal (`search-provider-service.ts:196-220`).
- [Observed] Fail-open per provider (warn + throw counted by the service; missing key → `[]`) with a single aggregated no-key warning AND a single loud all-failed aggregate warning — search degrades to fewer sources, never to a thrown error (`brave.ts:98-115`, `search-provider-service.ts:221-233`).
- [Observed] First provider sequential + full limit (early-exit reachable), rest parallel (`Promise.allSettled`) with `ceil(limit/n)` split — worst-case gate latency ≈ first timeout (5s) + parallel-rest timeout (5s) ≈ 10s, well above the Research caller's 6s `timeoutMs` which aborts via the composed signal (`search-provider-service.ts:191-220`, `brave.ts:64-73`, `research-runtime.ts:423`).
- [Observed] First-seen-wins dedupe keyed on aggressive normalization (case, www, ports, slashes, tracking params, fragment, http/https unification) — the same article via `?utm_*`, bare URL, or the http variant counts once (`search-provider-service.ts:12-66`).
- [Observed] Title ≤300 / snippet ≤2000 truncation at the mapper boundary — providers can never blow downstream context caps with one field (`brave.ts:29-44`).
- [Observed] Caller signal composes with the internal timeout controller (pre-aborted callers reject immediately) — user cancel actually cancels in-flight search (`brave.ts:64-73`).
- [Observed] Limit enforced twice (per-backend clamp 1–20, final gate slice) plus first-provider full-limit early-exit — one greedy backend cannot starve the union's diversity (`brave.ts:63`, `search-provider-service.ts:200-203,234-238`).
- [Observed] Input validation: non-string → `[]`, query truncated to 512, limit ≤ 0 → `[]`, non-finite limit → default (no final cap) — garbage inputs can neither fan out unbounded queries nor slice with negative indices (`search-provider-service.ts:173-186`).
- [Observed] No 429 retry/backoff — fail-open plus a rate-limit warn is enough for now (`brave.ts:103`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Union plus fail-open plus dedupe stay; priority typos, garbage-timestamp signal, and EvidenceBundle removal are DONE (2026-09-26). Remaining target gaps: `source` union type, total-failure signaling to callers, 429 backoff.
Union-over-failover stays: every configured backend is queried and results merge. Ordering carries priority, never selection.
Fail-open per provider stays: warn plus counted failure on HTTP/parse/abort, `[]` on missing key. Search degrades to fewer sources, never throws.
First-seen-wins dedupe on aggressive normalization (incl. http/https unification) stays. Title and snippet truncation stay at the mapper boundary.
Caller signal composes with the internal timeout controller. User cancel cancels in-flight search. Limit is enforced per-backend plus final slice.
EvidenceBundle was REMOVED as a dead export (no repo consumers; Research builds its bundle object locally at `research-runtime.ts:488`) — a Research bundle shape without a gate contract is forbidden, so a future shared bundle must be added as a gate port first (2026-09-26).
Test mapper entry points ARE labeled test-only: `__testMap*Json` are domain-internal, consumed only by in-domain tests; external mapper reuse bypassing the gate is forbidden.
SEARCH_PROVIDER_PRIORITY unknown names warn listing valid options. Silent degrade to default ordering is forbidden.
Fan-out latency has a bound: first-sequential + parallel-rest ≈ 10s worst case vs Research's 6s caller timeout (composed signal aborts mid-fan-out). Silent unbounded fan-out is forbidden.
Similarity and freshness dedupe live in this domain as gate ports (`dedupeEvidence`, `sortByFreshness`); Research merely re-exports. Freshness-blind consumers by accident are forbidden.
source MUST be a validated union type. Free-form mapper strings flowing into artifacts are forbidden. (OPEN)
Timestamp parse failure signals garbage explicitly: mapper drops + warns, sorter keeps input order at the end. Silent oldest sort is forbidden.
Total failure MUST warn loudly once (`ALL N attempted providers failed`); changing the return type to signal failure needs a coordinated caller update (OPEN).
## Failure + Resume
- Unconfigured backend: warn-once + `[]`; all unconfigured: extra `No search provider configured` warn + `[]` — callers must handle empty evidence, not errors (`brave.ts:56-62`, `search-provider-service.ts:224-233`).
- HTTP non-OK (incl. 429 with `Retry-After` when present): warn with status + truncated body, THROW; the service counts it and, when every attempted provider failed, emits the loud aggregate warn before returning `[]` (`brave.ts:100-110`, `search-provider-service.ts:221-223`).
- Malformed JSON on HTTP 200: warn + throw (counted failure), never a silent `[]` (`brave.ts:111-115`).
- Timeout/abort (internal 5s default or caller signal): warn + throw; pre-aborted caller signals reject immediately without a completed fetch (`brave.ts:68-73`, `brave.ts:86-97`).
- Unparseable URLs never break dedupe — the lowercase/trim fallback key keeps them comparable (`search-provider-service.ts:37-42`).
- Resume is N/A: search is stateless per call — retry by re-calling `search`; idempotency callers need lives one layer up (Research reuses the gate's dedupe/sort ports, Queue owns job dedupe).

## Gaps
- Total failure vs genuine empty is still indistinguishable to CALLERS: the return type stays `[]` for both (external callers `tool-registry.ts` / `research-runtime.ts` cannot be edited from this domain). In-domain mitigation: the loud `ALL N attempted providers failed` aggregate `console.warn` fires only when attempted > 0 and every fetch threw — operators can tell the cases apart in logs, code cannot. Closing this needs a coordinated caller-contract change.
- `source` is a free-form string stamped by each mapper (`brave|tavily|serper`) with no union type or validation — a mapper typo would flow into artifacts unchecked (`search-provider-types.ts:7-8`).
- No 429 retry/backoff: rate-limited providers are counted as failed for that call only — add backoff if throttling is observed (`brave.ts:103`).
- `__testMap*Json` mapper entry points are domain-internal (not gate ports) — deliberate: only in-domain tests import them; external reuse bypassing the gate remains forbidden.
- CLOSED 2026-09-26: EvidenceBundle was removed as a dead export (zero repo consumers; no gate port, no types entry).
- CLOSED 2026-09-26: `SEARCH_PROVIDER_PRIORITY` unknown names now warn once listing valid options (`search-provider-service.ts:158-161`).
- CLOSED 2026-09-26: unparsable timestamps are dropped + warned at the mapper and keep input order at the end of freshness sort — never silent oldest (`brave.ts:46-48`, `search-provider-service.ts:126-138`).
- CLOSED 2026-09-26: similarity/freshness dedupe moved INTO this domain as gate ports (`dedupeEvidence`, `sortByFreshness`); `research-runtime.ts:7` only re-exports for compat.

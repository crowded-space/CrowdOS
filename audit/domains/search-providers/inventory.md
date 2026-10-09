# search-providers — Inventory & Map

Audit date: 2026-10-06. READ-ONLY (Phases 1–4). Code read at working-tree state; `git status` shows `main` dirty
with pre-existing unrelated modifications — this audit created only files under `audit/`.

## Files (domain)
| File | Role | LOC |
|---|---|---|
| `search-provider-gate.ts` | Thin facade: `searchProviderGate` object + named + type re-exports | 13 |
| `search-provider-service.ts` | normalize/dedupe/freshness helpers; provider ordering; fan-out; validation | 239 |
| `search-provider-types.ts` | `SearchResult`, `SearchProvider`, `SearchOptions` | 20 |
| `providers/brave.ts` | Brave GET adapter + mapper + `__testMapBraveJson` | 122 |
| `providers/tavily.ts` | Tavily POST adapter + mapper + `__testMapTavilyJson` | 116 |
| `providers/serper.ts` | Serper POST adapter + mapper + `__testMapSerperJson` | 109 |
| `search-provider-gate.test.ts` | normalize/dedupe/sort/gate graceful-fallback tests | 105 |
| `search-provider-service.test.ts` | mocked-provider fan-out/limit/early-exit/gate-wiring tests | 148 |
| `providers/provider-mappers.test.ts` | mapper + HTTP failure-path tests | 164 |

## Execution map (who calls what)
```
tool-registry.ts:518 (dynamic) ──┐
research-runtime.ts:4 (static) ──┼──> search-provider-gate.ts (ONLY entry)
research-runtime.test.ts:3 ─────┘        ├─ search ──────────────> searchProviders (service.ts:173)
                                         │                         ├─ configuredProviders (service.ts:142) reads SEARCH_PROVIDER_PRIORITY
                                         │                         ├─ brave.search / tavily.search / serper.search
                                         │                         └─ dedupeByUrl (service.ts:46)
                                         ├─ dedupeEvidence (service.ts:85)  <─ research-runtime.ts:490
                                         ├─ sortByFreshness (service.ts:126) <─ research-runtime.ts:491
                                         ├─ dedupeByUrl / normalizeUrl      <─ gate tests
                                         └─ types (SearchResult/SearchProvider/SearchOptions)
```
- Persistence: NONE (no DB import on any path).
- Events/queues/jobs: NONE (`research-runtime.ts:418-427` queue enqueue is Research/Queue, not this domain).
- Routes: NONE. Config: env only (`shared/config/env.ts:231-234`, `.env.example:156-160`; `data/config.json` has no search keys).
- No production file outside the folder imports domain internals (`rg` verified; `check-gates.mjs` 0 violations, no test-only findings here).

## Contract matrix (exact exports vs consumers)
| Gate export | Kind | Signature (actual) | Consumers |
|---|---|---|---|
| `searchProviderGate.search` = `searchProviders` | fn | `(query: string, opts?: SearchOptions) => Promise<SearchResult[]>` | tool-registry.ts:521; research-runtime.ts:429; tests |
| `normalizeUrl` | fn | `(raw: string) => string` | gate tests; internal dedupe |
| `dedupeByUrl` | fn | `(results: SearchResult[]) => { deduped; duplicates[] }` | gate tests; internal fan-out |
| `dedupeEvidence` | fn | `(results: SearchResult[], similarityThreshold = 0.8) => { deduped; duplicates[] }` | research-runtime.ts:490 (+ re-export :7) |
| `sortByFreshness` | fn | `(results: SearchResult[]) => SearchResult[]` | research-runtime.ts:491 (+ re-export :7) |
| `SearchResult` | type | `{ url; title; snippet; timestamp?; source: string }` | both callers; research-runtime.ts:5,9 |
| `SearchProvider` | type | `{ readonly name; search(...) }` | NO consumer outside gate re-export (see SP-06) |
| `SearchOptions` | type | `{ limit?; signal?; timeoutMs? }` | callers via inference |
| `__testMap*Json` (3) | fn | domain-internal | provider-mappers.test.ts only (not gate ports — correct) |

Severity scale: S0 catastrophic, S1 high silent wrong behavior, S2 real degraded behavior, S3 hygiene/hardening.
Confidence: Confirmed (probed/reproduced), High, Medium, Low.

## Docs (not performed — read-only audit)
`re-docs/Backend Docs/Domain Spec/SearchProviders.md` (full v2 template), `Feature and Flow Spec/Web search fan-out.md`,
`Research pipeline.md`, `_flow-index.md:25,46` link the domain. Line-ref drift found (SP-05). No `Domain Spec/_index.md` exists.

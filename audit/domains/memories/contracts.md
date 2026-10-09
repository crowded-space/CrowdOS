# Memories Domain — Contracts (Phase 2, one row per method)

Legend — Pre: preconditions; Val: validation; Res: result shape; Err: error surface; Auth/tenant: identity + workspace scoping; Idem: idempotency; Txn: transaction; Side: side-effects/ordering; Obs: observability; Retry; Perf; Compat.

## CRUD / store (agent-memory-store.ts)

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| resolveAgentId(agentId, opts) :210 | any string | trim, @-strip | string (UUID or passthrough) | throws only non-connection DB errors; connection → passthrough | workspaceId in cache key + dbForWorkspace | pure-ish; caches miss | none | cache set on every path | none | none | 60s/500 TTL cache; full-table findMany on miss | passthrough preserved |
| buildNoteId(now?) :274 | — | — | `YYYY-MM-DD-<12hex>` | — | — | collision ~2^48/day | — | — | — | caller retries 3x | no table scan | pinned by test |
| generateNoteId(agentId?) :282 | — | arg ignored | same as buildNoteId | — | — | — | — | — | — | — | — | agentId arg contract gap (G4) |
| createMemoryNote(input, opts) :286 | agentId+noteType+hook+brief | resolves agent; channel fallback null; sanitize auto-reflection; throttle check | `MemoryStoreResult<MemoryNotePreview>` | AGENT_NOT_FOUND; REFLECTION_THROTTLED/DUPLICATE; UPDATE_FAILED (dead); throws after 3 failed attempts on non-connection err | resolvedAgentId scoping; opts.workspaceId | no (duplicate create makes new id) | none | insert → throttle.record → audit(fire) → cap(fire) → mirror(await, caught) | console only on cap/mirror failure | 3 id-collision attempts | 1 insert + FK lookups; cap async | ok |
| readMemoryNote(agentId, noteId, {updateAccess}, opts) :413 | ids | — | `MemoryStoreResult<MemoryNoteFull>` | NOTE_NOT_FOUND; throws non-connection | scoped (id+agentId) | read bump not idempotent (accessCount++) | none | read → access bump (best-effort) | none | none | 1-2 queries | ok |
| listMemoryPreviews(agentId, filter, opts) :455 | ids | lifecycle matrix; type/channel/minImportance | `MemoryStoreResult<MemoryNotePreview[]>` | throws non-connection | scoped agentId | read-only | none | in-memory suppression filter after SQL | none | none | no limit clamp (G7) | order importance DESC, timestamp DESC |
| updateMemoryNote(agentId, noteId, patch, opts) :520 | ids + reason | 13 editable keys; no-op if none | `MemoryStoreResult<MemoryNotePreview>` | NOTE_NOT_FOUND; throws non-connection | scoped (id+agentId) | last-write-wins; no version | none | diff → update → audit → mirror | audit fire-and-forget | none | 1 select + 1 update | reason runtime-defaulted (G5) |
| archiveMemoryNote(agentId, noteId, reason, opts) :610 | ids + reason | existence scoped | `MemoryStoreResult<MemoryNotePreview>` | NOTE_NOT_FOUND | scoped | not idempotent-safe (re-archive rewrites timestamp) | none | select → update → audit → mirror | audit fire | none | 2 queries | lifecycle one-way |
| suppressMemoryNote(agentId, noteId, reason, suppressUntil, opts) :663 | ids + reason + until | existence scoped | `MemoryStoreResult<MemoryNotePreview>` | NOTE_NOT_FOUND | scoped | re-suppress updates until | none | select → update → audit → mirror | audit fire | none | 2 queries | ok |

## Lifecycle (memory-lifecycle.ts)

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| resolveMemoryDb(opts) :30 | — | precedence: explicit ws → ALS scope → env gate | db or null | swallows resolution errors → null | tenant-aware | — | — | — | none | — | — | degraded contract |
| logMemoryUpdate(entry) :77 | entry | — | void (fire-and-forget) | console.error swallow | uses ambient getDb() — NOT tenant-threaded (see MEM-004) | append-only | none | async detached | console only | none | 1 insert detached | contract: never blocks |
| getNoteCap() :96 | — | numEnv>0 | number default 500 | — | — | — | — | — | — | — | — | env-bounded |
| isSuppressionActive(note, now) :101 | — | finite until | boolean | — | — | pure | — | — | — | — | — | pure |
| runSuppressionSweep(now) :114 | — | batch 500 | `{flipped}` | throws (caller catches) | ambient getDb() — sweep caller must bind (runWithDb) | re-run safe (only expired suppressed) | none | find → update → audit per note | console on audit fail | none | 1 find + 1 update | contract: port as-is to queue |
| enforceNoteCap(agentId, cap, opts) :151 | agentId | count vs cap | `{archived}` | throws | resolveMemoryDb(opts) | re-run safe | none | count → victims → update → audit | console | none | 3 queries | ok |
| enforceCapsAllAgents(cap) :196 | — | — | number | per-agent isolated via allSettled | ambient getDb() | re-run safe | none | chunk 5 fan-out | console per failure | none | full active scan (G8) | ok |
| startMemorySweeper() :224 | once per process | env interval | void | catches per-DB | forEachWorkspaceDb + runWithDb | once-guard | none | interval unref | console log | — | per-tick sweep all DBs | queue port documented |
| softSuppressNote(agentId, noteId, reason, until, opts) :253 | ids | existence scoped | boolean | throws non-connection (discard caller catches) | scoped | true if already suppressed | none | select → update (no lifecycle flip) → audit | audit fire | none | 2 queries | MEM-2 contract |
| discardNoteFromContext(agentId, channelId, noteId, reason, opts) :290 | ids | — | `{ok:true,inVault}` always | never throws (catch) | scoped | session discard re-set extends TTL | none | soft-suppress best-effort → session discard | console | none | 2 queries + map | always-true contract |

## Retrieval (memory-retrieval.ts)

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| retrieveMemoryCandidates(input) :52 | agentId/channelId | window env; filters suppressed+discarded | `MemoryCandidate[]` | throws non-connection | opts.workspaceId; session discards per agent+channel | read-only | none | window → filter → lanes → semantic (dynamic import, catch{}) → sort/slice | none on semantic failure | none | 1 SQL + optional embed | shape pinned by perf test |
| buildMemoryPreviewBlock(candidates) :187 | — | — | string ("" when empty) | — | — | pure | — | wraps hook/brief untrusted | — | — | — | format pinned |

## Embeddings (embeddings.ts)

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mockEmbed(text, dims) :93 | — | — | number[] L2-normalized | — | — | deterministic | — | — | — | — | O(tokens) | test-pinned |
| embedText(text, opts) :119 | text | profile/env resolution | EmbeddingResult | never throws (fallback mock) | opts.workspaceId for profile lookup | deterministic mock / provider call | none | provider → truncate/pad/normalize → fallback | logMetric stages | none (single 8s timeout) | network optional | model field distinguishes |
| cosineSimilarity(a,b) :168 | — | length mismatch → 0 | number | — | — | pure | — | — | — | — | O(n) | pinned |
| parseStoredEmbedding(stored) :182 | — | JSON or pgvector text | number[] \| null | swallow | — | pure | — | — | — | — | — | — |
| getCachedEmbeddingVector(noteId, stored) :208 | — | parse; clear >2000 | Float32Array \| null | — | — | cache | — | per-process cache | — | — | O(1) hit | cache clear-all at 2000 |
| invalidateEmbeddingCache(noteId) :219 | — | — | void | — | — | — | — | — | — | — | — | — |
| embedNote(noteId) :223 | note exists | — | EmbeddingResult \| null | persist failures swallowed w/ metric | ambient getDb() (not threaded) | re-embed idempotent-ish (rewrites) | none | read → embed → persist(best-effort) → cache invalidate | logMetric on skip | none | 1 select + 1 update | column-missing tolerated |
| embedNotesBatch(noteIds, concurrency=4) :247 | — | — | Map | per-note swallow | ambient | — | none | worker pool | none | none | concurrency bound | — |
| ensureEmbeddingsForAgent(agentId, limit=100) :263 | agentId | — | `{embedded,skipped}` | fallback query path | ambient | re-run safe | none | probe → batch | none | none | up to 100 | mock-db fallback |
| hybridScore(options) :295 | — | weight clamp via env | Map | — | — | pure | — | — | — | — | O(n·d) | non-gated export |
| searchByEmbedding(query, agentId, limit=10) :312 | agentId | — | scored rows | raw-SQL failure → JS fallback | ambient getDb() | read-only | none | pgvector attempt → JS window 60 | none | none | 1-2 queries | semanticScore rank approx |

## Throttle / discards / env

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ReflectionThrottle.check(agentId, hook, now) :41 | — | env switch; interval; Jaccard | decision | — | per-agent map (process-local) | — | — | — | — | — | O(ring·tokens) | restart-reset documented |
| ReflectionThrottle.record(agentId, hook, now) :63 | — | ring 25 | void | — | per-agent | — | — | — | — | — | — | — |
| normalizeHookTokens(text) :19 | — | stopwords, len>2 | string[] | — | — | pure | — | — | — | — | — | test-pinned |
| jaccardSimilarity(a,b) :28 | — | — | number | — | — | pure | — | — | — | — | — | test-pinned |
| sessionDiscards.discard/listDiscarded/clearAll :19-42 | ids | TTL | void/string[] | — | agent+channel key | TTL | — | lazy expiry on list | — | — | O(entries) | restart-reset documented |
| numEnv/boolEnv :1-10 | — | positive-finite / only "false" disables | number/bool | — | — | pure | — | — | — | — | — | pinned by docs |

## Local mirror (memory-local-store.ts)

| Method | Pre | Val | Res | Err | Auth/tenant | Idem | Txn | Side-order | Obs | Retry | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mirrorMemoryNote(agentId, note, workspaceId?) :114 | note has id | scope arg → note.workspaceId → null | void | throws (callers catch) | file per agent+scope | upsert by id | file lock | read → upsert → full rewrite | — | — | O(n) rewrite | canon path |
| readLocalMemoryNotes(agentId, workspaceId?) :137 | — | — | LocalMemoryNote[] | ENOENT → [] | explicit scope or all searchable scopes merged | read-only | — | — | — | — | O(scopes·n) | merge by id |
| scoreLocalNote(note, query) :153 | — | — | number | — | — | pure | — | — | — | — | O(tokens) | naive degraded |

## Cross-method contract notes

1. All store methods take trailing `opts?: MemoryWorkspaceOpts` except `runSuppressionSweep`/startMemorySweeper/enforceCapsAllAgents/logMemoryUpdate which rely on ambient ALS binding (sweep path) — MEM-004.
2. Result-union is the domain failure contract; throws are reserved for non-connection DB errors (docs Decision).
3. `discardFromContext` always returns ok:true even when the vault note is missing (test-pinned, memories.test.ts:482-489).
4. Facade drift: `logMemoryUpdate` flat-only (G3); `embeddingsGate` not exposed via memoriesGate (G2).

# Memories

## Purpose
Agent long-term memory vault: note CRUD with reflection throttle/dedupe, lifecycle (archive/suppress/expire), per-agent note caps, multi-lane retrieval with optional embedding-hybrid scoring, and session-scoped discards — all keyed by agent id with human-readable name resolution.

## Feature Scope
In-scope:
- Memory note CRUD + previews (`agent_memory_notes` table).
- Name/slug → UUID resolution with TTL cache.
- Reflection write throttle (min interval + hook-similarity dedupe).
- Lifecycle: hard archive, timed hard-suppress + expiry sweep, soft-suppress (no lifecycle flip), per-agent note-cap archive.
- Audit journal (`memory_update_log`, fire-and-forget).
- Multi-lane retrieval + prompt-ready preview block.
- Embedding pipeline: mock/real vectors, per-note persist, batch backfill, cosine/hybrid/vector search.
- Session-scoped discards (in-memory, per agent+channel TTL).
Non-goals (other domains):
- Prompt assembly/injection → Runtime (`memory-retrieval-middleware.ts:7` only calls this domain's retrieval).
- Skill/toolkit resolution → Skills (this domain only stores text; no tool loading).
- Agent identity/validation → Agents (this domain reads `agents` rows for existence only).
- Scheduling/repeatable jobs → Queue (maintenance worker ports the sweep body as-is).
- Transport (REST/socket payloads) → none: this domain has no routes; Tools expose it via `remember`/`open_memory`/`discard_memory_from_context`.

## Expect
- [Observed] `create` returns `{ ok: false }` (never throws) for unknown agents and throttled/duplicate reflections; it throws only on repeated DB failures (`agent-memory-store.ts:309-310`, `agent-memory-store.ts:329-341`, `agent-memory-store.ts:392-396`).
- [Observed] Unknown `channelId` falls back to `null`, never a foreign-key error (`agent-memory-store.ts:313-314`).
- [Observed] `resolveAgentId` passes unknown ids through unchanged after caching the miss (`agent-memory-store.ts:264-265`).
- [Observed] `read` bumps `accessCount`/`lastAccessed` unless `updateAccess: false` (`agent-memory-store.ts:441-446`).
- [Observed] `list` defaults to active-only, limit 50, ordered `importanceScore DESC, noteTimestamp DESC`, with no upper clamp on `limit` (`agent-memory-store.ts:503-507`).
- [Observed] Suppressed notes stay hidden unless `includeSuppressed: true`, evaluated against current time on every list (`agent-memory-store.ts:513-515`, `memory-lifecycle.ts:100-108`).
- [Observed] `update` with no editable fields is a no-op returning the existing preview; `reason` is required by type but defaults to `"update"` at runtime (`agent-memory-store.ts:584-586`, `agent-memory-store.ts:600`).
- [Observed] `update` never touches lifecycle/suppress columns — use `archive`/`suppress`/`softSuppress` for those (`agent-memory-store.ts:555-569`).
- [Observed] Retrieval candidate set is SQL-bounded to `MEM_RETRIEVAL_WINDOW` (default 60) before lane scoring, then sliced to `topK` (default 10) (`memory-retrieval.ts:58-66`, `memory-retrieval.ts:157-159`).
- [Observed] Reflection throttle defaults: 60s min interval, 0.8 Jaccard threshold over a 25-hook ring (`memory-reflection-throttle.ts:3-5`, `memory-reflection-throttle.ts:44-50`).
- [Observed] Note ids are `YYYY-MM-DD-<12 hex>` and ignore the passed `agentId` (`agent-memory-store.ts:274-284`).
- [Observed] `discardFromContext` always returns `{ ok: true }`, recording the session discard even when the vault note is missing (`memory-lifecycle.ts:290-305`).
- [Observed] `softSuppressNote` returns `false` when the note is missing and `true` (no-op) when already hard-suppressed (`memory-lifecycle.ts:261-266`).
- [Inferred] `embedText` with `EMBEDDING_ENABLED=false` still returns a usable deterministic mock vector — callers cannot tell mock from real except via the `model` field (`embeddings.ts:115-117`).
 - [Observed] Degraded (§18): every successful PG write mirrors to `<workspaceFolder>/vfs/.crowdos/memories/<agentId>.jsonl` (canon 2026-09-22: inside the owning workspace folder); when PG is unconfigured/unreachable, writes go local-only (no FK validation) and reads/retrieval serve the local mirror with naive substring scoring (`agent-memory-store.ts`, `memory-retrieval.ts`, `memory-local-store.ts`).

## Flow
1. Resolve: `resolveAgentId` trims/`@`-strips, checks a 60s/500-key scope-cached map, then direct id match, then a case-insensitive name/title scan, else passes the input through (`agent-memory-store.ts:208-266`).
2. Create: `createMemoryNote` resolves agent, loads agent + channel in parallel, nulls bad channels (`agent-memory-store.ts:296-304`); auto-reflections (`reflection` + `self_reflection`) are sanitized then throttle-checked (`agent-memory-store.ts:318-341`); insert retries id allocation 3 times (`agent-memory-store.ts:318-341`); success records the throttle, fires audit + cap enforcement without awaiting (`agent-memory-store.ts:298-310`).
3. Read: `readMemoryNote` scopes by `(noteId, agentId)`, optionally bumps access counters (`agent-memory-store.ts:430-446`).
4. List: `listMemoryPreviews` builds the lifecycle predicate matrix (active/archived/suppressed combos), applies type/channel/importance filters, orders and limits, then drops still-suppressed rows unless asked (`agent-memory-store.ts:476-517`).
5. Patch: `updateMemoryNote` diffs the 13 editable keys, stamps `updatedAt`, audits with previous values (`agent-memory-store.ts:555-603`).
6. Lifecycle writes: `archiveMemoryNote` flips to `archived` with reason (`agent-memory-store.ts:610-647`); `suppressMemoryNote` flips to `suppressed` with `suppressUntil` (`agent-memory-store.ts:663-702`); `softSuppressNote` sets suppress columns without touching lifecycle (`memory-lifecycle.ts:253-275`).
7. Retrieve: `retrieveMemoryCandidates` loads the bounded active window, drops suppressed + session-discarded notes, then merges lane hits (`recent_episodic` 1.0, `unresolved_tensions` 0.9, `high_importance` 0.8 at ≥0.7, `mentions` 0.6, `recency` 0.5 under 2d) keeping per-lane max (`memory-retrieval.ts:105-124`); with `EMBEDDING_ENABLED=true` a semantic lane blends cosine similarity (weight `EMBEDDING_HYBRID_WEIGHT`, default 0.5, score floor 0.3) (`memory-retrieval.ts:116-145`); results sort by score and slice to `topK` (`memory-retrieval.ts:157-159`).
8. Inject: `buildMemoryPreviewBlock` renders `[score] "hook" — "brief" {note_id, type, lanes, importance, has_tension}` lines inside `<memory_previews>`, wrapping hook/brief as untrusted; empty input renders `""` (`memory-retrieval.ts:187-199`); Runtime calls both behind a warn-and-continue catch (`memory-retrieval-middleware.ts:7-31`).
9. Sweep: `runSuppressionSweep` flips up to 500 elapsed `suppressed` rows back to `active` with one audit row each (`memory-lifecycle.ts:114-141`); `enforceNoteCap` archives the lowest-importance/oldest overflow beyond `MEM_NOTE_CAP` (`memory-lifecycle.ts:151-193`); `enforceCapsAllAgents` fans out in chunks of 5 with per-agent isolation (`memory-lifecycle.ts:196-214`).
10. Discard: `discardNoteFromContext` soft-suppresses for `MEM_DISCARD_TTL_MS` (default 30min) and always records the session discard (`memory-lifecycle.ts:290-297`); retrieval excludes live discards per agent+channel (`memory-retrieval.ts:52`).
11. Startup: `startMemorySweeper` runs once per process on `MEM_SUPPRESS_SWEEP_MS` (default 10min), sweeping every workspace DB with `unref` (`memory-lifecycle.ts:224-247`); inline mode starts it via the heartbeat system (`agent-heartbeat.ts:65`); bullmq mode ports `runMemorySweep` into the `suppress-expiry` repeatable (`maintenance-worker.ts:67-85`).
12. Embed: `embedText` resolves env-override or first `embedding_model_profiles` row, uses the OpenAI-compatible endpoint on 8s timeout with truncate/pad + renormalize, else mock (`embeddings.ts:110-157`); `embedNote` persists vector JSON + model + timestamp, tolerating a missing column (`embeddings.ts:214-236`); `ensureEmbeddingsForAgent` backfills up to 100 missing vectors with a JS fallback probe (`embeddings.ts:254-278`); `searchByEmbedding` tries native pgvector ordering, then JS cosine over a 60-note window (`embeddings.ts:303-351`).

## Current Implementation
- `memories/agent-memory-store.ts` → CRUD owner. `resolveAgentId`/`buildNoteId`/`generateNoteId`/`createMemoryNote`/`readMemoryNote`/`listMemoryPreviews`/`updateMemoryNote`/`archiveMemoryNote`/`suppressMemoryNote` plus preview/full mappers (`agent-memory-store.ts:210-290`).
- `memories/memory-lifecycle.ts` → sweeps, caps, audit. `logMemoryUpdate`/`getNoteCap`/`isSuppressionActive`/`runSuppressionSweep`/`enforceNoteCap`/`enforceCapsAllAgents`/`startMemorySweeper`/`softSuppressNote`/`discardNoteFromContext` (`memory-lifecycle.ts:1-256`).
- `memories/memory-retrieval.ts` → lanes + prompt block. `retrieveMemoryCandidates`/`buildMemoryPreviewBlock` (`memory-retrieval.ts:49-169`).
- `memories/embeddings.ts` → vectors. `mockEmbed`/`embedText`/`cosineSimilarity`/`parseStoredEmbedding`/`getCachedEmbeddingVector`/`embedNote`/`embedNotesBatch`/`ensureEmbeddingsForAgent`/`hybridScore`/`searchByEmbedding` plus a non-gated `embeddingsGate` object (`embeddings.ts:362-371`).
- `memories/memory-reflection-throttle.ts` → in-process throttle. `ReflectionThrottle.check/record/reset` + `normalizeHookTokens`/`jaccardSimilarity` (`memory-reflection-throttle.ts:37-77`).
- `memories/memory-session-discards.ts` → in-process TTL map keyed `agentId:channelId` (`memory-session-discards.ts:16-45`).
- `memories/memory-env.ts` → env readers. `numEnv` (positive-finite else fallback) / `boolEnv` (only `"false"` disables) (`memory-env.ts:1-10`).
- `memories/memories-gate.ts` → thin facade + `memoriesGate` object; re-exports store, retrieval, lifecycle, discards, throttle, embeddings individually (`memories-gate.ts:1-105`).
- Types (from `agent-memory-store.ts:15-124`, `memory-lifecycle.ts:9-25`, `memory-retrieval.ts:16-40`): `MemoryNoteType` (7 kinds), `MemoryConfidence`, `MemorySourceType` (5), `MemoryValence` (5), `MemoryLifecycleStatus` (`active|archived|suppressed`), `MemoryNotePreview` (metadata only) vs `MemoryNoteFull` (+ 6 body sections), `CreateMemoryNoteInput`, `UpdateMemoryNotePatch`, `MemoryListFilter`, `MemoryStoreError` (6 codes), `MemoryStoreResult<T>` ok-union, `MemoryUpdateAction` (7), `MemoryUpdateLogInput`, `MemoryCandidate` (score + laneScores + sourceLanes), `RetrievalInput` (lane flags + topK).

## Ports
- `MemoryNoteType` — note kind type (`episodic | semantic | reflection | journal | tool_result | correspondence | tension`).
- `MemoryConfidence` — `low | medium | high` type.
- `MemorySourceType` — note provenance type.
- `MemoryValence` — emotional valence type.
- `MemoryLifecycleStatus` — `active | archived | suppressed` type.
- `MemoryNotePreview` — metadata-only note record type.
- `MemoryNoteFull` — preview plus 6 body-section fields type.
- `CreateMemoryNoteInput` — note creation input type.
- `UpdateMemoryNotePatch` — note patch type (`reason` + 13 editable keys).
- `MemoryListFilter` — list filter type (type/channel/archived/suppressed/importance/limit).
- `MemoryStoreError` — store error code type.
- `MemoryStoreResult` — `{ ok: true, value } | { ok: false, error }` union type.
- `MemoryCandidate` — ranked retrieval candidate type.
- `RetrievalInput` — retrieval lane-flag + topK input type.
- `MemoryUpdateAction` — audit action type.
- `MemoryUpdateLogInput` — audit write input type.
- `resolveAgentId` — resolves name/slug/UUID to agent UUID.
- `generateNoteId` — allocates a `YYYY-MM-DD-<12hex>` id (argument ignored).
- `createMemoryNote` — inserts a note with reflection throttle guard.
- `readMemoryNote` — reads one full note, bumps access counters by default.
- `listMemoryPreviews` — lists previews by lifecycle/type/channel/importance filter.
- `updateMemoryNote` — patches editable fields with audit.
- `archiveMemoryNote` — flips a note to `archived` with reason + audit.
- `suppressMemoryNote` — flips a note to `suppressed` until a timestamp + audit.
- `retrieveMemoryCandidates` — multi-lane ranked retrieval with optional semantic lane.
- `buildMemoryPreviewBlock` — renders candidates as a prompt-ready preview block.
- `runMemorySweep` — alias of `runSuppressionSweep`: flips elapsed suppressions to active.
- `enforceNoteCap` — archives lowest-importance overflow beyond cap for one agent.
- `enforceCapsAllAgents` — enforces caps across all agents with per-agent isolation.
- `startMemorySweeper` — starts the once-per-process suppression/cap interval timer.
- `softSuppressNote` — sets suppress columns without flipping lifecycle.
- `discardFromContext` — alias of `discardNoteFromContext`: session-hide plus soft-suppress, always `{ ok: true }`.
- `getNoteCap` — returns the configured per-agent note cap.
- `isSuppressionActive` — true while `suppressUntil` is in the future.
- `logMemoryUpdate` — fire-and-forget audit insert (standalone export, not on `memoriesGate`).
- `memorySessionDiscards` — session-scoped discard tracker instance (also as `memoriesGate.sessionDiscards`).
- `reflectionThrottle` — reflection write throttle instance (also as `memoriesGate.reflectionThrottle`).
- `jaccardSimilarity` — token-set similarity helper.
- `normalizeHookTokens` — hook tokenizer helper (lowercase, NFKD, stopwords, length > 2).
- `embedText` — embeds text via provider or deterministic mock fallback.
- `embedNote` — embeds one note and persists its vector.
- `embedNotesBatch` — embeds many notes with concurrency 4.
- `ensureEmbeddingsForAgent` — backfills missing agent embeddings (default 100).
- `searchByEmbedding` — vector similarity search over an agent's notes.
- `mockEmbed` — deterministic hash-based mock embedding.
- `cosineSimilarity` — cosine similarity (length mismatch → 0).
- `memoriesGate.resolveAgentId` — resolves name/slug/UUID to agent UUID.
- `memoriesGate.generateNoteId` — allocates a note id.
- `memoriesGate.createMemoryNote` — inserts a note with reflection throttle guard.
- `memoriesGate.readMemoryNote` — reads one full note by id.
- `memoriesGate.listMemoryPreviews` — lists note previews by filter.
- `memoriesGate.updateMemoryNote` — patches a note by id.
- `memoriesGate.archiveMemoryNote` — archives a note by id.
- `memoriesGate.suppressMemoryNote` — suppresses a note by id.
- `memoriesGate.retrieveMemoryCandidates` — multi-lane ranked retrieval.
- `memoriesGate.buildMemoryPreviewBlock` — renders candidates as a preview block.
- `memoriesGate.runMemorySweep` — flips elapsed suppressions to active.
- `memoriesGate.enforceNoteCap` — archives overflow beyond cap for one agent.
- `memoriesGate.enforceCapsAllAgents` — enforces caps across all agents.
- `memoriesGate.startMemorySweeper` — starts the periodic sweep timer.
- `memoriesGate.softSuppressNote` — suppresses without flipping lifecycle.
- `memoriesGate.discardFromContext` — session-hides a note with TTL.
- `memoriesGate.getNoteCap` — returns the configured note cap.
- `memoriesGate.isSuppressionActive` — checks whether suppression still hides a note.
- `memoriesGate.sessionDiscards` — session-scoped discard tracker instance.
- `memoriesGate.reflectionThrottle` — reflection write throttle instance.
- `memoriesGate.jaccardSimilarity` — token-set similarity helper.
- `memoriesGate.normalizeHookTokens` — hook tokenizer helper.
- `memoriesGate.embedText` — embeds text via provider or mock fallback.
- `memoriesGate.embedNote` — embeds one note and persists the vector.
- `memoriesGate.embedNotesBatch` — embeds many notes with bounded concurrency.
- `memoriesGate.ensureEmbeddingsForAgent` — backfills missing agent embeddings.
- `memoriesGate.searchByEmbedding` — vector similarity search over notes.
- `memoriesGate.mockEmbed` — deterministic mock embedding helper.
- `memoriesGate.cosineSimilarity` — cosine similarity helper.
- `mirrorMemoryNote` — upserts one note into the agent's local `memories/<agentId>.jsonl` mirror (locked rewrite).
- `readLocalMemoryNotes` — reads one agent's local mirror (`[]` when missing).
- `scoreLocalNote` — naive degraded substring scorer (no vectors).
- `memoriesGate.mirrorMemoryNote` — mirror port alias.
- `memoriesGate.readLocalMemoryNotes` — local-read port alias.

## Relations
Gates this domain calls:
- `workspace-gate.ts` — `forEachWorkspaceDb` for multi-DB sweep fan-out (`memory-lifecycle.ts:4`, `memory-lifecycle.ts:184`).
- Non-gate internals used: `shared/config/database.ts` (`getDb`, `dbScopeKey`, `runWithDb`), `db/schema.ts` (table/type defs), `shared/core/reflection-sanitizer.ts` (throttle-input sanitizing), `shared/core/untrusted-wrapper.ts` (preview wrapping), `shared/core/structured-log.ts` (`logMetric` for embedding stages), `shared/core/ttl-cache.ts` (resolve cache).
Known outside callers of `memoriesGate` / gate functions:
- Tools: `tool-registry.ts` (`open_memory` → `readMemoryNote`, `discard_memory_from_context` → `discardFromContext`, `remember` → `createMemoryNote`) (`tool-registry.ts:878`, `tool-registry.ts:936-949`, `tool-registry.ts:1065-1087`).
- Runtime: `runtimes/base-runtime.ts` (fire-and-forget reflection auto-write) (`base-runtime.ts:22-51`); `kernel/middlewares/memory-retrieval-middleware.ts` (per-request retrieval + preview injection).
- Sweeps/bootstrap: `shared/core/agent-heartbeat.ts` (`startMemorySweeper` via heartbeat system); `queue/maintenance-worker.ts` (`suppress-expiry` repeatable prefers `runMemorySweep`, falls back to direct `runSuppressionSweep` import); `worker.ts` (import-only keepalive).
- Tests only: `memories.test.ts`, `memory-retrieval.perf.test.ts`, `kernel/context-integrity.test.ts`, `observability` embeddings test.
Tables shared with other domains:
- `agents` / `channels` (read-only existence/validation lookups; owned by Agents/Channels).
- `embedding_model_profiles` (read-only profile lookup here; writers unverified — see Gaps).

## Emits-Listens
- None — this domain neither emits broker events nor subscribes to any.

## Owns
- `agent_memory_notes` (writes: insert, field/lifecycle/suppress/embedding updates)
- `memory_update_log` (writes: fire-and-forget audit inserts)

## Flags
- `MEM_NOTE_CAP` — per-agent active-note cap, default 500 (`memory-lifecycle.ts:74`, `memory-lifecycle.ts:96-98`).
- `MEM_SUPPRESS_SWEEP_MS` — sweep interval, default 10min (`memory-lifecycle.ts:73`, `memory-lifecycle.ts:224-228`).
- `MEM_DISCARD_TTL_MS` — session-discard/soft-suppress TTL, default 30min (`memory-lifecycle.ts:297`, `memory-session-discards.ts:3-21`).
- `MEM_REFLECT_THROTTLE` — master throttle switch, default true (`memory-reflection-throttle.ts:42`).
- `MEM_REFLECT_MIN_INTERVAL_MS` — min interval between reflection writes per agent, default 60s (`memory-reflection-throttle.ts:44`).
- `MEM_REFLECT_SIMILARITY_PCT` — duplicate-hook Jaccard threshold 1–100, default 80 (`memory-reflection-throttle.ts:50`).
- `MEM_RETRIEVAL_WINDOW` — SQL-side candidate window, default 60 (`memory-retrieval.ts:10-14`).
- `EMBEDDING_ENABLED` — true enables real-provider path + semantic lane, default false (`embeddings.ts:37-39`, `memory-retrieval.ts:126-129`).
- `EMBEDDING_MODEL` — env-override model name, bypasses profile-table lookup (`embeddings.ts:59-68`).
- `EMBEDDING_DIMENSIONS` — vector width, default 1536 (`embeddings.ts:41-48`).
- `EMBEDDING_HYBRID_WEIGHT` — semantic blend 0–1, default 0.5 (`embeddings.ts:50-57`, `memory-retrieval.ts:133-134`).
- `EMBEDDING_API_KEY` / `OPENAI_API_KEY` — provider key fallback chain (`embeddings.ts:129`).
- `EMBEDDING_ENDPOINT` — provider endpoint override, default OpenAI embeddings URL (`embeddings.ts:130`).

## Decisions
- [Observed] Result-union instead of throws for domain failures (`AGENT_NOT_FOUND`, `NOTE_NOT_FOUND`, `REFLECTION_THROTTLED/DUPLICATE`) — why: tools and runtime call memory on best-effort paths and must degrade, not crash (`agent-memory-store.ts:121-123`).
- [Observed] Audit and cap enforcement are fire-and-forget — why: bookkeeping must never block the interactive write path (`agent-memory-store.ts:382-384`, `memory-lifecycle.ts:77-94`).
- [Observed] Reflection sanitize-before-throttle — why: dedupe must see the sanitized form or control/block-stripped variants slip past (`agent-memory-store.ts:246-255`).
- [Observed] Soft-suppress keeps `lifecycleStatus` untouched — why: session hides are reversible TTL state, not lifecycle transitions (`memory-lifecycle.ts:268-275`).
- [Observed] Retrieval window is SQL-bounded before JS scoring — why: lane scoring and dedupe must not scan an agent's full history on the hot path (`memory-retrieval.ts:53-66`).
- [Observed] Throttle + session discards are process-local Maps — why: write-guard and session state need no durability; restart safely resets both (`memory-reflection-throttle.ts:37-39`, `memory-session-discards.ts:16-17`).
- [Observed] `numEnv` falls back on any non-positive/non-finite value — why: invalid operator config degrades to defaults instead of breaking queries (`memory-env.ts:1-4`).
- [Observed] Embedding persist tolerates a missing column — why: rollback-safe pre-migration (`embeddings.ts:230-233`).
- [Observed] Ledger-style `runSuppressionSweep` is a standalone function ported as-is to the bullmq repeatable — why: sweep body must run identically inline and queued (`memory-lifecycle.ts:110-141`, `maintenance-worker.ts:67-85`).
- [Inferred] Mock embeddings are deterministic per text — why: tests and disabled-flag deployments still get stable recall behavior without a provider (`embeddings.ts:84-108`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Best-effort retrieval stays; restart semantics, bounds, and embedding ownership are the gaps.
Domain failures use result-union not throws for AGENT_NOT_FOUND, NOTE_NOT_FOUND, throttled reflection. Tools and runtime degrade, never crash on memory paths.
Audit plus cap enforcement stay fire-and-forget but MUST emit a metric on failure. Silent console-only swallow is forbidden.
Soft-suppress keeps lifecycleStatus untouched; session discards are TTL memory. Restart split-brain MUST be an explicit contract: discards vanish, soft-suppress persists, UI handles the merge.
Retrieval window is SQL-bounded before JS scoring. Full-history scans on the hot path are forbidden.
Throttle plus session discards stay process-local Maps with restart-reset documented as safe.
listMemoryPreviews MUST clamp limit like Messages 200-cap. Unbounded preview fetches are forbidden.
resolveAgentId full-table scan on uncached miss MUST be bounded or indexed. Unbounded scan cost is not acceptable.
generateNoteId MUST honor agentId or drop the argument. Ignored-argument IDs are forbidden.
updateMemoryNote reason required versus optional MUST agree between type and runtime.
embedding_model_profiles MUST have a documented writer and owner. Reader-only embedding config is forbidden.
memory_update_log MUST have a documented reader or be labeled write-only audit.
Reachable-but-not-ported helpers (embeddingsGate, hybridScore, caches, buildNoteId, test resets) MUST be ported or removed.
## Failure + Resume
- Unknown agent / unknown note → `{ ok: false }` with `AGENT_NOT_FOUND` / `NOTE_NOT_FOUND`; throttled reflection → `REFLECTION_THROTTLED` / `REFLECTION_DUPLICATE` — none throw (`agent-memory-store.ts:114-120`).
- ID collision retries 3 times, then rethrows the DB error (`agent-memory-store.ts:344-398`).
- Audit insert failure: caught, `console.error`, swallowed (`memory-lifecycle.ts:90-92`); cap-enforcement failure on create: caught, logged, swallowed (`agent-memory-store.ts:382-384`).
- `boolEnv` treats every value except `"false"` (any case) as true — `MEM_REFLECT_THROTTLE=0` does NOT disable the throttle (`memory-env.ts:6-10`).
- Sweep/cap ticks catch per-DB and per-agent, logging without stopping sibling work (`memory-lifecycle.ts:231-243`, `memory-lifecycle.ts:205-211`).
- Embedding provider failure (HTTP error, timeout, missing key) falls back to mock with a `logMetric` stage marker; search falls back from pgvector to JS cosine (`embeddings.ts:146-156`, `embeddings.ts:303-351`).
- Resume is automatic on next tick: sweeper flips elapsed suppressions and archives cap overflow without operator action; session discards self-expire lazily on list (`memory-lifecycle.ts:114-141`, `memory-session-discards.ts:29-38`).

## Gaps
- Record-only DB threading (done for the hot paths): memory CRUD/retrieval/lifecycle accept an optional trailing `workspaceId` opts (`MemoryWorkspaceOpts`); when present the handle resolves via `dbForWorkspace` and a NO_DATABASE/unreachable workspace degrades to the local mirror. Threaded callers: `tool-registry.ts` memory handlers (`ctx.workspaceId`), `memory-retrieval-middleware.ts` (`ctx.workspaceId`), `base-runtime.writeReflectionNoteAsync` (+ `packet.workspaceId` from conversational/agentic/coding runtimes), and the semantic query embed (`embedText` via retrieval). With no workspace context the legacy env-gated path is preserved (`isDatabaseConfigured`), so context-free callers keep prior behaviour. Remaining port surface: `embeddings.ts` note-level ops (`embedNote`/`embedNotesBatch`/`ensureEmbeddingsForAgent`/`searchByEmbedding`) still use the env-gated handle — no production caller carries workspace context yet.
- Record-only DB threading (done for the hot paths): memory CRUD/retrieval/lifecycle accept an optional trailing `workspaceId` opts (`MemoryWorkspaceOpts`); when present the handle resolves via `dbForWorkspace` and a NO_DATABASE/unreachable workspace degrades to the local mirror. Threaded callers: `tool-registry.ts` memory handlers (`ctx.workspaceId`), `memory-retrieval-middleware.ts` (`ctx.workspaceId`), `base-runtime.writeReflectionNoteAsync` (+ `packet.workspaceId` from conversational/agentic/coding runtimes), and the semantic query embed (`embedText` via retrieval). With no workspace context the legacy env-gated path is preserved (`isDatabaseConfigured`), so context-free callers keep prior behaviour. Remaining port surface: `embeddings.ts` note-level ops (`embedNote`/`embedNotesBatch`/`ensureEmbeddingsForAgent`/`searchByEmbedding`) still use the env-gated handle — no production caller carries workspace context yet. Fixed this task: `logMemoryUpdate` accepts workspace opts so audit rows follow the note's DB (MEM-001); degraded local retrieval filters suppressed notes and scopes the mirror read (MEM-002/MEM-003).
- `UPDATE_FAILED` after the ID-allocation loop (`agent-memory-store.ts:400`) looks unreachable — every iteration returns or throws, so the dead-return path is unverified.
- `embeddingsGate` (`embeddings.ts:362-371`), `hybridScore`, `parseStoredEmbedding`, `getCachedEmbeddingVector`, `invalidateEmbeddingCache`, `buildNoteId`, `ListModulesOpts`-style `resetMemorySweeperForTests` bypass the gate — reachable-but-not-ported surface with no contract guarantee.
- `logMemoryUpdate` is a standalone gate export but missing from `memoriesGate` — callers must know the second import path (`memories-gate.ts:40-51`, `memories-gate.ts:75-105`).
- `generateNoteId` ignores its `agentId` argument — per-agent sequences or namespacing are not actually supported (`agent-memory-store.ts:282-284`).
- `updateMemoryNote` type requires `reason` but runtime defaults it — the required/optional contract is inconsistent (`agent-memory-store.ts:88`, `agent-memory-store.ts:600`).
- `resolveAgentId` falls back to a full-table `findMany` scan on every uncached miss — worst-case cost per unknown alias is unverified (`agent-memory-store.ts:236-243`).
- `listMemoryPreviews` applies no upper clamp to `limit` — unbounded preview fetches are possible, unlike Messages' 200-cap (`agent-memory-store.ts:506`).
- `enforceCapsAllAgents` scans all active notes to enumerate agents — cost on large vaults unverified (`memory-lifecycle.ts:196-200`).
- Session discards vanish on restart (in-memory) while soft-suppress rows persist — post-restart visibility of discarded notes is split-brain until TTL lapses (`memory-session-discards.ts:16-17`, `memory-lifecycle.ts:260-266`).
- No REST or socket surface observed — whether operators have any out-of-band memory inspection path beyond tools is unverified.
- `embedding_model_profiles` has no observed writer in this domain — who creates/rotates embedding profiles is unverified.
- Fix task `fix-memories-narrow` (2026-10-07): MEM-007/009/012/019 fixed and verified. Supersedes the `UPDATE_FAILED`-unreachable bullet above (the return is now reachable via the collision-budget break, `agent-memory-store.ts:402-408`) and the `resolveAgentId` full-table-scan bullet (now a bounded `ilike` `findFirst`, `agent-memory-store.ts:238-260`). MEM-007: semantic-lane failures and malformed `EMBEDDING_HYBRID_WEIGHT` emit `logMetric` (`memory-retrieval.ts:156-157,182-188`). MEM-012: only unique-violation/id-collision errors retry; deterministic errors rethrow on the first attempt (`agent-memory-store.ts:396-404`). MEM-019: session discards are read and written in the resolved-UUID key-space (alias callers normalized; UUID fast-path keeps the hot path at one notes query) (`memory-retrieval.ts:53-72`, `memory-lifecycle.ts:301-318`). Regression tests: `memories.test.ts` "MEM-007/009/012/019 · narrow ledger fixes". Verified: `npx vitest run src/memories` 35 passed; `npx tsc -p tsconfig.json --noEmit` exit 0.

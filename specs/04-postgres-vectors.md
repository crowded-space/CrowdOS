# SPEC 4 — Postgres Keeps Vectors / RAG / Memories

## 1. Goal & Non-Goals

### Goal
Define the **keeps-what matrix** and **vector-side contract** for the decision: **Postgres keeps ONLY vectors / RAG / memories; everything else moves to JSON** (separate JSON-store spec).

Concretely this spec:
1. Freezes the exact list of tables that **stay in Postgres** with reasons.
2. Formalizes the vector column contract for `agent_memory_notes` (today split-brain `TEXT` + best-effort `embedding_vec`).
3. Identifies every **non-vector reader that must be cut over** (FK / lookup queries against tables that are leaving Postgres).
4. Defines boot / connection / extension changes when Postgres holds less.
5. Gives ordered build steps including **data migration for existing embeddings**, verification, risks/rollback, and dependencies.

### Non-goals
- **Not** the JSON-store design itself (file layout, atomic writes, locking, roster/messages/channels/runs schema). Covered by the separate JSON-store spec. This spec only defines the Postgres side of the boundary and what the JSON side must provide back (e.g. roster lookup, channel existence).
- **Not** a new embedding provider, reranker, or Librarian LLM upgrade. No model change; only storage/index/fallback contract.
- **Not** removing `EMBEDDING_ENABLED=false` heuristic fallback. Fallback stays as the offline/test path.
- **Not** changing memory UX semantics (cap, suppression TTL, discard TTL, throttle, lane weights). Only where those reads execute.
- **Not** deleting or archiving old migrations. Additive migration only.

---

## 2. Current State (verified, with `file:line`)

All paths relative to `packages/server/src/`.

### 2.1 Embeddings storage / query / fallback — `Memories/embeddings.ts`

| Behavior | Location |
|---|---|
| `embeddingEnabled()` reads `EMBEDDING_ENABLED` (default false) | `Memories/embeddings.ts:29-31` |
| `embeddingDimensions()` defaults `1536` | `Memories/embeddings.ts:33-40` |
| `hybridWeight()` defaults `0.5` | `Memories/embeddings.ts:42-49` |
| `resolveEmbeddingProfile()`: `EMBEDDING_MODEL` env override wins; else first row of `embeddingModelProfiles`; else `null` | `Memories/embeddings.ts:51-76` |
| `mockEmbed(text, dimensions)`: deterministic token-hash → L2-normalized vector | `Memories/embeddings.ts:84-108` |
| `embedText()`: if disabled returns `mockEmbed` immediately; else tries OpenAI-compatible `fetch`, truncates/pads to dimensions, L2-renormalizes; on any failure falls back to `mockEmbed` | `Memories/embeddings.ts:110-156` |
| `cosineSimilarity()` returns `0` on length mismatch | `Memories/embeddings.ts:158-170` |
| `parseStoredEmbedding()`: accepts `number[]`, JSON-stringified array, or pgvector `[0.1,...]` text | `Memories/embeddings.ts:172-193` |
| `embedNote(noteId)`: loads note, embeds `hook\nbrief\ndetailed`, persists **only `TEXT`** via `embedding: JSON.stringify(result.vector)`; never writes `embedding_vec`; catch-and-log if column missing | `Memories/embeddings.ts:195-216` |
| `embedNotesBatch(ids, concurrency=4)` worker pool | `Memories/embeddings.ts:218-232` |
| `ensureEmbeddingsForAgent(agentId, limit=100)`: tries `WHERE agent_id=X AND embedding IS NULL`; on throw falls back to selecting by `agentId` and filtering in JS | `Memories/embeddings.ts:234-264` |
| `hybridScore()`: `(cosine+1)/2` → `heuristic*(1-w)+semantic*w` | `Memories/embeddings.ts:272-287` |
| `searchByEmbedding()`: embeds query, then **(a)** tries native pgvector via `getSqlClient().unsafe()` with `COALESCE(embedding_vec::text, embedding)` + `ORDER BY ... <=> $2::vector LIMIT $3`; on empty/throw falls through to **(b)** JS cosine over a **bounded 60-row window** | `Memories/embeddings.ts:289-337`, native at `301-318`, JS fallback at `321-336` |

**Net:** pgvector is effectively **optional** today. Write path is `TEXT (JSON string)` only. Read path *probes* `embedding_vec` but tolerates its absence. `EMBEDDING_ENABLED=false` means `mockEmbed` hash-vectors everywhere (no provider call).

### 2.2 Memory retrieval lanes — `Memories/memoryRetrieval.ts`

| Behavior | Location |
|---|---|
| `DEFAULT_RETRIEVAL_WINDOW = 60`, `retrievalWindowSize()` from `MEM_RETRIEVAL_WINDOW` | `Memories/memoryRetrieval.ts:10-14` |
| `retrieveMemoryCandidates(input)`: single bounded `findMany` with `agent_id=X AND lifecycleStatus='active'`, `ORDER BY importanceScore DESC, noteTimestamp DESC`, `LIMIT windowSize`; then in-JS suppression + session-discard filters | `Memories/memoryRetrieval.ts:49-69` |
| Heuristic lanes: `recent_episodic` (1.0), `high_importance ≥0.7` (0.8), `mentions` (0.6), `unresolved_tensions` (0.9), `recency <2d` (0.5); max-score merge + dedupe | `Memories/memoryRetrieval.ts:95-114` |
| Semantic lane: gated on `EMBEDDING_ENABLED==true && userMessageText`; re-parses stored JSON/array/pgvector, skips on length mismatch, requires `semanticScore>0.3`, blends with `EMBEDDING_HYBRID_WEIGHT` (default 0.5); whole block silent `try/catch` | `Memories/memoryRetrieval.ts:118-156` |
| `buildMemoryPreviewBlock()`: `wrapUntrusted("memory", hook/brief)` block | `Memories/memoryRetrieval.ts:168-180` |

### 2.3 Librarian RAG: `channelIndex` / `compressedSummaries` lifecycle — keyword/LLM-summary, not vector

Schema: `channelIndex` (`channel_id PK→channels.id cascade`, `channel_path`, `topic_summary`, `last_indexed_at`, `last_seq`, `messageCountSinceIndex`, `status`, `lastError`) at `db/schema.ts:359-368`; `compressedSummaries` (`id PK`, `channel_id→channels.id cascade`, `summary`, `coversUpToSeq`) at `db/schema.ts:370-376`.

Lifecycle:

| Behavior | Location |
|---|---|
| `IndexBuilder.incrementMessageCount(channelId)`: validates `channels` row exists (FK guard), then `+1` or inserts `Empty channel` row | `Shared/core/indexBuilder.ts:16-43` |
| `pendingDeltaCount`: bounded scan `LIMIT 10` past `lastSeq` | `Shared/core/indexBuilder.ts:49-63` |
| `reindexStaleChannels(broker)`: requires `agent-librarian` row; loads **all** `channelIndex`; delta mode: `status==degraded` or drift `>=10` → `indexChannel`; legacy: `degraded \|\| messageCountSinceIndex>=10` | `Shared/core/indexBuilder.ts:71-125` |
| `deltaIndexEnabled()`: default **on** | `Shared/core/librarianRuntime.ts:28-30` |
| `indexChannel`: delta summarizes only `sequenceNumber > lastSeq` prepended with previous summary; empty → `upsertIndex(emptySummary)`; resolves model module, calls provider, degrades (never fabricates) on failure | `Shared/core/librarianRuntime.ts:189-315` |
| `markIndexDegraded()`: sets `status='degraded'`, `lastError`, emits `index:degraded` | `Shared/core/librarianRuntime.ts:317-346` |
| `upsertIndex()`: upserts `channelIndex` **and** appends a `compressedSummaries` row every pass — append-only history, no pruning | `Shared/core/librarianRuntime.ts:348-387` |
| `handleSearchCommand(query, workspaceId)`: **keyword `includes`** over `topicSummary` + `channelPath`, workspace-scoped; no vector, no ranking | `Shared/core/librarianRuntime.ts:459-490` |
| Duplicate keyword search in tool `search_index` handler | `tools/toolRegistry.ts:813-845` |
| `MemoryBuilder.getOrUpdateSummary()`: second compressed-summary writer (naive fallback), cache-hit when `coversUpToSeq >= upToSeq` | `core/MemoryBuilder.ts:437-482` |

### 2.4 `memoryLifecycle` + `agentMemoryStore` tables touched

`Memories/agentMemoryStore.ts`: `resolveAgentId()` (`162-192`, `agents` scan); `createMemoryNote()` (`212-310`, validates `agents` row + `channels` row with null-fallback, throttle/dedupe, retry id, `logMemoryUpdate`, fire-and-forget cap); `readMemoryNote()` + access bump (`312-334`); `listMemoryPreviews()` (`336-379`, filters + suppression); `update/archive/suppress` (`381-522`); `toPreview()`/`toFull()` (preview projection **drops** embedding fields).

`Memories/memoryLifecycle.ts`: `logMemoryUpdate()` fire-and-forget (`31-48`); `isSuppressionActive` (`55-62`); `runSuppressionSweep` flip-suppressed-to-active (`68-95`, LIMIT 500); `enforceNoteCap` (default 500, victims by importance ASC) (`105-145`); `enforceCapsAllAgents` (`148-164`); `startMemorySweeper` 10min interval (`166-195`); `softSuppressNote`/`discardNoteFromContext` (`198-248`).

`Memories/memorySessionDiscards.ts`: pure in-memory `Map` — **no Postgres**. Already JSON-move-safe.

`Memories/memoriesGate.ts`: thin facade re-exporting store + retrieval + lifecycle + embeddings.

### 2.5 Extension / boot calls

- `ensurePgVectorExtension()`: `CREATE EXTENSION IF NOT EXISTS vector`, swallows `23505/42710`, rethrows rest (`Shared/config/database.ts:59-76`).
- Pool: `postgres(DATABASE_URL, {prepare:false, max:20, ...})`; `getDb()` singleton; `closeDatabaseConnection()` nulls both.
- `bootstrap main()`: `applyMigrations()` → `ensurePgVectorExtension()` → `seed()` (`db/bootstrap.ts:496-507`); `LEGACY_BOOTSTRAP=true` takes `ensureSchema()` DDL path instead.
- Legacy DDL: `agent_memory_notes` has **no** `embedding*` columns in legacy path; `channel_index` legacy omits `last_seq/status/last_error`.
- Migration `0009_phase7_scale_observability.sql`: extension + `embedding TEXT` + best-effort `embedding_vec vector(1536)` + HNSW inside swallowed-exception block + `cost_ledger_per_run` view.
- Drizzle `agentMemoryNotes`: `embedding TEXT`, `embeddingModel`, `embeddingUpdatedAt`, composite index `(agentId, lifecycleStatus, noteTimestamp DESC)` — **no `embedding_vec` in Drizzle, no vector index in Drizzle** (`db/schema.ts:383-430`).
- Env: `EMBEDDING_ENABLED=false`, `EMBEDDING_MODEL?`, `EMBEDDING_DIMENSIONS=1536`, `EMBEDDING_HYBRID_WEIGHT=0.5`; `DELTA_INDEX` default true.
- Tests mock the extension (`memories.test.ts:10`, `memoryRetrieval.perf.test.ts:10`, `test-setup.ts:192`) — memory unit tests **never exercise native vector**, only JS fallback.

---

## 3. Target Design

### 3.1 Explicit keeps-what matrix

**Stay in Postgres (5 tables + 1 companion view + 1 extension):**

| # | Table (Postgres) | Reason to keep |
|---|---|---|
| K1 | `agent_memory_notes` | Core memory vault **and** vector store. Only table with a real similarity-search need (`ORDER BY embedding_vec <=> query LIMIT k`). Bounded hot-path index already exists. Moving multi-KB bodies + vectors to JSON would regress recall window and blow up file I/O per retrieval. |
| K2 | `embedding_model_profiles` | Embedding contract source of truth (`provider/modelName/dimensions/apiKey/endpointUrl`). Dimension must match the vector column or every query silently scores `0`. Keep next to the vectors it versions. |
| K3 | `channel_index` | Librarian RAG cursor + summary cache (`last_seq`, `topic_summary`, `status/lastError`). Hot-read by every `indexChannel` / `reindexStaleChannels` / keyword search. Small row count, transactional upsert with `compressedSummaries`. |
| K4 | `compressed_summaries` | Append-only RAG history backing `MemoryBuilder.getOrUpdateSummary` cache-hit (`coversUpToSeq >= upToSeq`) and Librarian delta prepend. Keep with K3 so cursor + history stay in one transaction. Needs retention cap (see §3.4). |
| K5 | `memory_update_log` | Memory audit trail. Fire-and-forget writes on every mutation; FK `note_id → agent_memory_notes.id CASCADE`. Splitting it to JSON while notes stay in PG breaks the cascade and forces dual cleanup. |
| K6 | `cost_ledger_per_run` VIEW (keep, do not extend) | Already defined in `0009`; harmless convenience view. Keep so dashboards don't break during the JSON move. Drop in a later cleanup once JSON ledger ships. |
| — | `vector` extension | Required for `embedding_vec` + HNSW. Keep `ensurePgVectorExtension()` as a boot step (fail-fast). |

**Move to JSON (everything else — non-exhaustive, JSON spec owns the list):**
`agents`, `channels`, `categories` (incl. `embedding_profile_id` FK — becomes a string id validated in app, not a DB FK), `messages`, `channel_sequences`, `model_modules`, `instruction_modules`, `toolkit_modules`, `constraints_modules`, `capabilities_modules`, `indexing_model_profiles`, `tools`, `agent_tools`, `skills`, `agent_skills`, `mcp_servers`, `dynamic_tools`, `runs`, `spawn_requests`, `task_files`, `scheduled_tasks`, `token_usage_log` (base table), `runtime_states`, `runtime_overrides`, `workspace_*`, `durable_events`, `approvals`, `artifacts`, `workflows`, etc.

**Boundary rule for this spec:** after the cut, **no query in `Memories/` or `Shared/core/{indexBuilder,librarianRuntime}` may import or `from()` a moved table.** The only cross-boundary reads allowed are via gates that the JSON spec provides (roster gate, channel gate). Any remaining `import { agents, channels, messages, ... } from "../../db/schema.js"` in those files is a spec violation.

### 3.2 Vector column decision — **RECOMMENDED: formalize real `embedding_vec vector(N)` + HNSW, keep `TEXT` as write-through compat for one release**

**Recommendation: add the real column formally (Option A). Do NOT keep TEXT+fallback as the steady state.**

Rationale:
- Today is split-brain: Drizzle knows only `embedding TEXT`, raw SQL probes `embedding_vec`, migration creates it best-effort-or-silently-skips. Result: two sources of truth, rank-approximated scores on the native path, silent `0` on dimension mismatch, and a 60-row JS recall ceiling.
- A real `vector(N)` column with HNSW removes per-row `JSON.parse` + full-window transfer, makes `LIMIT k` execute index-side, and makes dimension mismatches a **loud** write-time error instead of silent recall loss.
- Cost is one additive migration + backfill; HNSW build on memory-scale tables (hundreds–thousands of rows/agent) is seconds, not hours.

Contract (Option A):
1. `embedding_vec vector(1536)` becomes a **first-class Drizzle column** (not raw-SQL-only). Dimension is pinned to `EMBEDDING_DIMENSIONS` at migration time; changing dimensions requires a new migration.
2. Index: `CREATE INDEX CONCURRENTLY agent_memory_notes_embedding_vec_idx ... USING hnsw (embedding_vec vector_cosine_ops)` (same shape as `0009`, but created unconditionally, not inside a swallowed-exception block).
3. Write path becomes **dual-write for one release**: `embedNote()` writes both `embedding` (TEXT JSON, existing readers) and `embedding_vec` (parsed float array). Then a backfill fills old rows. Then reads flip to native-first with JS fallback retained for `EMBEDDING_ENABLED=false` / missing extension.
4. `EMBEDDING_ENABLED=false` behavior unchanged: `mockEmbed` vectors still flow through the same columns (keeps tests deterministic); native query still attempted but test fakes throw on `getSqlClient` so JS fallback covers them.

**Rejected alternative (Option B — keep TEXT + JS fallback):** zero migration, but keeps O(window) parse+score per retrieval, keeps the 60-row recall ceiling, and leaves dimension skew silent. Acceptable only if the team explicitly defers vector search to a later quarter — record that deferral, do not drift into it by accident.

### 3.3 Non-vector readers that must be cut over

These queries touch moved tables today and **must not** hit Postgres after the split:

| # | Current code | Illegal-after-cut dependency | Cut-over to |
|---|---|---|---|
| C1 | `agentMemoryStore.resolveAgentId()` — `agents.findFirst` + `findMany` scan | `agents` moves to JSON | Roster gate / JSON agent lookup (name/title/handle → id). Keep signature; swap body. |
| C2 | `agentMemoryStore.createMemoryNote()` channel validation | `channels` moves to JSON | Channel gate `exists(channelId)` / `getById`. On miss keep current behavior: `validChannelId = null` (no FK throw). Remove the Drizzle `channels` import. |
| C3 | `indexBuilder.incrementMessageCount()` channel guard | `channels` moves to JSON | Channel gate existence check. `channelIndex` write stays PG. |
| C4 | `librarianRuntime.indexChannel()` channel+category fetch, message window fetch, agent status flip | `channels`, `categories`, `messages`, `agents.status` move to JSON | Channel/message/registry gates for reads; reply persistence goes through the message gate (JSON). `channelIndex`/`compressedSummaries` writes stay PG. `agents` status flip becomes a registry event, not a PG `update`. |
| C5 | `librarianRuntime.handleIndexAll/handleIndexChannel/handleSearchCommand` channel listings | `channels` moves to JSON | Workspace-scoped channel listing gate. `channelIndex` filtering stays PG. |
| C6 | `toolRegistry search_index` handler reading `channelIndex` | None PG-illegal (reads K3, fine) but must not reintroduce `channels` join | Keep reading K3 only; workspace scoping comes from the channel gate's id set, not a PG join. |
| C7 | `memoryLifecycle.enforceCapsAllAgents()` distinct-agent scan | Self-contained on K1, **stays PG** — listed to prevent accidental "optimization" into the JSON roster | No change except: do not replace with roster listing (note table is the source of truth for who needs capping). |
| C8 | Suppression + session discards | K1 columns / pure memory — **stay as-is** | No PG/JSON change. Session discards remain in-process `Map`; do not persist to JSON (TTL semantics depend on ephemerality). |

What **stays on PG untouched** (non-vector but K1-local): `listMemoryPreviews` filters, `runSuppressionSweep`, `enforceNoteCap`, `logMemoryUpdate`, retrieval window query.

### 3.4 RAG lifecycle adjustments (stay in PG, bounded)

- `compressedSummaries` is append-only today (every `upsertIndex` + `getOrUpdateSummary` inserts). Add a retention cap: `DELETE ... WHERE channel_id=X ORDER BY covers_up_to_seq DESC LIMIT 20` per channel (`RAG_SUMMARY_KEEP=20` default), run from the existing `librarian-delta` maintenance tick.
- Keep `status='degraded'` + `lastError` semantics — the JSON move must not "heal" degraded rows by dropping the columns.
- Keyword search stays keyword in this spec. Vectorizing channel summaries is explicitly out of scope; if wanted later it gets its own `channel_index.embedding_vec` migration, not scope creep here.

### 3.5 Connection / extension boot changes when Postgres holds less

- **Keep `ensurePgVectorExtension()` and call it before migrations**, not after. Today `bootstrap main()` runs `applyMigrations()` → `ensurePgVectorExtension()`; flip to extension-first so the `embedding_vec` DDL never runs without the type present (removes the need for the swallowed-exception block).
- **Keep `seed()`'s and `check.ts`'s `ensurePgVectorExtension()` calls** (idempotent, cheap).
- **Do not shrink the pool yet.** `max:20` is fine; memory + RAG burst on `embedNotesBatch(concurrency=4)` and parallel delta checks still benefit. Revisit after JSON move proves steady-state QPS drop.
- **Legacy `ensureSchema()` DDL path** must gain the `embedding*` columns + `embedding_vec` + HNSW + `channel_index.last_seq/status/last_error` if kept one more release; otherwise delete the path with the JSON spec (preferred — already behind `LEGACY_BOOTSTRAP=true`).
- `getSqlClient()` stays exported — `searchByEmbedding` native path depends on it. The memory test fake that throws on `getSqlClient` remains the sanctioned way to force JS-fallback coverage.

---

## 4. Expected Files Touched

| File | Change |
|---|---|
| `db/schema.ts` | Add `embeddingVec` vector column + HNSW index declaration to `agentMemoryNotes`; no other table changes. |
| `db/migrations/0012_vectors_formalize.sql` (new — renumber if JSON spec already took `0012`) | `CREATE EXTENSION IF NOT EXISTS vector`; `ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)`; `CREATE INDEX CONCURRENTLY ... USING hnsw`; `ANALYZE agent_memory_notes`. Unconditional (no swallowed exceptions). Follow-up migration per dimension change. |
| `scripts/backfill-embedding-vec.ts` (new, one-shot) | `TEXT embedding` → `embedding_vec::vector` backfill with dimension guard + skip-and-log. |
| `Memories/embeddings.ts` | Dual-write `embedding_vec` in `embedNote`; native query becomes primary with dimension-pinned literal; JS fallback retained; `ensureEmbeddingsForAgent` also backfills `embedding_vec`. |
| `Memories/agentMemoryStore.ts` | C1: `resolveAgentId` → roster/JSON gate. C2: channel validation → channel gate; drop `agents`/`channels` imports. |
| `Memories/memoryRetrieval.ts` | No logic change; verify no new imports of moved tables; keep window + suppression + discards + semantic lane. |
| `Memories/memoryLifecycle.ts`, `Memories/memorySessionDiscards.ts` | No PG change (K1-local + in-memory). Only import-path fixes if gate signatures move. |
| `Shared/core/indexBuilder.ts` | C3: channel guard → channel gate; rest unchanged. |
| `Shared/core/librarianRuntime.ts` | C4/C5: channel/category/message/agent reads → JSON gates; `channelIndex`/`compressedSummaries` writes stay; add summary retention prune. |
| `tools/toolRegistry.ts` | `search_index` handler workspace scoping via gate id-set; no PG join. |
| `core/MemoryBuilder.ts` | No move; add prune call after insert. |
| `db/bootstrap.ts`, `db/seed.ts`, `db/check.ts`, `Shared/config/database.ts` | Boot order flip; keep extension calls; legacy DDL catch-up or deletion. |
| `Shared/config/env.ts` | Document `EMBEDDING_*` + `DELTA_INDEX` + new `RAG_SUMMARY_KEEP`; no default flips in this spec (config spec owns flips). |
| Tests (no prod change) | `memoryTestDb.ts` gains `embedding_vec`-aware fake column; existing suites stay green (see §6). |

Out of scope: any file solely serving moved tables (runs/channels/messages UI, billing, approvals) — owned by JSON spec.

---

## 5. Ordered Steps

1. **Freeze the matrix.** Get JSON-spec + config-spec owners to sign §3.1 (5 tables + view + extension stay; `categories.embedding_profile_id` becomes app-validated string). No code until signed — prevents mid-migration FK resurrection.
2. **Add migration `0012_vectors_formalize.sql`.** Extension + `ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)` + HNSW (`IF NOT EXISTS` for idempotency on DBs where the best-effort block already ran) + `ANALYZE`. Verify `drizzle-kit generate` produces empty diff on existing DBs.
3. **Promote `embedding_vec` in Drizzle schema.** Keep `embedding TEXT` alongside. Confirm generate produces no-op diff.
4. **Dual-write in `embedNote()`**: set both `embedding` (TEXT JSON) and `embeddingVec`. Dimension guard: on mismatch log `embedding.dim_mismatch` and write TEXT only (never fail the note write).
5. **Backfill script + run.** `SELECT id, embedding WHERE embedding IS NOT NULL AND embedding_vec IS NULL LIMIT 500` loop; `JSON.parse`, length check, `UPDATE ... SET embedding_vec`. Mismatches/nulls logged and skipped. Run on staging first; record counts. Expected volume bounded by note cap (500/agent).
6. **Cut over C1–C2 (memory store).** Swap `resolveAgentId` body and channel validation to JSON gates; delete `agents`/`channels` imports. Run `memories.test.ts` after each swap.
7. **Cut over C3–C6 (RAG).** Channel guard, channel/category/message/agent reads, workspace scoping. Keep all `channelIndex`/`compressedSummaries` statements byte-identical.
8. **Flip boot order** to extension-first. Decide legacy DDL fate (catch up or delete with JSON spec).
9. **Add `compressedSummaries` retention prune** (keep 20/channel, `RAG_SUMMARY_KEEP`) into the `librarian-delta` tick path. Verify `getOrUpdateSummary` cache-hit still works.
10. **Flip native-first reads.** `searchByEmbedding` stays structurally identical but now reliably hits populated `embedding_vec` + HNSW; JS 60-row fallback remains. Keep scoring contract stable for this release.
11. **Docs + handoff.** Update JSON spec's "Postgres still owns" appendix with §3.1 table list; update config spec with `EMBEDDING_*` + `RAG_SUMMARY_KEEP` semantics. Announce dimension-change procedure (new migration, never env-only).

---

## 6. Verification

| Check | Command / setup | Must pass |
|---|---|---|
| Memory CRUD + lifecycle + suppression + caps + throttle + discards | `vitest run src/Memories/memories.test.ts` | All `MEM-1a/1b/1c/1d/1e`, `MEM-2` suites green: suppression-expiry, sweep flip + log, cap archive, discard TTL + preview exclusion. |
| Bounded retrieval window | `vitest run src/Memories/memoryRetrieval.perf.test.ts` | Exactly 1 notes query at 200 and 5000 notes; window membership; `MEM_RETRIEVAL_WINDOW=5` tightening; candidate shape. |
| Embedding math (no DB) | `vitest run src/Memories/embeddings.test.ts` | `mockEmbed` determinism + norm≈1; cosine identity/orthogonal/opposite; `hybridScore` ordering; synthetic recall@10 hybrid ≥ heuristic and ≥0.6. |
| Fallback with vectors off | `EMBEDDING_ENABLED=false vitest run src/Memories/memories.test.ts src/Memories/memoryRetrieval.perf.test.ts src/Memories/embeddings.test.ts` | Green; proves heuristic lanes + `mockEmbed` + JS 60-row path cover the product with no provider key. Repeat with `EMBEDDING_ENABLED=true` + no keys to prove mock-fallback. |
| Native vector path (staging DB with `vector` ext) | Seed 200 notes, run `ensureEmbeddingsForAgent`, assert `embedding_vec IS NOT NULL` == embedded count; `EXPLAIN searchByEmbedding` uses HNSW index; returns `limit` rows with no throw on real PG (unit fakes throw by design — this check must run against real PG, not `memoryTestDb`). | Index used; no rank-approximation regression; dimension-mismatch rows skipped, not erroring. |
| RAG keyword path unchanged | Exercise `handleHelpCommand` / `handleSearchCommand` / `reindexStaleChannels` on staging; force provider failure and assert `status='degraded'` + `lastError` set and retry surfaces promptly. | Degraded marker visible in both help report and `search_index` output. |
| Boot order | `LEGACY_BOOTSTRAP` unset: `bootstrap` logs migrations → extension → seed; `check.ts` round-trip green. | No missing-column `embedding.persist.skip` metrics. |
| Backfill audit | Run backfill script twice; second run reports `embedded:0`; remaining NULLs only dimension-mismatched rows, each logged. | Idempotent; no overwrites of existing `embedding_vec`. |

---

## 7. Risks & Rollback

| Risk | Impact | Mitigation / Rollback |
|---|---|---|
| **RAG quality regression** — cutting channel/message reads to JSON gates changes ordering/visibility | Stale or cross-workspace summaries; degraded rows misreported | Keep RAG SQL byte-identical; gate adapters must preserve filters (`archivedAt IS NULL`, `isInternalMonologue=false`). Rollback: revert gate-swap commits only (RAG reads), PG tables untouched. |
| **Dimension mismatch** — `EMBEDDING_DIMENSIONS` changed via env without migration | Recall collapse (silent) or write errors (loud) | Pin dimension in migration name; `embedNote` dual-write guard logs `embedding.dim_mismatch` and never fails the note; backfill skips mismatches. Rollback: set env back, re-run backfill. |
| **Index build time / write amplification** — non-concurrent `CREATE INDEX` locks writes; dual-write + backfill doubles bytes | Boot stall; `embedNote` latency bump | Use `CONCURRENTLY` (separate statement/script); backfill in 500-row batches off-peak; `ANALYZE` after. Rollback: `DROP INDEX CONCURRENTLY IF EXISTS` — TEXT path + JS fallback keep product working. |
| **TEXT ↔ vector drift during dual-write window** | Native and fallback disagree | `updateMemoryNote` hook edits enqueue `embedNote` refresh (fire-and-forget); backfill script is re-runnable and heals drift. |
| **`compressedSummaries` unbounded growth** | Disk bloat on the small PG | Ship retention prune in the same release (default keep 20). Rollback: prune is delete-only with ordering — reindex rebuilds from messages (JSON) if over-pruned. |
| **FK removal fallout** — dropping `channels.id` / `agents.id` FK enforcement orphans memory/channel-index rows | Dangling ids; cascade deletes stop working | App-level handling first (C2 null-fallback, workspace-delete fan-out replicating cascades). Rollback: re-add FKs only if JSON move reverts. |
| **Boot-order flip breaks fresh installs** — extension-first requires superuser rights earlier | Install abort | Already swallows known codes; managed-Postgres without `vector` fails loud with pre-existing error. Rollback: revert two-line order swap. |

**Global rollback posture:** every step is additive or swap-behind-same-signature. No table drops, no column drops, no default flips in this spec. Worst case: drop the HNSW index, revert gate swaps, product runs exactly as today (TEXT + JS 60-row fallback).

---

## 8. Dependencies

- **JSON-store spec must agree on the matrix (§3.1).** Blockers: (a) roster lookup API replacing `resolveAgentId` with identical match semantics; (b) channel `exists/getById/listByWorkspace`; (c) message window read + reply write; (d) workspace-delete fan-out replicating cascades; (e) `categories.embedding_profile_id` becomes unenforced string. Until these exist, C1–C6 cannot merge.
- **Config spec owns `EMBEDDING_*` flags.** No default flips here. Config spec must own `RAG_SUMMARY_KEEP` (new, default 20), dimension-change procedure (env + migration lockstep, never env-only), and `MEM_*` ownership. Any `EMBEDDING_DIMENSIONS` change without migration is a recall outage.
- **Infra:** Postgres must have the `vector` extension available (same requirement as today). No new infra (no separate vector DB, no Redis change, no BullMQ change).

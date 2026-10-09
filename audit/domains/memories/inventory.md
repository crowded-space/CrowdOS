# Memories Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/memories/` (13 files, 2 test suites + 1 perf suite), facade `memories-gate.ts`, all importers (tools/runtime/queue/heartbeat/worker), persistence (schema + migrations 0000/0003/0005/0009), tests, docs. Read-only: no production edits, no branch, no commit.
Method: full read of every domain file; every cross-domain import site grep-verified; schema/migration inspection; baseline commands run (`npx vitest run src/memories`, `node scripts/check-gates.mjs`, `npx tsc -p tsconfig.json --noEmit`).
Time-box note: Phase 1-4 covered for the domain surface; a small number of residual unknowns are marked Low-confidence below.

## 1. Domain files (all read)

| File | Bytes | Role |
| --- | --- | --- |
| `memories-gate.ts` | 2965 | Facade: 28 `memoriesGate` ports + flat re-exports + 15 type re-exports |
| `agent-memory-store.ts` | 27089 | DB owner: CRUD, resolveAgentId + TTL cache, note-id builder, local-degraded paths |
| `memory-lifecycle.ts` | 10315 | Sweeps, caps, audit log, workspace DB resolver, sweeper timer, soft-suppress/discard |
| `memory-retrieval.ts` | 8563 | Multi-lane retrieval + semantic lane + preview block + degraded local search |
| `embeddings.ts` | 14425 | Mock/real embeddings, per-note persist, batch, vector search, cache, non-gated `embeddingsGate` |
| `memory-reflection-throttle.ts` | 2717 | In-process min-interval + Jaccard dedupe (25-hook ring) |
| `memory-session-discards.ts` | 1533 | In-process TTL map keyed `agentId:channelId` |
| `memory-local-store.ts` | 5807 | Degraded JSONL mirror under `<workspaceFolder>/vfs/.crowdos/memories/<agentId>.jsonl` |
| `memory-env.ts` | 371 | `numEnv` / `boolEnv` readers |
| `memory-test-db.ts` | 12619 | Scripted drizzle-shaped test double (maps 4 tables) |
| `memories.test.ts` | 19184 | 21 tests: MEM-1a..1e, MEM-2, timer site |
| `memory-retrieval.perf.test.ts` | 6074 | 4 tests: PERF-2 bounded window |
| `embeddings.test.ts` | 3223 | 3 tests: mock/normalize, cosine, hybrid recall |

Naming (AGENTS.md §1): all `*.ts` kebab-case; gate is `memories-gate.ts`. Compliant.

## 2. Facade surface (exact)

Flat exports (`memories-gate.ts:31-77`): `resolveAgentId, generateNoteId, createMemoryNote, readMemoryNote, listMemoryPreviews, updateMemoryNote, archiveMemoryNote, suppressMemoryNote, retrieveMemoryCandidates, buildMemoryPreviewBlock, runMemorySweep (= runSuppressionSweep), enforceNoteCap, enforceCapsAllAgents, startMemorySweeper, softSuppressNote, discardNoteFromContext, getNoteCap, isSuppressionActive, logMemoryUpdate, memorySessionDiscards, reflectionThrottle, jaccardSimilarity, normalizeHookTokens, mirrorMemoryNote, readLocalMemoryNotes, scoreLocalNote`; types `MemoryUpdateAction, MemoryUpdateLogInput, MemoryWorkspaceOpts, MemoryNoteType, MemoryConfidence, MemorySourceType, MemoryValence, MemoryLifecycleStatus, MemoryNotePreview, MemoryNoteFull, CreateMemoryNoteInput, UpdateMemoryNotePatch, MemoryListFilter, MemoryStoreError, MemoryStoreResult, MemoryCandidate, RetrievalInput`.

`memoriesGate` object (`:79-111`, 28 ports): the above minus `logMemoryUpdate`, with aliases `runMemorySweep`, `discardFromContext`, `sessionDiscards`, plus `embedText, embedNote, embedNotesBatch, ensureEmbeddingsForAgent, searchByEmbedding, mockEmbed, cosineSimilarity`.

Gate purity: imports only from own domain + re-exports; no logic/fetch/DB/branching. Compliant with AGENTS.md §2.

## 3. Entities

- `agent_memory_notes` (schema.ts:411-458): id text PK `YYYY-MM-DD-<12hex>`; agentId FK cascade; channelId FK set-null; enums noteType(7)/confidence(3)/sourceType(5)/valence(5)/lifecycle(3); importance real; accessCount int; links/contradictionFlags jsonb; archivedAt/archiveReason; suppressedAt/suppressReason/suppressUntil; hook/brief NOT NULL; 6 body text columns; embedding text + embeddingModel + embeddingUpdatedAt; created/updatedAt; index `(agent_id, lifecycle_status, note_timestamp DESC)`.
- `memory_update_log` (schema.ts:460-470): id text PK, agentId nullable, action text, noteId FK cascade, timestamp, reason, fieldsChanged jsonb, previousValues jsonb.
- `embedding_model_profiles` (schema.ts:178-188): read-only here (first-row lookup); written by `routes/providers.ts:203-236` (Providers/Studio domain) and `db/backfill-encrypt-secrets.ts`.
- Migrations: 0000 baseline tables; 0003 adds log agentId/action; 0005 index; 0009 adds embedding text cols + best-effort `embedding_vec vector(1536)` + HNSW index.

## 4. Invariants (summary; full list in invariants.md)

INV-1 note ids unique per day (2^48 space, 3-attempt retry). INV-2 auto-reflection sanitized before throttle check + record. INV-3 throttle/dedupe only for `reflection+self_reflection`. INV-4 lifecycle one-way for archive/suppress (update never touches lifecycle). INV-5 active listing excludes actively-suppressed unless includeSuppressed. INV-6 retrieval window SQL-bounded then topK. INV-7 all memory reads/writes scoped by resolvedAgentId. INV-8 domain failures are result-union; only repeated DB errors throw. INV-9 audit + cap are fire-and-forget (never fail the write). INV-10 degraded mode: no PG ⇒ local mirror only.

## 5. Dependency map

```
Caller → Facade → Service/Owner → Port/Adapter → Persistence
tool-registry.ts:860  (open_memory)          → readMemoryNote      → db.query.agentMemoryNotes (+ local fallback) → PG agent_memory_notes / JSONL mirror
tool-registry.ts:935  (discard_memory…)      → discardFromContext  → softSuppressNote → agent_memory_notes + memorySessionDiscards (Map)
tool-registry.ts:1060 (remember)             → createMemoryNote    → sanitizer + reflectionThrottle + insert + logMemoryUpdate + enforceNoteCap(async)
memory-retrieval-middleware.ts:11            → retrieveMemoryCandidates/buildMemoryPreviewBlock → agent_memory_notes window + sessionDiscards + embeddings (dynamic import)
base-runtime.ts:65    (reflection autowrite) → createMemoryNote
agent-heartbeat.ts:2  (startHeartbeatSystem) → startMemorySweeper   → forEachWorkspaceDb(workspace-gate) → runWithDb → runSuppressionSweep + enforceCapsAllAgents
maintenance-worker.ts:75 (suppress-expiry)   → memoriesGate.runMemorySweep (fallback flat runSuppressionSweep)
worker.ts:4           (import keepalive)     → memoriesGate
```

Gate-to-gate: memories → `workspace/workspace-gate.js` (`forEachWorkspaceDb`, memory-lifecycle.ts:4,231). No other gate deps. No cycles involving memories.

## 6. Callers / importers (grep-verified)

| Site | Line | Port |
| --- | --- | --- |
| `tools/tool-registry.ts` | 860, 927-935, 1060 | readMemoryNote, discardFromContext, createMemoryNote |
| `runtime/kernel/middlewares/memory-retrieval-middleware.ts` | 11 | retrieveMemoryCandidates, buildMemoryPreviewBlock |
| `runtime/runtimes/base-runtime.ts` | 65 | createMemoryNote (fire-and-forget) |
| `shared/core/agent-heartbeat.ts` | 2, 65 | startMemorySweeper |
| `queue/maintenance-worker.ts` | 75-86 | runMemorySweep (dynamic, defensive fallback to flat export) |
| `worker.ts` | 4, 34 | keepalive import |
| Tests: memories.test.ts, memory-retrieval.perf.test.ts, embeddings.test.ts | — | via gate/flat |
| Test bypass (TEST-ONLY finding): `runtime/kernel/context-integrity.test.ts` | 76,79,133,156,412 | imports `memory-test-db.js` + `memory-retrieval.js` directly |

## 7. Entry points

Tools (authLevelRequired 3): `open_memory`, `remember`, `discard_memory_from_context`. Runtime middleware (every agent turn). Heartbeat timer (inline mode). BullMQ repeatable `suppress-expiry` (10 min, repeatables.ts:15). No REST/socket surface (confirmed: routes/* grep shows none).

## 8. Persistence / adapters / config

Adapters: drizzle PG (primary), JSONL mirror (degraded), in-memory Maps (throttle/discards/embedding cache/resolve cache). Config: MEM_* + EMBEDDING_* envs documented in env.ts:175-182, 244-248 and Memories.md Flags. Tenant: `MemoryWorkspaceOpts.workspaceId` threaded through CRUD/retrieval/lifecycle; embeddings note-level ops still env-gated (documented gap). No txn usage in this domain (no `withTransaction` call sites). No broker events emitted/listened (docs confirm; grep shows none).

## 9. Test coverage summary

21 memories tests + 4 perf + 3 embeddings = 28 passing. Covered: id format/no-DB-query, suppression expiry (retrieval/list/sweep), cap archive, audit actions, throttle/dedupe + disable + non-reflection, discard tool path + session-only hide + unknown note + no-context, timer registration, bounded window + byte-compatible shape, mock/cosine/hybrid recall. Not covered: see test-gaps.md.

## 10. Gaps / flags (Low-confidence items marked)

- G1 (Low): `UPDATE_FAILED` return at agent-memory-store.ts:400 appears unreachable (every loop iteration returns/throws) — matches docs Gaps; unverified by instrumentation.
- G2: `embeddingsGate` (embeddings.ts:362-371) + `hybridScore`/parse/cache helpers bypass `memoriesGate`; only gate object reachable surface for embedNote/…; no production caller for note-level embedding ops (docs state "remaining port surface").
- G3: `logMemoryUpdate` is exported flat but NOT on `memoriesGate` — inconsistent facade.
- G4: `generateNoteId(agentId)` ignores its argument (agent-memory-store.ts:282-284).
- G5: `updateMemoryNote` `reason` required by type, defaulted at runtime (:600).
- G6: `resolveAgentId` full-table `findMany` on uncached miss (:236-243).
- G7: `listMemoryPreviews` has no upper clamp on `limit` (:506) — unbounded fetch possible.
- G8: `enforceCapsAllAgents` scans all active notes to enumerate agents (memory-lifecycle.ts:196-201).
- G9: session discards vanish on restart while soft-suppress rows persist — split-brain until TTL (docs; confirmed by code).
- G10 (Low): whether any consumer reads `memory_update_log` beyond tests — grep found only writes (schema relation + insert sites). Labeled write-only audit.
- G11 (Low): `embeddingModelProfiles` writer is Providers routes (`routes/providers.ts`), outside memories; reader-only in this domain.
- G12: `context-integrity.test.ts` bypasses the gate (TEST-ONLY, non-fatal finding in check-gates).
- G13: `maintenance-worker` defensive fallback imports flat `runSuppressionSweep` (mod as Record) — the flat export exists (memories-gate.ts:43), so fallback is reachable; contract drift risk if alias removed.

## 11. Naming / boundary verdict (AGENTS.md)

- Kebab-case files: OK. Thin gate: OK (re-export only). Gate-to-gate: OK (workspace only). No cycles. Main-only/read-only audit: no commits made. Docs sync: docs NOT updated (read-only audit; recorded as plan item).

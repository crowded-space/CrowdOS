# Memory vault and embeddings
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Agents need durable long-term memory that survives sessions without polluting prompts. This feature exists so agents accumulate typed notes (`agent_memory_notes`) with guarded writes, lifecycle management, per-agent caps, session-scoped hides, and multi-lane recall that injects a bounded preview block into context — with optional embedding-hybrid scoring when a provider is configured.

## Architectural decision
Domain failures return `{ ok: false }` unions instead of throwing, so best-effort tool and runtime callers degrade rather than crash [Observed]. Audit inserts and cap enforcement are fire-and-forget, so bookkeeping never blocks the interactive write path [Observed]. Reflection input is sanitized before the throttle check, so control-stripped variants can't slip past dedupe [Observed]. Session hides use soft-suppress (suppress columns only, lifecycle untouched), keeping them as reversible TTL state rather than lifecycle transitions [Observed]. Retrieval SQL-bounds the candidate window (`MEM_RETRIEVAL_WINDOW`, 60) before JS lane scoring, so the hot path never scans full history [Observed]. Throttle state and session discards are process-local Maps — no durability needed, restart safely resets both [Observed]. Mock embeddings are deterministic per text, so disabled-flag deployments still get stable recall behavior without a provider [Inferred].

## How it works
`resolveAgentId` trims/`@`-strips, checks a 60s/500-key scope cache, then direct id match, then case-insensitive name/title scan, else passes input through. `createMemoryNote` resolves the agent, loads agent + channel in parallel (bad `channelId` → null, never FK error), sanitizes and throttle-checks auto-reflections (60s min interval, 0.8 Jaccard over a 25-hook ring), retries id allocation 3 times (`YYYY-MM-DD-<12hex>`), then records throttle and fires audit + cap enforcement without awaiting. `read` scopes by `(noteId, agentId)` and bumps access counters by default; `list` defaults active-only, limit 50, `importanceScore DESC, noteTimestamp DESC`, with suppressed rows re-checked against current time on every call. `update` diffs 13 editable keys only (lifecycle/suppress columns untouched — use `archive`/`suppress`/`softSuppress`). `retrieveMemoryCandidates` loads the bounded active window, drops suppressed + live session discards, merges lane hits (`recent_episodic` 1.0, `unresolved_tensions` 0.9, `high_importance` 0.8 at ≥0.7, `mentions` 0.6, `recency` 0.5 under 2d, per-lane max), blends a semantic lane when `EMBEDDING_ENABLED=true` (cosine, weight 0.5, floor 0.3), sorts and slices to `topK` (10). `buildMemoryPreviewBlock` renders `[score] "hook" — "brief" {note_id, type, lanes, importance, has_tension}` lines inside `<memory_previews>` (hook/brief wrapped as untrusted; empty → `""`), called by Runtime behind warn-and-continue. `runSuppressionSweep` flips up to 500 elapsed suppressions back to active; `enforceNoteCap` archives lowest-importance/oldest overflow beyond `MEM_NOTE_CAP` (500); `enforceCapsAllAgents` fans out in chunks of 5. `discardNoteFromContext` soft-suppresses for `MEM_DISCARD_TTL_MS` (30min), records the session discard, and always returns `{ ok: true }`. Embedding path: `embedText` resolves env-override or first `embedding_model_profiles` row, hits the OpenAI-compatible endpoint (8s timeout, truncate/pad + renormalize) else mock; `embedNote` persists vector JSON + model + timestamp (missing column tolerated); `ensureEmbeddingsForAgent` backfills up to 100; `searchByEmbedding` tries pgvector ordering, then JS cosine over a 60-note window. The sweeper runs once per process every 10min across workspace DBs; bullmq mode ports the sweep body as-is into the `suppress-expiry` repeatable.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Memories.md> | Owns vault CRUD, throttle/dedupe, lifecycle/caps/sweeps, lanes + preview block, embedding pipeline, session discards |
| <../Domain Spec/Runtime.md> | Calls retrieval + preview injection per request via `memory-retrieval-middleware.ts`; fire-and-forget reflection auto-write from `base-runtime.ts` |
| <../Domain Spec/Tools.md> | Exposes the vault to agents via `remember` / `open_memory` / `discard_memory_from_context`; owns no memory state |
| <../Domain Spec/Queue.md> | Ports the sweep body into the `suppress-expiry` repeatable for bullmq mode |
| <../Domain Spec/Workspace.md> | Supplies `forEachWorkspaceDb` for multi-DB sweep fan-out |
| <../Domain Spec/Agents.md> | Supplies `agents` rows read for existence checks only |

## Current state
Real: note CRUD with previews, name/slug→UUID resolution with TTL cache, reflection throttle + Jaccard dedupe, hard archive / timed suppress + sweep / soft-suppress / per-agent caps, audit journal, five-lane retrieval with optional semantic blend, prompt-ready preview block, mock/real embedding pipeline with backfill and pgvector→JS fallback search, in-memory session discards with TTL. Flag-gated: `MEM_REFLECT_THROTTLE`, `EMBEDDING_ENABLED` (+ model/dimensions/weight/key/endpoint overrides). Stub: none — mock embeddings are a designed fallback, not a stub.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Result-union degradation stays; tools and runtime never crash on memory paths.
* Retrieval window stays SQL-bounded before JS scoring. Full-history hot-path scans are forbidden.
* Session discards versus soft-suppress restart split has an explicit UI contract.
* embedding_model_profiles has a documented writer and owner. memory_update_log has a documented reader or write-only label.
* Authority: Memories standard.
## Open gaps
- `embeddingsGate`, `hybridScore`, `parseStoredEmbedding`, `getCachedEmbeddingVector`, `logMemoryUpdate` (standalone export, missing from `memoriesGate`) bypass the gate — reachable-but-not-ported surface with no contract guarantee.
- `generateNoteId` ignores its `agentId` argument — per-agent sequences are not actually supported.
- `updateMemoryNote` type requires `reason` but runtime defaults it to `"update"` — contract inconsistent.
- `listMemoryPreviews` has no upper clamp on `limit` — unbounded fetches possible, unlike Messages' 200-cap.
- `resolveAgentId` falls back to a full-table scan on every uncached miss; `enforceCapsAllAgents` scans all active notes — costs on large vaults unverified.
- Session discards vanish on restart while soft-suppress rows persist — post-restart visibility is split-brain until TTL lapses.
- No REST or socket surface observed — operator inspection beyond tools unverified.
- `embedding_model_profiles` has no observed writer; whether any consumer reads `memory_update_log` beyond the insert site is unverified.

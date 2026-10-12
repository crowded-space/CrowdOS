# Memory write flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
Agent reflections and tool-driven `remember` calls must land durably in the vault without flooding it — near-duplicate reflections written seconds apart are the common case, not the exception. This flow exists so every write passes a single throttle/dedupe guard before insert, bookkeeping (audit, cap enforcement, embeddings) never blocks the writer, and failures degrade to `{ ok: false }` instead of throwing into the agent loop.

## Architectural decision
The shape is guard-before-insert with fire-and-forget bookkeeping `[Observed]`. Sanitizing runs before the throttle check so control-stripped variants can't slip past dedupe (`agent-memory-store.ts:246-255`), interval and Jaccard-similarity dedupe live in one `ReflectionThrottle.check` rather than separate stages (`memory-reflection-throttle.ts:37-77`), and throttle-record plus audit plus cap enforcement all fire without awaiting so the interactive path never waits on bookkeeping (`agent-memory-store.ts:298-310`) `[Observed]`. Domain failures return unions, never throws, because tools and runtime call memory on best-effort paths (`agent-memory-store.ts:121-123`) `[Observed]`. Embedding is a separate pipeline the write path does not block on — vectors are backfilled and read at retrieval time, not persisted synchronously on insert `[Inferred]`.

## How it works
1. A caller (`remember` tool via `tool-registry.ts:1065-1087`, or runtime reflection auto-write via `base-runtime.ts:22-51`) calls `createMemoryNote`, which first resolves the agent: trim/`@`-strip, 60s/500-key scope cache, direct id match, case-insensitive name/title scan, else pass-through (`agent-memory-store.ts:208-266`).
2. Agent + channel rows load in parallel; an unknown `channelId` is nulled to `null`, never a foreign-key error (`agent-memory-store.ts:296-304`).
3. Auto-reflections (`reflection` + `self_reflection`) are sanitized, then throttle-checked against a 60s min interval and 0.8 Jaccard threshold over a 25-hook ring (`agent-memory-store.ts:318-341`, `memory-reflection-throttle.ts:3-5`, `memory-reflection-throttle.ts:44-50`); throttled or duplicate writes return `{ ok: false }` (`REFLECTION_THROTTLED` / `REFLECTION_DUPLICATE`) without throwing (`agent-memory-store.ts:329-341`).
4. The note inserts with a `YYYY-MM-DD-<12hex>` id, retrying id allocation up to 3 times on collision before rethrowing (`agent-memory-store.ts`); when PG is unconfigured/unreachable the write goes local-only to `localstore/memories/<agentId>.jsonl` with no FK validation (degraded §18).
5. On success the throttle is recorded and audit (`memory_update_log`) + per-agent cap enforcement fire without awaiting — cap failures are caught, logged, and swallowed (`agent-memory-store.ts`); cap overflow archives lowest-importance/oldest notes beyond `MEM_NOTE_CAP` (`memory-lifecycle.ts:151-193`). PG success also best-effort mirrors the note to the local file for degraded reads.
6. Embeddings happen off the write path: `embedNote` persists vector JSON + model + timestamp (tolerating a missing column), `ensureEmbeddingsForAgent` backfills up to 100 missing vectors, and the semantic lane consumes cached vectors at retrieval time (`embeddings.ts:214-236`, `embeddings.ts:254-278`, `memory-retrieval.ts:116-145`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Memories.md> | Owns the whole write path: resolution, throttle/dedupe, insert, audit journal, cap-archive, embedding pipeline |
| <../Domain Spec/Tools.md> | Entry point for agent-driven writes via `remember` (`tool-registry.ts:1065-1087`) |
| <../Domain Spec/Runtime.md> | Entry point for automatic reflection writes via `base-runtime.ts:22-51` |

Related in this folder: [Memory vault and embeddings](./Memory%20vault%20and%20embeddings.md) — system design (vault, lifecycle, retrieval, embeddings); this flow covers only the write path.

## Current state
Real today: resolve → sanitize → throttle/dedupe → insert → fire-and-forget audit + cap-archive, with union returns on domain failures and throws only on repeated DB failures. Embedding persist/backfill and the semantic retrieval lane are real; mock embeddings are a designed fallback when `EMBEDDING_ENABLED=false`, not a stub. Flags: `MEM_REFLECT_THROTTLE`, `MEM_REFLECT_MIN_INTERVAL_MS` (60s), `MEM_REFLECT_SIMILARITY_PCT` (80), `MEM_NOTE_CAP` (500).

## Alignment notes
`none found` — throttle-before-insert ordering, sanitize-before-check, fire-and-forget audit + cap (`agent-memory-store.ts:298-310`), and the off-write-path embedding pipeline all match `Memories.md` Flow §§2/12. One sharpening, not drift: there is no standalone "dedupe stage" — interval and similarity checks are a single `ReflectionThrottle.check`, so the timeline's "throttle check → dedupe" is one guard, not two.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Sanitize-before-throttle stays. Audit plus cap enforcement stay fire-and-forget with metric on failure.
* Reflection throttle plus dedupe semantics are explicit and restart-safe by contract.
* Note IDs honor agentId or drop the argument. updateMemoryNote reason required-versus-optional agrees.
* Authority: Memories standard.
## Open gaps
- Whether any caller auto-embeds on the write path (vs backfill-only before retrieval) was not observed — a note written and immediately retrieved may miss the semantic lane until backfill runs.
- Whether any consumer reads `memory_update_log` beyond the insert site is unverified — the audit journal may be write-only.
- `embedding_model_profiles` has no observed writer — who creates/rotates embedding profiles is unverified.
- Write retry idempotency is unverified: each call mints a new id, so caller retries of a timed-out insert would duplicate.
- `MEM_REFLECT_THROTTLE=0` does not disable the throttle (`boolEnv` treats everything except `"false"` as true — `memory-env.ts:6-10`); operator opt-out is spelling-sensitive.

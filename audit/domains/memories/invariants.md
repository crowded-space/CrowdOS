# Memories Domain — Invariants, Transitions, Races (Phase 3)

Status vocabulary: Enforced (code + test), Enforced (code only), Broken (defect), Gap (unverified/Low).

## 1. Entities and state model

Note lifecycle statuses: `active | archived | suppressed` (agent-memory-store.ts:36).

Transitions:
- `active → archived`: archiveMemoryNote (agent-memory-store.ts:640-645), enforceNoteCap (:176-181, reason `note_cap:<cap>`).
- `active|archived → suppressed`: suppressMemoryNote (:694-699).
- `suppressed → active`: runSuppressionSweep when suppressUntil ≤ now (:127-130).
- Soft-suppress is NOT a transition: sets suppressedAt/suppressReason/suppressUntil while lifecycleStatus stays (memory-lifecycle.ts:268-275); `isSuppressionActive` hides it (memory-lifecycle.ts:101-108).
- updateMemoryNote cannot touch lifecycle/suppress columns (editableKeys :555-569) — Enforced (code + docs).

No transition out of archived (by design; re-archive rewrites metadata).

## 2. Invariants ledger

| ID | Invariant | Evidence | Status |
| --- | --- | --- | --- |
| INV-1 | Note ids `YYYY-MM-DD-<12hex>` unique; no table scan | agent-memory-store.ts:274-284; memories.test.ts:145-159 | Enforced (test) |
| INV-2 | Auto-reflection sanitized before throttle check/record | agent-memory-store.ts:318-341; sanitizer shared/core/reflection-sanitizer.ts | Enforced (code) |
| INV-3 | Throttle/dedupe applies only to `reflection`+`self_reflection` | agent-memory-store.ts:318-319; memories.test.ts:421-433 | Enforced (test) |
| INV-4 | Archived/suppressed notes excluded from retrieval | memory-retrieval.ts:65-74; memories.test.ts:302-309 | Enforced (test) |
| INV-5 | Actively-suppressed notes hidden from default listing | agent-memory-store.ts:513-515; memories.test.ts:191-204 | Enforced (test) |
| INV-6 | Retrieval bounded by MEM_RETRIEVAL_WINDOW then topK | memory-retrieval.ts:64-71,157-159; perf test 102-133 | Enforced (test) |
| INV-7 | Reads/writes scoped by (resolvedAgentId, noteId) | agent-memory-store.ts:431,541,626,680 | Enforced (code) |
| INV-8 | Domain failures are result-unions, not throws (non-connection) | agent-memory-store.ts:114-124 | Enforced (code + tests) |
| INV-9 | Audit + cap never block/fail the write | agent-memory-store.ts:382-384; memory-lifecycle.ts:77-94 | Enforced (code + test via tick) |
| INV-10 | No PG ⇒ local mirror only (no FK validation) | agent-memory-store.ts:291-294,392-393 | Enforced (code) |
| INV-11 | Memory candidate preview wraps hook/brief as untrusted | memory-retrieval.ts:192-195 | Enforced (code; context-integrity tests) |
| INV-12 | Audit rows accompany create/update/archive/suppress/sweep/cap | memories.test.ts:312-343 | Enforced (test) |
| INV-13 | Discard hides note for session even when soft-suppress fails | memory-lifecycle.ts:299-305; memories.test.ts:443-471 | Enforced (test) |
| INV-14 | Sweep flips only suppressed rows with suppressUntil ≤ now; batch 500 | memory-lifecycle.ts:116-124 | Enforced (code + test) |
| INV-15 | Cap archives oldest lowest-importance overflow | memory-lifecycle.ts:166-171; memories.test.ts:263-300 | Enforced (test) |
| INV-16 | Resolve cache is workspace-scope-keyed (no cross-tenant bleed) | agent-memory-store.ts:215 | Enforced (code) |
| INV-17 | No broker events emitted/listened | docs Emits-Listens; grep clean | Enforced (code) |

## 3. Broken / drift invariants (defects)

| ID | Invariant at risk | Evidence | Status |
| --- | --- | --- | --- |
| BINV-1 | `updateMemoryNote` `reason` required by type, defaulted at runtime | agent-memory-store.ts:88-89 vs :600 | Broken (contract inconsistency) |
| BINV-2 | `generateNoteId(agentId)` must honor agentId or drop it | :282-284 | Broken (ignored arg) |
| BINV-3 | `logMemoryUpdate` must write into the SAME tenant DB as the note | memory-lifecycle.ts:80 uses ambient `getDb()` — never threaded with opts/ALS in CRUD paths | Broken (cross-tenant audit risk; see MEM-004) |
| BINV-4 | Facade completeness: every public capability on `memoriesGate` | `logMemoryUpdate` flat-only (memories-gate.ts:51 vs :79-111) | Broken (drift) |
| BINV-5 | `listMemoryPreviews` bounded like Messages 200-cap | :506 no clamp | Broken (unbounded) |

## 4. Races / partial / ordering

| ID | Hazard | Evidence | Severity |
| --- | --- | --- | --- |
| RACE-1 | Soft-suppress vs sweep: discard sets suppressUntil while lifecycle stays active; sweep only touches `suppressed` rows, so discard TTL never resurrects anything — but a hard-suppressed note discarded soft keeps `suppressed` status and sweep flips it to active at suppressUntil while session discard still hides it (benign double-hide). | memory-lifecycle.ts:266, :114-130 | S3 |
| RACE-2 | createMemoryNote cap enforcement runs detached; concurrent creates can overshoot cap transiently then self-heal next create/sweep tick. | agent-memory-store.ts:382-384; memory-lifecycle.ts:151-193 | S3 |
| RACE-3 | update vs archive/suppress last-write-wins without version; update can re-write fields after a lifecycle flip (it does not resurrect lifecycle but rewrites updatedAt/body). | agent-memory-store.ts:590-607 | S3 |
| RACE-4 | Sweep fan-out + inline timer in the same process could double-sweep when both inline timer and bullmq worker run (guarded by QUEUE_MODE in register-socket-server.ts:505-507 and worker skip; unverified cross-process duplicate sweep safety). | memory-lifecycle.ts:224-247 | S3 (Low) |
| RACE-5 | `resolveAgentId` cache is process-local; a renamed agent keeps resolving to old UUID for ≤60s per process. | agent-memory-store.ts:209-217 | S3 |
| RACE-6 | Session discards + soft-suppress split-brain on restart (discards vanish; soft-suppress persists). | memory-session-discards.ts:16-17; memory-lifecycle.ts:260-266 | S3 (documented) |
| RACE-7 | Embedding persist vs retrieval cache: embedNote invalidates cache after persist; a concurrent retrieval may cache a stale parse between update and invalidate (window is one read). | embeddings.ts:223-244 | S3 (Low) |

## 5. Leakage / isolation / null / boundary

| ID | Hazard | Evidence |
| --- | --- | --- |
| LEAK-1 | Cross-tenant audit leak: logMemoryUpdate ambient getDb() can write memory_update_log into the process-global DB while the note lives in a workspace DB (or vice versa) — audit rows land in the wrong database. | memory-lifecycle.ts:77-94 |
| LEAK-2 | readLocalMemoryNotes without scope merges ALL workspaces' mirror files for an agent id — degraded reads can surface another workspace's notes for the same agentId. | memory-local-store.ts:137-150 (searchableWorkspaceScopes) |
| LEAK-3 | Tool isolation relies on ctx.agentId winning over caller-supplied agent_id (open_memory/remember) — verified correct at tool-registry.ts:861-871, :1061-1064. | tool-registry.ts |
| LEAK-4 | Retrieval local fallback filters by lifecycleStatus active but NOT suppression (soft suppressUntil) — degraded retrieval can surface actively-soft-suppressed notes. | memory-retrieval.ts:163-179 |
| NULL-1 | Unknown channelId → null fallback (no FK error). | agent-memory-store.ts:313-314 |
| NULL-2 | `filter.limit ?? 50`; no upper clamp. | agent-memory-store.ts:506 |
| BOUND-1 | numEnv requires >0; `MEM_SUPPRESS_SWEEP_MS=0` silently falls back to 10min. | memory-env.ts:1-4 |
| BOUND-2 | boolEnv: only literal "false" disables; `0`/`no` are true. | memory-env.ts:6-10 |
| TZ-1 | Timestamps stored tz-aware; sweep compares DB lte vs JS Date — correct. | memory-lifecycle.ts:120 |
| OVF-1 | importanceScore real, no CHECK constraint 0..1 — tools clamp via schema but domain accepts any number. | agent-memory-store.ts:356; schema.ts:421 |

## 6. Error / retry / event / cache / N+1 / migration / telemetry

| ID | Hazard | Evidence |
| --- | --- | --- |
| ERR-1 | createMemoryNote rethrows non-connection errors after 3 attempts; `UPDATE_FAILED` path unreachable (dead code). | agent-memory-store.ts:392-400 |
| ERR-2 | Audit failures console-only, no metric — violates docs Architectural Standard "MUST emit a metric on failure". | memory-lifecycle.ts:90-92; agent-memory-store.ts:382-384 |
| RETRY-1 | ID-collision retry loop swallows non-connection errors until attempt 3 then rethrows (ok), but any partial side-effect (throttle.record) only runs after success (ok). | agent-memory-store.ts:345-398 |
| EVENT-1 | No events — nothing to duplicate/lose. | — |
| CACHE-1 | embeddingVecCache clear-all at >2000 entries (per-process, unbounded key growth bounded by clear). | embeddings.ts:206-217 |
| CACHE-2 | resolveCache TTL 60s/500 — eviction is oldest-inserted (not true LRU despite comment). | ttl-cache.ts:29-38 |
| N1-1 | listMemoryPreviews no N+1; single query. enforceCapsAllAgents loads all active note agentIds (single query) then per-agent counts — O(agents) queries per sweep. | memory-lifecycle.ts:196-214 |
| MIG-1 | embedding_vec added best-effort; searchByEmbedding raw SQL COALESCE(embedding_vec::text, embedding) fails to a JS fallback if column absent — safe. | embeddings.ts:324-341; migration 0009:21-31 |
| MIG-2 | memory_update_log.agentId added in 0003 (nullable) — pre-existing rows null (fine). | 0003_phase2_integrity.sql:19 |
| TEL-1 | Embedding stages log via logMetric; retrieval has no per-call telemetry (no lane metrics). | embeddings.ts:152-165; memory-retrieval.ts |
| DEAD-1 | `embeddingsGate` (embeddings.ts:362-371) is a second, non-memories gate-shaped export; no importer found. | grep |
| DEAD-2 | `hybridScore`/parse/cache helpers exported flat but unused outside tests. | grep + embeddings.test.ts |
| BYPASS-1 | check-gates TEST-ONLY: context-integrity.test.ts imports memory-test-db.js + memory-retrieval.js past the gate. | check-gates output; context-integrity.test.ts:76,79,133 |

## 7. Transition matrix (notes)

| From \ To | active | archived | suppressed |
| --- | --- | --- | --- |
| active | update (no-op lifecycle) | archive / cap | suppress |
| archived | — (no unarchive) | archive (rewrites) | suppress allowed |
| suppressed | sweep (expired) | archive allowed | suppress (extends) |

Soft-suppress overlays any status without changing it.

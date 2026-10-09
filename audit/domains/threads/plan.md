# Threads Domain — Phase 7 Proposal: Ordered Implementation Plan (for NEXT turn)

Status: PROPOSAL ONLY. No production code was changed in this audit turn. AGENTS §4 git rules apply: stay on `main`, no branches, no commit/push/pull/rebase/stash/reset, stop for review after each step group.

## Strategy: incremental refactor (Option 2), not rewrite

The domain is 224 LOC, single-consumer, with a clean facade shape and correct transactional create. Its problems are wiring (THR-001), missing guards, and two schema defects — all fixable in place. A rewrite would risk the facade contract and the stored formats (ids, enum, expiresAt semantics) with no benefit. Rejected: Option 1 (leave as-is — the feature is dead), Option 3 (rewrite — high risk, no payoff).

## Guardrails (do not violate)

- Facade public contract stays: 8 methods, same names, same return-union semantics; new behavior is additive (e.g. `created` flag surfaced, `nextCursor` added) or explicitly versioned.
- Stored formats unchanged: `thr_<8hex>` ids, `thread_status` enum, `expiresAt=null` semantics, cursor strings remain accepted (legacy numeric list cursor included).
- Error semantics: unions, never throws; route owns status mapping.
- Every step: docs updated in the same task (AGENTS §6): `re-docs/Backend Docs/Domain Spec/Threads.md` + `Feature and Flow Spec/Thread lifecycle flow.md` + `_flow-index.md` if links change.
- No production edits until user review of this plan.

## Step 0 — Characterization tests (no production changes)

- Add `packages/server/src/threads/thread-service.test.ts` (unit, mock db or PG-less harness) freezing: create outcomes (incl. `created:false`), update `{notFound}`, delete `{notFound}`, list clamps + lenient cursors, getMessages page/cursor math, increment no-op on non-active.
- Add `packages/server/src/routes/threads.test.ts` (route-level with the real Fastify + validatorCompiler; threads route mounted directly).
- Command: `npx vitest run packages/server/src/threads packages/server/src/routes/threads.test.ts`.
- DoD: all green; failures only where a test intentionally pins a defect (marked `// AUDIT-THR-0xx`).

## Step 1 — Mount the transport (THR-001) — highest value, smallest diff

- Files: `packages/server/src/routes/index.ts` (+2 lines: import + register), `packages/server/src/routes/index.test.ts` (extend guard).
- Tests: registration test (all 8 endpoints != 404 on real entrypoint); e2e smoke via existing Playwright chat spec if practical.
- Compat: no wire change; endpoints become reachable for the first time.
- Rollback: revert the 2 lines.
- DoD: `npx vitest run packages/server/src/routes/index.test.ts` green + manual curl of GET /api/channels/:id/threads returns 200.

## Step 2 — Make the sweep real (THR-007, THR-008)

- Files: `packages/server/src/queue/repeatables.ts` (add `thread-expire` every 60s), `packages/server/src/queue/maintenance-worker.ts` (handler → `threadGate.archiveExpired`, iterate workspace DBs per THR-025), optionally remove/guard the public endpoint with a token.
- Tests: worker tick flips an expired thread; sweep idempotent; auth test if endpoint kept.
- DoD: expired thread flips within one tick in integration; docs updated (Flow step 7).

## Step 3 — Lifecycle guards + bookkeeping (THR-006, THR-014, THR-009, THR-031)

- Files: `threads/thread-service.ts` (`updateThread`: single-statement conditional update + transition map; `archivedAt` policy; return `created` flag through `createThread`), `routes/threads.ts` (surface 409 on illegal transition; 200 vs 201 on dedupe).
- Tests: per-transition unit tests; property test for the archivedAt invariant; race test for delete-vs-update.
- Compat: `update` gains 409 for previously-allowed illegal moves (documented behavior change; acceptable per AGENTS §10 because the old behavior was unguarded).
- DoD: invariant test green; docs Decisions updated.

## Step 4 — Schema fixes (THR-002, THR-004, THR-005, THR-020) — migrations, review carefully

- New migration: (a) thread-aware unique index on messages (expression index on `(channel_id, coalesce(thread_id,''), sequence_number)`), (b) partial unique on `threads(parent_message_id)` after de-duplicating existing rows, (c) chosen FK rule for `messages.thread_id`, (d) composite list index.
- Files: `packages/server/src/db/migrations/0025_threads_integrity.sql`, `db/schema.ts` mirrors, `threads/thread-service.ts` (catch unique violation → return existing thread).
- Tests: migration test (idempotent, handles pre-existing duplicates), replica collision test, concurrency test.
- Rollback: down-migration notes in the migration header (drop indexes/constraint).
- DoD: integration test proves channel msg + thread reply coexist in PG; duplicate-create race returns one row.

## Step 5 — Ownership + local tier decision (THR-015, THR-016, THR-003, THR-025)

- THR-016: move `allocateThreadSequence` behind `threadGate.allocateSequence`; messages calls the gate (gate-to-gate); delete the shared helper or make it private to Threads.
- THR-015: expose channel-existence + message-page reads through the respective gates; threads service stops importing `messages`/`channels` tables.
- THR-003/THR-025: decide local tier (implement thread-local store) vs explicit 503; make workspace context explicit in gate inputs for worker callers.
- Tests: ownership grep test; isolation test; local-mode test if implemented.
- DoD: `npm run lint:gates` green with no allowlist additions; docs Relations/Owns updated.

## Step 6 — Cursor + validation contract (THR-011, THR-012, THR-013, THR-022, THR-028, THR-026, THR-030)

- Export `ThreadStatus` + cursor codecs through the gate; strict malformed-cursor errors (400) aligned with messages domain; `list` returns `nextCursor`; zod body schema for POST messages; minimal service-level validation.
- Tests: codec roundtrips + malformed inputs; pagination roundtrip; invalid-body 400.
- Compat: list response gains a field (additive); malformed cursors now 400 (documented behavior change).
- DoD: contract tests green; docs Ports list new ports.

## Step 7 — Observability + sockets + hygiene (THR-019, THR-018, THR-024, THR-010, THR-023, THR-027, THR-021, THR-029)

- Emit thread lifecycle events (register in event-types; check-events must pass); log broker failures; decide thread:join (implement rooms or delete client emit); reconcile messageCount (or document best-effort); authorship policy; rootMessageId decision (implement nesting or deprecate); delete dead imports; fix docs drift; product decision on channel-vs-thread visibility.
- DoD: `npm run lint:gates` (incl. check-events) green; docs synced; audit ledger rows closed with commit references.

## Verification commands (each step)

```
npx tsc -p packages/server/tsconfig.json --noEmit
npm run lint:gates --workspace @crowdspace/server
npx vitest run packages/server/src/threads packages/server/src/routes/threads.test.ts packages/server/src/routes/index.test.ts
npm run test:e2e -- e2e/chat.spec.ts   (smoke, when UI path touched)
```

## Definition of Done (overall)

- THR-001..THR-009 (S0/S1/S2) closed with regression tests; THR-010..THR-031 either closed or explicitly re-scoped in the ledger with rationale.
- Facade contract documented in Threads.md and equal to gate exports; docs synced in the same commits.
- No new gate violations; no cross-domain table writes by Threads.
- git: main only; commits only on explicit user approval, using the `git-crow` script for push/pull.

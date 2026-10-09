# Channels Domain — Phase 7 Implementation Plan Proposal (no implementation this turn)

Constraints: preserve the facade contract (same names/signatures/returns unless a step says otherwise); no branch, main only; code + docs + tests in the same task (AGENTS.md `6); stop for live review before commit.

## Architecture assessment (A–E)

- A (keep): facade shape (thin gate + port object), union-return style for channel ops, keyset listing, dualWrite local-first commit, settings (channelId, workspaceId) key, archived-hidden listing.
- B (small fix): CHN-004/005 (route mapping), CHN-006b (dup throw), CHN-013 (db-path guard), CHN-017/018 (validator/type coherence), CHN-028 (guard), CHN-029 (dead reads), CHN-030 (silent guard collapse).
- C (behavior decision + guard): CHN-001/002/003/033 (dup semantics incl. rename, case, archived; guard-failure partial write), CHN-010/011/012 (settings scope/override/orphans), CHN-015 (nested archive), CHN-019/031 (cascade completeness).
- D (cross-cutting, needs design): CHN-007 (workspace-scoped category guard), CHN-008/009/032 (settings outbox + ordering), CHN-014 (merged keyset), CHN-016 (update/delete tenant scope), CHN-020/021 (facade bypass + Shared ownership), CHN-024 (socket scope threading).
- E (intentional/operator decisions): CHN-026 (headerless legacy read), CHN-027 (get returns archived), CHN-022 (stale type exports — remove or keep per operator), hard-delete vs archive path.

Overall: **incremental refactor (option 2)**. The facade is clean, the local-first design is consistent, and the 13+61 passing tests pin the happy paths. Defects cluster in (a) guard parity between create/update and local/PG, (b) settings durability/scope, (c) tenant scoping on update/delete. No evidence supports a rewrite; a rewrite would re-create the exact tier-parity bugs catalogued here.

## Rewrite decision (1/2/3)

1. Status quo + docs — rejected: duplicate + partial-write behaviors (CHN-001/002/033) persist silently.
2. **Incremental refactor (RECOMMENDED)** — fix S2s in place, pin with tests, one constraint migration (after backfill), keep every port byte-compatible; docs synced same-task.
3. Rewrite — rejected: facade contract is used by 8+ call sites across mounts/messages/sockets/runtime/shared; blast radius unjustified.

## Ordered plan (each step = code + tests + docs in one task; stop for review before commit)

1. **Guard unification** (CHN-001/002/003/013, CHN-025 backfill part): single `assertNoDuplicate(ws, categoryId, name, {excludeId})` used by create+update, case-insensitive on BOTH tiers (SQL `lower()`), explicit archived rule; thread ws into the db path. Tests: rename collision, case variant, archived recreate, db-path. Docs: Channels.md Expect/Decisions.
2. **Partial-write fix** (CHN-033): make dualWrite skip/abort the PG leg when localWrite returns a guard-failure union (or have localCreateChannel throw a typed error). Tests: local-guard-failure never writes PG.
3. **Route error contract** (CHN-004/005/006b): branch on union member; distinct 400/409 bodies; catch category dup throw. Tests: route-level for /api/channels + /api/categories.
4. **Settings durability** (CHN-008/009/010/011/012/032): route settings writes through dualWrite (entity `channel` op `upsert` with settings row payload) or add explicit outbox+warn; fix ordering to local-first; decide dbOverride policy (PG-first) and unknown-channel 404. Tests: PG-down outbox, convergence, scope fallback.
5. **Tenant scoping** (CHN-007/016/024): pass resolved ws into categoryExists; add ws to update/delete signature as an OPTIONAL 3rd arg (backwards compatible); sockets pass msgChannel.workspaceId to getSettings. Tests: cross-ws reject/allow matrix.
6. **Pagination + listing consistency** (CHN-014/015): thread cursor into both per-tier legs; filter archived in nested category channels. Tests: 250-row merged walk; nested/flat parity.
7. **Constraint migration** (CHN-025): after steps 1-2 land and duplicates are backfilled, add unique indexes; map violations to duplicate_name. Tests: migration + constraint mapping.
8. **Guard + boundary cleanup** (CHN-028, CHN-020/021): rename-then-delete protection via immutable marker; move routes/workspace seeding behind a gate port and delete the allowlist entry; decide Shared ownership of channels.json (document or gate it). Tests: rename-delete regression; gate lint clean.
9. **Hygiene** (CHN-018/019/022/023/029/030/031): folderPath typing, local cascade completeness, remove stale type exports (operator call), docs sync (Ports/Relations/Owns + Alignment notes with ledger IDs), remove dead reads, log swallowed guard errors.

Rollback: every step is independently revertible (no destructive migration until step 7, which is additive and idempotent). Verification per step: focused vitest + `npx tsc -p tsconfig.json --noEmit` + `node scripts/check-gates.mjs`, then the full channels + mounts + routes baseline set.

DoD: ledger S2 rows closed or explicitly waived by operator; contract matrix rows updated; docs updated same-task; no new gate violations; no branch created; nothing committed without explicit user yes.

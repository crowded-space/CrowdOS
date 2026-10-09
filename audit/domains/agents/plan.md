# Agents Domain — Fix Plan (ordered; incremental, no rewrite)

Rewrite decision: **NO full rewrite.** The domain is small (8 files), the facade contract is clean and gate-only compliance is 0 violations, the local/PG dual-tier machinery is shared infrastructure (not domain-local) and already partially hardened by prior audits. Targeted, incremental fixes preserve the frozen contract (`agentGate` port shapes, schemas, types) and keep blast radius per-fix.

DoD (every step): `npx tsc -p tsconfig.json --noEmit` exit 0 · `npx vitest run src/agents` green + new tests · `node scripts/check-gates.mjs` 0 violations · docs updated in the same task (AGENTS.md §6): `re-docs/Backend Docs/Domain Spec/Agents.md` (+ `_index.md` only if gates move) and `Feature and Flow Spec/Agent profiles and roster.md` (+ `_flow-index.md` if links change) · no branch, main only, commit only on explicit user yes.

## Phase A — Isolation & correctness hotfixes (small, additive)

1. **AGT-003** scope socket dispatch roster: `register-socket-server.ts:752` → `agentRegistry.list({ isTemplate:false, workspaceId: msgWorkspaceId })`; thread workspaceId into `MentionParser.parseMentions` (`mention-parser.ts:8,44`) or resolve mentions against the scoped list already fetched. Compat: unscoped callers unchanged. Tests: G-10.
2. **AGT-004** pass tenant to pin validation (`routes/channels.ts:142` → third arg `workspaceIdFrom(request)`; 400 when null). Tests: G-11.
3. **AGT-009** fix null-clear merge for `modelModuleId` in `update()` (`agent-service.ts:380` `!== undefined` form) + mirror in local merge path. Additive behavior only for explicit null. Tests: G-3.
4. **AGT-014** stop rewriting runtime_states/agents status on generic profile updates (only when `input.status` explicitly provided). Verify runtime callers of `update()` (studio manifest, routes) unaffected. Tests: G-2.

## Phase B — Dual-tier integrity

5. **AGT-001** resolve per-workspace handle for the dual PG leg + re-read in `update()`/`setStatus()` (use existing `tierContextFor` → `getWorkspaceDb`/`dbForWorkspace` pattern; keep `dbOverride` semantics untouched). Characterization test first (two DBs). Tests: G-16.
6. **AGT-002** bound-handle list merges workspace-scoped local read (`localListAgents({ workspaceId })` via gate port; never unscoped). Tests: G-5.
7. **AGT-010** narrow `pgCatchNull` to `isConnectionError`; rethrow logic errors. Tests: G-17.
8. **AGT-005 + AGT-022** remove in-tx swallowed cascade; add migration: `runtime_states.agent_id` unique + FK to agents ON DELETE CASCADE; make setStatus/update upsert-or-insert the ledger row; workspace-sync push creates the ledger row. Migration is additive/idempotent; rollback = drop constraint/index. Tests: G-4, G-13.
9. **AGT-008** migration for `agents.context_token_cap` + schema mapping + pgSet write; backfill null. Rollback = drop column (data loss only for values never persisted in PG). Tests: dual-tier round-trip.

## Phase C — Boundary & hygiene

10. **AGT-007** add agents-owned invalidation port (e.g. `agentGate.invalidateRoster`) and call from `workspace-sync.ts` after agent writes (or export a sync hook). Tests: G-12.
11. **AGT-016** namespace default-assistant id per workspace (data migration for existing PG rows if any; local files unaffected). Tests: G-14.
12. **AGT-023** document or restrict legacy-row claim rule in `update()` (:361-362). Tests: G-15.
13. **AGT-017/AGT-021/AGT-011/AGT-012** type `strike:initiated` payload, add counters (escalation, sweep paused, outbox-queued), warn on broker-less setStatus, wrap sweep select in tx (or document CAS). Tests: G-9, G-7.
14. **AGT-025** docs sync: Agents.md Ports (add the 3 local ports), stale line refs, feature-doc gaps refresh; `_index.md`/`_flow-index.md` only if links change.
15. **AGT-015/AGT-018/AGT-020/AGT-024** resolve unknowns: reorder local create guard before ensureDefaults; decide takeover-intent durability; drop or label archived columns; trace outbox drain poison policy.

## Verification / rollback summary

- Verify per step: tsc, vitest agents suite + named new tests, check-gates; full `npx vitest run src/agents src/routes src/runtime` smoke for Phases A/B.
- Compat: no port removals; all changes additive at the facade (only AGT-014 changes observable update() side effects — covered by test + docs).
- Rollback: per-step revert; migrations reversible (drop column/constraint) with no destructive backfill.
- Docs performed in the SAME task as each code change (this audit performed none).

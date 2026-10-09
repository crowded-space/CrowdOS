# Skills Domain — Audit Plan (incremental; no rewrite)

Status: Phases 1-4 read-only complete (time-boxed). No production edits made. Baseline commands run: tsc exit 0; vitest 37/37 pass; check-gates exit 0. Docs noted, not modified (AGENTS.md §6 requires code+docs same task when a fix lands).

Decision: prefer incremental hardening over rewrite. The gate shape is correct, tests pin the core CRUD/merge/cache semantics, and the markdown half matches §20. Fix the boundary (SK-001), the multi-DB/scope story (SK-002/SK-003), then hygiene items.

## Ordered fix plan

### P0 — boundary + data loss (do first)
1. SK-001 — add skillsGate.replaceAgentSkills(agentId, skillIds) implemented in skill-service with withTransaction (delete+insert atomic); rewrite routes/studio.ts:152-154 to call it; invalidate caches after commit.
   - Files/symbols: skill-service.ts SkillService.replaceAgentSkills, skills-gate.ts skillsGate, routes/studio.ts manifest PUT.
   - Tests: service all-or-nothing (bad id keeps prior links); route 400/404 mapping; studio manifest roundtrip.
   - Compat: additive port (no existing signature change). Rollback: revert route to prior path only if txn port unavailable. Verify: PUT with one invalid id → 4xx and links unchanged; check-gates 0.

### P1 — authorization consistency
2. SK-002 — thread the tenant db into authorization: wrap skillsGate.getResolvedToolsForAgent in executor with runWithDb(agentDb, ...) (or add optional db param; prefer ALS wrap to keep gate shape).
   - Tests: split-DB integration fixture (tenant rows visible, global empty).
3. SK-003 — cross-scope invalidation: change invalidateAgentCaches(agentId) to also delete keys across scopes (suffix match) or per-agent generation counter.
   - Tests: two-scope unit test (write A, read B fresh).

### P2 — correctness/hygiene
4. SK-004 — taxonomy alignment decision (drop 'general' from DB enum or document split). Touches validators + Domain Spec Decisions.
5. SK-006/SK-013 — reconcile middleware docblock vs code (either alwaysOn for triggerless or fix comment) + update Domain Spec (same task, AGENTS.md §6).
6. SK-008 — single exported UNIVERSAL_TOOL_IDS via gate; replace 3 copies.
7. SK-005 — single-load-per-turn for markdown store (memo/parameter), keep parse semantics.
8. SK-007 — log swallowed middleware errors (warn once).

### P3 — small guards
9. SK-009 — optimistic update guard (WHERE updated_at = existing.updatedAt) or jsonb merge.
10. SK-010 — limit sanitize; SK-011 — compose total cap; SK-012 — enabled token strictness.

## Docs to update with fixes (same task each time)
- re-docs/Backend Docs/Domain Spec/Skills.md: Ports (new replaceAgentSkills), Decisions (taxonomy, triggerless, invalidation scope), Gaps (remove fixed items; add remaining).
- re-docs/Backend Docs/Feature and Flow Spec/Skill catalog and tool resolution.md: flow for replaceAgentSkills + validation matrix row.

## DoD (per item)
Code fix + test + Domain Spec/Flow Spec updated + npx tsc -p tsconfig.json --noEmit + targeted vitest + node scripts/check-gates.mjs clean + no new bypass allowlist entries. No branch (main only), no commit without explicit user approval.


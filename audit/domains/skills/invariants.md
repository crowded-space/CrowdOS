# Skills Domain — Invariants (observed / violated)

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I1 | Gate is the only import surface; gate is thin (no logic/fetch/DB/branching). | Holds (script) | check-gates 0 violations; skills-gate.ts wires only. |
| I2 | One domain owns skills/agent_skills; no other domain writes these tables. | VIOLATED | routes/studio.ts:152-154 writes agent_skills directly (SK-001). |
| I3 | Mutations invalidate hot-path caches; no stale authorization beyond 30s TTL. | Holds for same-scope writers; at risk cross-scope | skill-service.ts:71-82; scoped delete only touches writer's dbScopeKey (SK-003). |
| I4 | `update` never resets omitted fields (defaults-free schema + per-key promptLayer merge). | Holds | skill-validators.ts:29-52; tests pin it. |
| I5 | `assignSkill` idempotent incl. concurrent 23505. | Holds | skill-service.ts:206-219; test pins 23505. |
| I6 | Universals always resolvable; each registry-filtered fail-open. | Holds | skill-service.ts:262-283; tests. |
| I7 | Discovery carries no bodies (token economy). | Holds at API level | tests assert marker absence; store still reads bodies internally (SK-005 perf note). |
| I8 | Markdown scope isolation: no cross-workspace fan-out. | Holds | markdown-skill-store.ts:97-103; tests. |
| I9 | §20 taxonomy closed. | SPLIT | markdown 3-value closed OK; DB validator accepts 4th value "general" (SK-004). |
| I10 | Parse failures are values, never throws; bad file can't break assembly. | Holds | parser + store tests. |
| I11 | Composition preserves order; reports missing/disabled. | Holds | tests. |
| I12 | Route writes are transactional or recoverable. | VIOLATED | studio delete+insert without txn (SK-001). |
| I13 | Authorization source == agent identity source (same DB). | VIOLATED in split-DB | tool-executor.ts:337-355 (SK-002). |
| I14 | Universal tool list has one source of truth. | VIOLATED | 3 copies: skill-service.ts:259-267, tool-executor.ts:358-359 (5 ids), tool-schema-middleware.ts:49 (4 ids) (SK-008). |
| I15 | Unknown front-matter values are errors — but `enabled` accepts unknown tokens as true. | Weak | markdown-skill-parser.ts:150-157 (SK-012). |


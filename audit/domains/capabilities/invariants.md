# Capabilities — Invariants

Status: all VERIFIED unless marked. Evidence = file:line; Test = pinning test.

| # | Invariant | Evidence | Test |
|---|---|---|---|
| I1 | Catalog ids unique; 27 descriptors; 8 domains | capability-catalog.ts:28–181 | capabilities.test.ts (ids.size) |
| I2 | Every descriptor domain ∈ CAPABILITY_DOMAINS | capability-types.ts:26–35 | capabilities.test.ts, integrity test |
| I3 | No live tool → never advertised | capability-service.ts:222–226 | capabilities.test.ts |
| I4 | Authority rule mirrors ToolExecutor: usable ⇔ isOmniscient ∨ authorityLevel ≤ (authLevelRequired ?? 0); reject ⇔ authorityLevel > required ∧ ¬omniscient | capability-service.ts:193–196 vs tool-executor.ts:370–374 | capabilities.test.ts authority suite |
| I5 | Discovery carries no schemas (exactly 4 keys) | capability-service.ts:226 | capabilities.test.ts, discovery-context.test.ts:150 |
| I6 | expand() ≤ advertised set; null on hidden/unknown/no-usable; cannot expand past filter | capability-service.ts:239–269 | capabilities.test.ts lazy-expansion suite |
| I7 | Unscoped callers never see a workspace manifest (isolation §30) | capability-service.ts:151–153 (empty scope → null) | capabilities.test.ts isolation |
| I8 | Manifest failures never throw: malformed JSON → {}, bad fields warn+ignore, merge degrades to built-ins | capability-service.ts:61–99, 151–163; local-file.ts readJsonObject | capabilities.test.ts malformed suite |
| I9 | mergeManifest pure, deep-copies tools; disabled removes | capability-service.ts:102–149 | capabilities.test.ts merge purity |
| I10 | Summaries one line, ≤300 chars, control chars stripped, fallback id/existing | capability-service.ts:48–58, 123 | capabilities.test.ts sanitization |
| I11 | Stable order: domain rank, then id | capability-service.ts:166–172 | capabilities.test.ts listing |
| I12 | Expansion discloses shape, never grants (ToolExecutor re-authorizes per call) | tool-executor.ts:356–374 | open-detail-expansion.test.ts + domain doc |
| I13 | Gate thin: no logic/fetch/DB/branching; imports only service/catalog/types | capabilities-gate.ts:5–46 | check-gates 0 violations |
| I14 | Deferred tools reachable (descriptor-named or tool_id hatch) — cross-domain guard | tool-schema-middleware.ts:22–31 | tool-deferral-invariant.test.ts (19 pass incl. flow) |

Cross-checks done: authority comparison direction confirmed equivalent to executor (no inversion); no cycle (middleware/registry use dynamic import, tool-schema-middleware.ts:125–131 comment); catalog freeze is shallow only (see CAP-002).

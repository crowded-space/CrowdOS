# Memories Domain — Test Gaps (Phase 4)

## Baseline (exact commands + results)

| Command | Result |
| --- | --- |
| `npx vitest run src/memories` (packages/server) | 3 files, 28 tests, all passed (7.41s) |
| `node scripts/check-gates.mjs` (packages/server) | Gate rule OK: 361 files, 23 domains, 0 violations; 46 TEST-ONLY findings (3 memories-related: context-integrity.test.ts → memory-test-db.js ×2, memory-retrieval.js ×3); 3 pre-existing allowlisted violations (none memories) |
| `npx tsc -p tsconfig.json --noEmit` (packages/server) | exit 0 |

No test failures. Gaps below are untested behaviors; no new tests were added (read-only audit).

## Gaps (mapped to ledger IDs)

| # | Gap | Ledger | Why it matters |
| --- | --- | --- | --- |
| TG-1 | No test that audit rows land in the SAME DB as the note (workspace-scoped write) | MEM-001 | Would catch the ambient-getDb audit leak |
| TG-2 | No degraded-mode suppression test (local retrieval excludes future suppressUntil) | MEM-002 | MEM-1a is only tested on the PG path |
| TG-3 | No scoped-vs-unscoped local read isolation test | MEM-003 | Cross-workspace bleed in degraded mode |
| TG-4 | No contract test that flat exports ⊆ memoriesGate ∪ documented-exempt | MEM-004 | Facade drift |
| TG-5 | No type-level test pinning generateNoteId arity | MEM-005 | Misleading port |
| TG-6 | No test for updateMemoryNote without reason (runtime default) | MEM-006 | Type/runtime disagreement |
| TG-7 | No semantic-lane failure-path test (metric emission) | MEM-007 | Silent degradation |
| TG-8 | No score-semantics parity test for searchByEmbedding branches | MEM-008 | Environment-dependent ordering |
| TG-9 | No perf/bound test for resolveAgentId miss scan | MEM-009 | Unbounded scan |
| TG-10 | No limit-clamp test for listMemoryPreviews | MEM-010 | Unbounded fetch |
| TG-11 | No boundary test that embeddingsGate is not imported cross-domain (check-gates does not flag intra-domain) | MEM-011 | Two contracts |
| TG-12 | No deterministic-error retry-count test for createMemoryNote | MEM-012 | 3x latency + dead code |
| TG-13 | No sweep query-count test for enforceCapsAllAgents | MEM-013 | Sweep cost |
| TG-14 | No mirror-failure telemetry test | MEM-014 | Silent drift |
| TG-15 | No deterministic profile-pick test (two rows) | MEM-015 | Nondeterminism |
| TG-16 | No concurrent access-bump test | MEM-016 | Lost increments |
| TG-17 | No multi-process double-sweep test (Low confidence) | MEM-017 | Duplicate work |
| TG-18 | No alias-vs-UUID discard key test | MEM-019 | Discard miss |
| TG-19 | No degraded archive-after-suppress coherence test | MEM-020 | Impossible local rows |
| TG-20 | Real-DB integration suite absent for memories (all tests use memory-test-db double; no PG round-trip incl. pgvector branch) | MEM-008, MEM-013 | Adapter-level drift (e.g. raw SQL validity) untested |
| TG-21 | No test that context-integrity.test.ts route via gate (TEST-ONLY finding) | BYPASS-1 | Boundary hygiene |

## Coverage verdict

Strong: lifecycle semantics (suppression/cap/sweep/audit actions), throttle/dedupe, discard flow, id format, bounded-window retrieval, preview format, mock/cosine/hybrid scoring.
Weak: degraded/local mode semantics (scope isolation, suppression filter), tenant-correct audit persistence, embedding branch parity, facade contract completeness, failure telemetry. All gaps are test additions; none require production changes to characterize.

# Workspace Domain — Test Gaps (Phase 4, read-only)

Existing: 5 test files / 51 tests (workspace-canon, workspace-database, workspace-database-runtime, workspace-database-routes, workspace-pin) — all pass. Baseline command: npx vitest run src/workspace (packages/server).

Missing coverage (no new tests written this turn, per instructions):

| Gap | Ledger | Suggested test |
| --- | --- | --- |
| PIN gate cache invalidation on set/clear | WS-001 | Integration: enable PIN -> immediate untargeted request must 401; clear -> immediate allow |
| PIN persistence failure honesty | WS-002 | Route test with unwritable registry -> non-2xx |
| reset drop-list vs migrations (reset -> re-provision) | WS-003 | Integration (PG): flush a used DB, provision + seed succeed |
| Conflict quarantine blocks live writes | WS-004 | Unit: dbSync.state=conflict -> dualWrite keeps local only |
| Corrupt registry fail-open | WS-005 | Unit: corrupt workspaces.json -> explicit error/last-good; locks not silently disabled |
| Create returns provisioning status | WS-006 | Route: provision failure -> schemaReady:false in 201 |
| Concurrent pool rotation leak | WS-007 | Unit: interleaved getWorkspaceDb during URL change |
| Sweep skip observability | WS-008 | Unit: dead target -> warn emitted |
| Dead .env ports removal | WS-009 | Gate-shape snapshot after removal |
| rootPath outside sandbox | WS-013 | Route: outside-sandbox rootPath -> flagged/warned outcome |
| Rename save-failure consistency; case-only rename | WS-014 | Unit with scripted fs failure; win32 case test |
| Gate violation removal (channel-local-store) | WS-015 | check-gates passes without allowlist entry |
| Seed partial visibility | WS-016 | Integration: one insert fails -> status partial |
| Disconnect clears outbox backlog | WS-017 | Unit: disconnect -> backlog 0 |
| Orphan folder scope after delete | WS-018 | Unit: deleted folder not enumerated as scope |
| toFolderRelative case handling | WS-019 | Unit: case-differing path -> relative |
| Folder-name sanitizer parity | WS-020 | Unit: reserved-name/long-name record without rootPath -> same folder |
| URIError redaction in probe | WS-021 | Unit: %zz pathname -> invalid-URL error |
| forEachWorkspaceDb pool churn (>cap) | WS-022 | Perf/behavior note when refactored |
| runtime config permission error visibility | WS-024 | Unit: unreadable config -> fallback flagged |
| Cross-domain tests via gate | WS-026 | check-gates test findings drop |
| Delete ordering (close before reset) | WS-027 | Route test with call-order spy |

Also uncovered: no integration test exercises workspaces.json <-> per-folder mirror consistency end-to-end; no test for tenant hook 25s watchdog; no test for socket workspace-room gating on registry-only workspaces (only observability suite covers part).


# Workspace Domain — Invariants (Phase 3 support)

Status: HOLDS (observed/verified by code), EDGE (holds only under conditions), VIOLATED (defect logged).

| ID | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| INV-1 | The facade is the only import surface; gate is a pure re-export (no logic). | HOLDS | workspace-gate.ts:1-135; check-gates 0 production violations |
| INV-2 | Registry file is truth for listing/routing; missing/corrupt file reads as [] and never throws. | HOLDS (by design) — but fail-open consequence VIOLATED for lock/tenancy | workspace-registry.ts:237-249 |
| INV-3 | Registry writes are serialized per process; .env writes serialized + atomic rename 0600. | HOLDS | workspace-registry.ts:105-111,298-325; workspace-database.ts:141-196 |
| INV-4 | Secrets (DB URLs, PIN hashes) never appear in descriptors, pool stats, or errors. | HOLDS | workspace-registry.ts:212-234; workspace-database-runtime.ts:156-159; workspace-database.ts:65-104 |
| INV-5 | Per-workspace pools: reuse by URL hash, rotate on change, LRU cap, idle eviction. | HOLDS with leak edge | workspace-database-runtime.ts:91-136 (WS-007) |
| INV-6 | getWorkspaceDb never falls back to the process env pool; NO_DATABASE otherwise. | HOLDS (registry + per-ws env key only) | workspace-database-runtime.ts:91-107; resolveTier database.ts:168-172 |
| INV-7 | PIN hashes are registry-first; DB sync best-effort; plaintext never persisted. | HOLDS | workspace-pin.ts:32-52,85-148 |
| INV-8 | Screenlock enforcement reflects the current stored hash immediately. | VIOLATED | pin-gate.ts:117-129 15s cache, no production invalidate call (WS-001) |
| INV-9 | set/clear PIN report failure honestly (no success without persistence). | VIOLATED | workspace-pin.ts:96-116,129-148 (WS-002) |
| INV-10 | Local files are truth; PG is best-effort replica; conflict quarantines DB traffic. | VIOLATED for live writes | workspace-sync.ts:8-15,477-482 vs database.ts:168-172 + dualWrite (WS-004) |
| INV-11 | Workspace folder = sanitized display name; id is stable; rename moves the folder or refuses. | HOLDS with edge (case-only rename conflict; move-before-save window) | routes/workspace.ts:48-83,459-494 (WS-014) |
| INV-12 | Delete removes the folder only when CrowdOS-owned; never touches user/mounted content. | HOLDS for delete; mirror orphan leaks into scope discovery | routes/workspace.ts:85-93,520-540; local-file.ts:166-210 (WS-018) |
| INV-13 | resetWorkspaceDatabase leaves the DB re-provisionable and free of CrowdOS data. | VIOLATED | workspace-database.ts:648-691 vs schema tables (WS-003) |
| INV-14 | seedWorkspacePresets is idempotent and either complete or visibly partial. | HOLDS for idempotency; VIOLATED for visibility | workspace-database.ts:488-646 (WS-016) |
| INV-15 | Registry record and on-disk folder/mirror stay consistent after create/rename/delete. | HOLDS with edges | registry save + folder copy; rename window (WS-014), delete keeps mirror (WS-018) |
| INV-16 | No cross-domain import past a gate in production code. | HOLDS (allowlisted route->channel-local-store violation) | check-gates output (WS-015) |
| INV-17 | Workspace management stays usable DB-less (local-first). | HOLDS for 3 management paths; PATCH/DELETE rely on lazy pool (no connect) | pin-gate.ts:157-164; create-app.ts:238-310 |
| INV-18 | Path helpers refuse escapes (artifactDir traversal, delete outside sandbox). | HOLDS for those two; rootPath create/patch unvalidated | workspace-paths.ts:81-95; routes/workspace.ts:48-83 (WS-013) |


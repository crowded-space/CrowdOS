# Modules Domain — Invariants (Phase 3)

Status: Verified = traced in code + test; Suspected = code trace only; Broken = evidence of violation.

| # | Invariant | Status | Evidence |
|---|---|---|---|
| I1 | Only module-gate.ts may be imported cross-domain. | Verified | rg sweep: all 11 importers use module-gate.js; only test fixtures bypass (local-store/agent-local-store), check-gates allowlists them. |
| I2 | Gate is thin (no logic/fetch/DB). | Verified | module-gate.ts:1-188 is import/re-export/wiring only. |
| I3 | get/update of missing id -> null; delete -> []. | Verified | service:495-500,522-554,555-568 mirrors; routes 404 mapping routes/modules.ts:112,134,153. |
| I4 | apiKey encrypted at rest; plaintext only in testModelModule decrypt and runtime resolver. | Verified (local-tier nuance in M-3) | encrypt :507, :535; decrypt :583; runtime context-pipeline-manager.ts:104 decrypts separately (out of domain). |
| I5 | Mask sentinel ("[REDACTED]" or 4+ bullet/star) on update keeps stored key; explicit null clears. | Verified | :529-537; test "echoing the redacted mask back". |
| I6 | Connection test never throws; offline/timeout -> success:false+offline:true; unknown provider no network. | Verified | :222-353; no direct unit tests (gap T-2). |
| I7 | listAll cache cleared before every mutation (15 call sites) and keyed ws:dbScope:page. | Verified | clearListAllCache calls at :502,523,556,608,627,644,672,688,707,738,757,774,802,821,838 (15); key :474. |
| I8 | Local writes refuse unscoped scope outside VITEST. | Verified | local-store:51-56,162 etc; test :143-153 documents VITEST exemption. |
| I9 | Corrupt local file never overwritten by upsert/delete; reads tolerate. | Verified | local-store:92-112; test :186-203. |
| I10 | Unscoped local get/delete touch only default folder, never fan-out. | Verified | local-store:80-83,120-142; tests :216-222, :99-141. |
| I11 | PG delete guard is unscoped and names ALL blockers (409 MODULE_IN_USE). | Verified | :147-155; test :241-264 covers plural roster (local tier). |
| I12 | Route delete pre-check is tenant-scoped, first-only (single 409 name). | Verified | routes/modules.ts:144-149; test :99-141. |
| I13 | Local upserts require workspaceId; ensureDefaults is no-op without scope. | Verified | :385-393; tests :155-163. |
| I14 | validateReferences treats null/undefined FK as absent; throws on missing. | Suspected (empty-string hole, M-9) | :183-187, :208-212; "" id is skipped by != null checks on optional FKs and by falsy instruction check. |
| I15 | listAll pagination clamps identically on both tiers (limit 1-500 default 500). | Verified | :417-427, :449-483; test "empty limit". |
| I16 | Model mutations invalidate runtime model cache; toolkit mutations invalidate skills caches. | Verified | :544,552,561,566; :680,684,695,703,712,717. |
| I17 | workspace:sync emitted per mutation (routes layer). | Verified | routes/modules.ts:60-62 + every POST/PUT/DELETE handler. |
| I18 | apiKey never returned by route reads (redactSecrets on model reads). | Verified | routes/modules.ts:92,102,113,125,136; redact.ts masks strings only. |
| I19 | Module-row writes confined to this domain (runtime paths). | Verified with noted exceptions | Only db/seed.ts, db/check.ts, db/backfill-encrypt-secrets.ts, workspace/workspace-database.ts:497-501 write directly (seed/CLI/bootstrap, not request paths). |
| I20 | Module ids are server-minted UUIDs on create; client id stripped by Zod. | Verified | :503 etc; validators expose no id field. |

## Notes
- I4: local-tier rows carry the same ciphertext as PG (encrypt runs before tier branch at :507); no plaintext-write path found.
- I14 hole: optional FK "" and instructionModuleId "" bypass all missing-id checks and can be persisted (M-9).

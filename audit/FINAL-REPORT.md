# Audit-Fix Sweep — Final Report

Date: 2026-10-08 · Repo: `.ThisCrowd` (branch: main; no commits per AGENTS §4) · TASK_ID: final-report

## 1. Coverage

- 29/29 `audit/domains/*` areas carry `inventory.md` + `bug-ledger.csv` (484 ledger rows total; + 32-row cross-domain ledger `audit/cross-domain/bug-ledger.csv`).
- 24/29 carry the full five-doc set (inventory/contracts/invariants/plan/test-gaps). Reduced sets: core (no contracts/invariants/plan), routes (no invariants/test-gaps), shared (no plan), db (no invariants), types (no contracts/invariants/plan/test-gaps).
- check-gates domain list confirms 23 scanned code domains (client/desktop areas are not gate-scanned).

## 2. Fixed work (counts from the CSVs as parsed now)

- **120 rows**: Status matches `Fixed-verified` via strict Import-Csv (sweep baseline, 2026-10-07/08).
- **122 literal**: raw-file scan recovers 3 stray-quote rows whose Status tails also read Fixed-verified (AGT-002, AP-001, ART-7 — strict parse shifts their fields; see §3 note).
- **+21 alternate-format landed fixes** (not in the 119): types 6, swarm 5 (recon-annotated), runtime 3 (recon), routes 2 (fixed-in-tree), state 2 (STATE-001/003), core 1, db 1 (DB-006), queue 1 (Q-1 recon).
- Landed-fix records total ≈ **143** (122 literal + 12 alt-format + 9 recon-annotated). No Open row was flipped.

## 3. Verification summary

- **check-gates** (re-run 2026-10-08, `packages/server`): `Gate rule OK: scanned 383 files across 23 domains, 0 violations` — exit 0 (log: `audit/_check-gates-final.log`). 2 pre-existing gate bypasses remain allowlisted (create-app.ts / worker.ts → approvals/approval-sweeper.js); 54 non-fatal test-only import findings.
- Per-batch vitest/tsc results are recorded inside each ledger's Fixed-verified status strings — **not re-run in this task**. Examples: agents 21/21 + tsc 0; channel-mounts 59/59; workspace 85/85; shared sockets+queue 49/49; skills 39; db 23 passed/5 skipped; messages 11 passed/5 skipped; state 12; threads green; observability pass; artifacts 31 passed/4 skipped.
- This task ran only: check-gates + CSV parses (no vitest/tsc claims).
- CSV note: 10 rows carry stray inner quotes (AGT-002, AP-001, ART-7, AP-012, CAP-006, DB-003, DB-005, SH-005, TOLS-08/14/17/18). Strict Import-Csv still parses all files; values are shifted for those rows only. No Open row is affected.

## 4. Remaining in-scope opens + skip-list

- **STATE-002** (S2, state): partially fixed by design (fix-state-micro-002-003) — header repaired + gate emission contract/bypass set pinned by `src/state/state-gate.test.ts`; remaining direct writers (tool-executor per XD-028; research-runtime) deferred to a cross-domain consolidation task.
- **TOLS-05 (S2, tools): **Fixed-verified 2026-10-08** (user decision = PERSIST; fourth attempt landed: register upserts mcp_servers, unregisterServer deletes, restoreServersFromDb at boot; restart-sim 13/13, tsc clean; doc-sync pass synced Ports/Relations + flow claim).
- Skip-list (no flips performed): MEM-005 Open (memories; ledger reads Open) · XD-027 deferred/partial (cross-domain; ledger reads Open; consolidation separate task) · XD-028 accepted risk (cross-domain; ledger reads Open).
- Beyond sweep scope, the standing backlog remains as recorded (S2 examples: EVT-02/03/06/10; RTE-002/003/004/005/010/011/015/016; XD-001/007/017/018/021/027/028; SW-04/07/08; Q-2/3/5/8; M-01/02/03/05/07/11; B4, B1/B2, B-10). S3-dominant remainder across all ledgers.

## 5. Per-domain table (rows | fixed-verified | open)

| Domain | Rows | Fixed | Open | Notes |
|---|---|---|---|---|
| agents | 25 | 9 | 16 | |
| approvals | 18 | 7 | 11 | AP-001 stray-quote (raw tail Fixed-verified) |
| artifacts | 14 | 9 | 5 | ART-7 stray-quote |
| capabilities | 9 | — | 9 | no Status col; S3 recommendations, unlanded |
| channel-mounts | 22 | 5 | 16 | CM-022 intentional |
| channels | 34 | 14 | 20 | CHN-010 open-partial |
| core | 3 | 0 (+1 alt) | 2 | CORE-002 fixed (alt format) |
| db | 11 | 6 | 4 | DB-006 fixed-uncommitted; DB-003 stray-quote |
| event-broker | 7 | 0 | 7 | B4 High open |
| events | 16 | 0 | 15 | pipe-delimited; EVT-14 closed-accepted |
| filesystem | 10 | 1 | 9 | |
| memories | 20 | 7 | 13 | MEM-005 open (skip-list) |
| messages | 30 | 15 | 15 | |
| modules | 15 | — | 15 | no Status col; S2s among M-01..M-11 |
| observability | 19 | 6 | 12 | OBS-014 accepted |
| queue | 14 | 0 (+1 recon) | 13 | Q-1 recon-fixed; no Status col |
| routes | 19 | 0 (+2 tree) | 16 | pipe-delimited; RTE-019 reconciled |
| runs | 31 | 10 | 21 | |
| runtime | 12 | 0 (+3 recon) | 9 | B-10 High open |
| search-providers | 10 | 1 | 9 | |
| shared | 7 | 5 | 2 | SH-005 stray-quote |
| shared-auth | 8 | — | 8 | no Status col; unlanded |
| skills | 13 | 3 | 10 | |
| state | 9 | 2 (+2 alt) | 4 | STATE-002 partial |
| swarm | 20 | 0 (+5 recon) | 15 | |
| threads | 31 | 11 | 20 | THR-026 open-partial |
| tools | 19 | 5 | 13 | TOLS-05 fixed-verified 2026-10-08 (persist); TOLS-16/18 accepted |
| types | 8 | 0 (+6 alt) | 1 | 1 reviewed; TYPES-008 S4 |
| workspace | 30 | 7 | 22 | WS-028 intentional |

Totals: 484 rows = 123 fixed-verified literal + 12 alt-format fixed + 9 recon-annotated + 6 accepted/closed/intentional + 1 partial + 2 reviewed + 69 no-Status (unlanded) + 263 open. Strict Import-Csv baseline for fixed-verified: 120.

## 6. Domain exit checklist

- [x] 29/29 areas inventoried; inventory + ledger present
- [x] Fixed counts extracted from CSVs (119 strict / 122 literal / 143 incl. alt formats)
- [x] check-gates re-run: 0 violations, exit 0
- [x] TOLS-05 persist landed + verified + docs synced; row flipped Fixed-verified 2026-10-08
- [x] No other ledger rows touched; no code edits; no commit/push/branch; main untouched
- [x] Docs-sync note (below)
- [ ] User live review (pending)
- [ ] Commit decision — only on explicit "yes"; push/pull via `git-crow`

## 7. Docs-sync note

- `re-docs/` is gitignored (on-disk only); `audit/` is untracked (on-disk deliverable). This task edited only `audit/domains/tools/bug-ledger.csv` (TOLS-05 Status append) and created `audit/FINAL-REPORT.md` + `audit/index.md`.
- Residual: Tools.md Owns line 108 still says mcp_servers doubtful (outside doc-sync scope; in Gaps).

## 8. Next step

Live review by user → explicit "commit?" decision. No auto-commit/push. On explicit yes: commit via the `git-crow` custom auth flow; push/pull only via `git-crow`.

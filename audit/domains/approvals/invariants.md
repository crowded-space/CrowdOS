# Approvals Domain — Invariants (asserted vs actual)

State machine: `pending → approved | denied | expired` (terminal set: approved/denied/expired). No transition out of terminal states in code paths audited. Enum defined twice: `approval-types.ts:11` (TS union) and `db/schema.ts:42` (pg enum) — no compile-time equality check (mirrors RUN-017 pattern).

| ID | Invariant | Where enforced | Status | Evidence |
| -- | --------- | -------------- | ------ | -------- |
| INV-1 | A decision is single-winner: only one `pending→approved/denied` claim per row | `decide` conditional UPDATE in txn | HOLDS | approval-repository.ts:118-131; integration test "rejects double decision" |
| INV-2 | `decide` only acts on pending; non-pending/missing → null, never throws (business-wise) | conditional UPDATE | HOLDS (business); DB transport errors still throw | repo:122-128 |
| INV-3 | Expiry is bulk `pending + expiresAt<now → expired` | repo:158-166 | HOLDS | integration test TTL |
| INV-4 | Expired ⇒ treated as denied (default-deny); run resumed to running, tool fails safely | sweeper:34-41 + executor reasonMap (:546-550) | HOLDS | approval-sweeper.ts:36-41; tool-executor.ts:542-550 |
| INV-5 | Expired rows carry `decidedAt`, `decidedBy` may be null | repo:164 | HOLDS; doc standard says decidedBy non-null for expired (Target) — violated by design today | Domain Spec Approvals.md "Expired rows carry decidedAt plus system decidedBy, never null" vs repo:164 (no decidedBy) → AP-007 |
| INV-6 | Reusable grant = approved + same tool + same scope + requester + unexpired | repo:80-95 strict pass | WEAKENED by fallback: requester filter dropped in second query (:96-112) → any agent's approval is reusable by any other agent | repo:96-112; integration test acknowledges and accepts fallback (:173-176) → AP-002 |
| INV-7 | Scope hash covers FULL tool args (no 500-char preview collisions) | executor passes full args (:410,641) | HOLDS in executor; note repo hashes whatever is passed | tool-executor.ts:406-410; types.ts:65 |
| INV-8 | One `approval.decided` emit shape via single helper | gate:83-98 used by 4 producers | HOLDS shape; duplicates possible (same decision observed by REST emit + executor wait emit + sweeper if racing) | gate:83; routes:55; socket:1137; executor:530,727; sweeper:44 |
| INV-9 | Run resumes exactly when `waiting_for_approval` (idempotent no-op otherwise) | routes:81-84, socket:1152-1156, sweeper:38-40, executor:542/545 | HOLDS (state machine rejects illegal) | run-state-machine.ts:43 waiting→running legal; same-state no-op |
| INV-10 | pending rows must have expiresAt (TTL) — else wait poll never self-expires? | createRequest default (:17-23) | HOLDS by default; explicit `expiresAt:null` accepted (types allow null) → row without TTL is only swept when expiresAt NULL? `lt(expiresAt, now)` excludes NULL → pending forever unless decided | repo:17-23 accepts null; expire WHERE lt() excludes NULL → AP-008 (Low) |
| INV-11 | Terminal rows immutable | no UPDATE guards status except decide/expire predicates | HOLDS implicitly (no code path updates terminal rows) | repo scans |
| INV-12 | created rows always have runId FK (cascade delete with run) | schema.ts:563 + 0008:48 | HOLDS | migration |
| INV-13 | Sweep resumes run exactly once per expired row; repeated sweep no-op | transition CAS + status filter | HOLDS unless two sweeper instances race (both select expired rows already flipped — the flip is once; per-row resume guarded by state check) | sweeper:36-41 |
| INV-14 | `findReusableGrant` never returns expired grant | `gt(expiresAt, now)` | HOLDS (NULL expiresAt excluded) | repo:88,106 |
| INV-15 | approval_requests.scope stores scope-hash; `'reusable'` sentinel never stored | decide ignores sentinel for assignment (:135-138) | HOLDS for decide; BUT client ApprovalCard sends `scope='reusable'` (ApprovalCard.tsx:71) → server treats as extend-expiry-only; scope stays previous value (null for hash-less pending!) → "Grant for session" on a pending row with scope=null yields approved with scope=null and NO reusable grant possible (hash mismatch) — the button's promise (session reuse) does not hold | ApprovalCard.tsx:66-73; repo:135-141; executor findReusableGrant(scope=hash) → AP-001 (Confirmed by code reading; not executed) |

## Tenant/DB invariants

- INV-T1: REST requests run in ALS tenant scope when x-workspace-id present (create-app.ts:235-303) → repo getDb() resolves tenant handle. HOLDS.
- INV-T2: Socket handlers run with NO ALS; repo getDb() → global pool. In split-DB deployments, decide/getById/listByRun hit the wrong DB. Confirmed by code (register-socket-server.ts:1118-1131 has no runWithDb). Impact Low-Medium (default deployments single-DB). → AP-009.
- INV-T3: Sweeper intentionally fans out per workspace DB (approval-sweeper.ts:12-19) — the only multi-DB-aware path. But targets only include records whose `databaseUrl` is set AND `source==='workspace'` (workspace-database-runtime.ts:174-178); workspaces falling back to env/global DB are skipped (Low confidence about deployment prevalence → AP-003).

## Event invariants

- INV-E1: `approval.requested` must be emitted with payload.channelId so socket fan-out can room-scope it (register-socket-server.ts:414-441). Executor sets channelId fallback "general" (:399,633). When channelId is "general" (missing context), fan-out falls to observed-rooms/global branch — possible cross-workspace leakage via `io.emit` localhost fallback (register-socket-server.ts:455-458). Low confidence. → AP-010 (Low).
- INV-E2: `approval.decided` payloads from sweeper carry workspaceId tag (sweeper:52-53); REST/socket/executor emits do NOT carry workspaceId (routes:56-64, socket:1136-1145, executor:530-538) → clients ignore foreign decisions only for sweeper path; REST path relies on channelId room scoping. Client handler filters by nothing but id (crowdOsStore.ts:1676-1682) → cross-workspace decision visibility possible only if room scoping fails. Low confidence.

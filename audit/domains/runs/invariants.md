# Runs Domain — Invariant Catalog (read-only audit, 2026-10-06)

Legend: **Enforced** = guarded in code paths reachable in production; **Partial** = guarded only under some call patterns; **Unenforced** = documented intent with no code guard; **Broken** = code violates the stated intent.

## A. State-machine invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-1 | Only edges in TRANSITIONS may be applied; illegal edges return null and never write | Enforced | `run-state-machine.ts:69-100` + `runs-repository.ts:117-118` | unit tests cover every edge + representatives |
| INV-2 | `completed`/`failed`/`cancelled` are immutable (no outgoing edge except same-state no-op) | Enforced | `run-state-machine.ts:91-93`; integration test asserts via SQL | runs-repository.integration.test.ts:122-133 |
| INV-3 | Same-state transition is a legal no-op returning `{changed:false}` and does NOT write | Enforced | `runs-repository.ts:119-121` | unit + integration tests |
| INV-4 | `cancelling` is the only funnel to `cancelled` | Enforced | `run-state-machine.ts:51` | map |
| INV-5 | Every non-terminal state has at least one exit; terminals have none | Enforced | map + test "never leaves a dead end" | run-state-machine.test.ts |
| INV-6 | Unknown states are rejected at runtime (no unvalidated string cast reaches SQL) | Enforced | `isRunState` in transition() | test "guards against unknown states" |
| INV-7 | Orphan path is two-hop (`→ orphaned → resumable`), never direct to failed/queued | Enforced | map (no direct edges exist) + sweep code | orphan-sweep.ts:97-104 |
| INV-8 | `waiting_for_approval` is excluded from sweep candidacy | Enforced | `orphan-sweep.ts:26-42` (not listed) | integration test asserts created/queued behavior; approval exclusion by absence |
| INV-9 | `created`/`queued` are swept only past 10× the live threshold | Enforced | `orphan-sweep.ts:17-18,72-73` | integration test |
| INV-10 | Status writes go through the single choke point `applyTransition` (no other writer) | Enforced | grep: no other production code writes runs.status; cost-ledger reads only | runs-repository.ts is the only writer |

## B. Checkpoint invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-11 | Watermark is monotonic (never decreases) | Enforced | SQL `greatest(coalesce(...), seq)` in both overloads | runs-repository.ts:169,180 |
| INV-12 | `completedCallIds` is a distinct union (no lost ids under concurrency) | Enforced | single-statement `jsonb_agg(distinct)` | runs-repository.ts:190; integration test |
| INV-13 | Callers never read-modify-write checkpoints | Enforced | no caller reads checkpoint then writes; only touchCheckpoint merges | grep of callers |
| INV-14 | Checkpoint/heartbeat failures never fail the run (best-effort) | Enforced | try/catch → warn → false | runs-repository.ts:210-213,222-225 |
| INV-15 | Checkpoints can be written regardless of run status (no guard) | **Unenforced (by design gap)** | no status predicate in UPDATE | a checkpoint can be written to a terminal or foreign-status row; see RUN-010 |
| INV-16 | `checkpointSeq` mirror stays ≥ watermark | Partial | updated only when patch.watermarkSeq is defined; numeric overload also updates | rows whose checkpoint was written by other paths may drift; consumer unknown (Q4 open) |

## C. Compensation invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-17 | Journal is ordered per run: `seq = max+1`, UNIQUE(run_id,seq), retry on 23505 | Enforced | runs-repository.ts:246-260 + schema unique index | integration test asserts [1,2] |
| INV-18 | Inverse is appended BEFORE the mutation it can undo | Partial | tool-registry write/delete paths journal before fs write; coding-runtime journals AFTER `fs.writeFile` (lines 232 vs 242, 344 vs 354) | RUN-003; window where a crash loses undo for a completed write |
| INV-19 | `restore` never applies store-time-truncated content | Enforced | refusal on `truncated:true` | runs-service.ts:56-59; unit test |
| INV-20 | `restore` verifies sha256 of stored content before applying | Enforced | priorHash compare | runs-service.ts:60-64; unit test |
| INV-21 | Unknown inverse ops are refused and the row is kept | Enforced | op whitelist | runs-service.ts:52-55; unit test |
| INV-22 | Journal row is deleted ONLY after the filesystem inverse succeeds | Enforced | delete after fs block | runs-service.ts:96 |
| INV-23 | Undo path stays inside the workspace root (Guard.validatePath) | Enforced | Guard before fs op | runs-service.ts:85-93 |
| INV-24 | Journaling failure never blocks the mutation | Enforced | callers wrap in `catch {}` | tool-registry.ts:288,336,414; coding-runtime.ts:243,355 |
| INV-25 | Journaling failure is observable (not silent) | **Unenforced** | bare `catch {}` at all 5 call sites + `addCompensation` warn only inside repository | RUN-004; no metric, caller discards the null |
| INV-26 | `truncated` flag exists on the stored JSONB but not in the `CompensationInverseOp` type | **Broken (type/schema drift)** | builder casts `as CompensationInverseOp`; service re-casts to add `truncated?` | runs-repository.ts:238; runs-service.ts:49; schema.ts:976-981 lacks the field (RUN-005) |

## D. Sweep invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-27 | Sweep is bounded (limit 50) and lock-safe (`FOR UPDATE SKIP LOCKED`) | Enforced | orphan-sweep.ts:67-78 | |
| INV-28 | Sweep never throws; per-DB failures warn and continue | Enforced | catch around sweepOneDb | orphan-sweep.ts:106-108 |
| INV-29 | Sweep covers all workspace DBs AND the shared handle | Enforced | forEachWorkspaceDb + isDatabaseConfigured guard | orphan-sweep.ts:110-114 |
| INV-30 | Sweeper timer never holds the process open | Enforced | `timer.unref?.()` | orphan-sweep.ts:126 |
| INV-31 | Sweeper is single-instance per process | Enforced | module `started` flag | orphan-sweep.ts:118-123; multi-process single-owner relies on bullmq mode suppressing API timers |
| INV-32 | Stale rows transition atomically per hop (no torn state left silently) | Partial | two separate CAS calls; a crash between hops leaves `orphaned` — self-healed next sweep | orphan-sweep.ts:97-104 |
| INV-33 | Sweep liveness threshold (60s) cannot reap a merely-slow live run | Partial | heartbeat every 15s covers running/starting/etc.; `waiting_for_approval` excluded entirely; but a GC pause/event-loop stall >60s in inline mode can still be reaped mid-run | depends on heartbeat actually firing; executor clears it as soon as execute settles |

## E. Resume invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-34 | `resumeRun` accepts ONLY `resumable` | Enforced | status check before transition | runs-service.ts:16; integration test |
| INV-35 | Resume is single-use (queued rejects a repeat) | Enforced | status guard + map | integration test asserts second resume null |
| INV-36 | Resume returns the checkpoint for delivery as data | Enforced | return shape | runs-service.ts:38 |
| INV-37 | Resume emits exactly one `run.status_changed` when changed | Enforced | emit after changed check | runs-service.ts:22-37 |
| INV-38 | A resume that flips state always reaches delivery (enqueue or inline execute) | **Unenforced** | route/socket log-and-swallow enqueue failures and unresolved agents | routes/runs.ts:30-33,48-54 (RUN-006) |
| INV-39 | Resume skip covers every runtime flavor | Partial | agentic-runtime only reads `completedCallIds` | agentic-runtime.ts:28-29,175-208; conversational/coding/research/swarm unverified (docs gap) |
| INV-40 | `historyRef` deep-resume fidelity | **Unenforced** | no loader reads historyRef anywhere | grep: only producers/ferry (types + resumeContext) |

## F. Cross-cutting invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-41 | Gate-only access across domains | Enforced (prod) | check-gates.mjs 0 violations | 4 test-file bypasses flagged TEST-ONLY |
| INV-42 | `RUNS_ENABLED=false` disables all domain I/O | Enforced | every repository entry checks first | runs-repository.ts:39,74,111,152,159,217,242,266,277,284,290 |
| INV-43 | Write and read land on the same DB handle for the same threading | Partial | resolver pair; but workspaceId is never threaded by callers → both sides land on ALS/global handle only when no workspaceId is passed; a THREADED create (none today) would be invisible to unthreaded readers | inventory §7; RUN-007 |
| INV-44 | Events are emitted only when a transition changed | Enforced | state-gate/resume/sweep all gate on changed | |
| INV-45 | Event payload shape matches RunStatusChangedEventPayload | Enforced | typed emit in state-gate; sweep/resume cast `as never` but same keys | |
| INV-46 | `run.compensations` is emitted exactly once per undo (no double emit) | Enforced | single emit site per transport path; service returns entries | routes/runs.ts:87-94; socket :1093 |
| INV-47 | Terminal runs never re-enter execution | Enforced (via state machine) | executor walk throws on rejected hop | runtime-executor.ts:243-254 |
| INV-48 | No partial write can leave a run "lost" (not terminal, not swept) | Partial | sweep self-heals `orphaned`/`cancelling`; a row stuck in `created`/`queued` beyond pending threshold is swept to resumable (safe); a row stuck in `running` with a live heartbeat forever leaks (no max-age) | RUN-011 |

## G. Data-format invariants (must not change silently)

| ID | Invariant | Status |
| --- | --- | --- |
| INV-49 | `RunStatus` (DB enum) and `RunState` (machine) share one value set | **Unenforced** — duplicate declarations, no compile-time equality check (docs Q2 open; drift surfaces only at runtime as "unknown state") |
| INV-50 | `checkpoint.updatedAt` is an ISO string | Enforced by writer (`to_jsonb(::text)` of ISO now); no reader validates |
| INV-51 | Compensation `inverseOp.path` is stored as the caller-supplied relative path (validated at undo time against the resolved root, not at store time) | Enforced at undo |
| INV-52 | `runs.status` schema default ('running') is never used | Enforced by code (insert always passes 'created'); DDL default remains a foot-gun for raw SQL inserts |

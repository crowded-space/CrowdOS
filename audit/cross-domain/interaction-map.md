# Cross-Domain Interaction Audit — packages/server/src

Scope: boundary interactions among threads, messages, runs, channels, channel-mounts, workspace, approvals, artifacts, tools, agents, skills, memories, state, queue, events, swarm, modules, capabilities, filesystem, observability, search-providers (+ event-broker, runtime, routes, shared as cross-cutting).
Read-only audit. Evidence at file:line. Internal findings live in audit/domains/*/bug-ledger.csv and are not repeated here.
Method: static import scan (audit/cross-domain/_scan.mjs, value imports, type-only stripped, tests excluded) + manual trace of every known cross-ref.

---

## 1. Interaction Map

### 1.1 Ownership of shared tables (who writes what)

| Table | Owner domain | Other writers | Risk |
|---|---|---|---|
| messages | Messages | Threads reads (XD-017); workspace-sync writes/deletes (XD-021); routes/search.ts reads (XD-001); librarian reads | THR-015/XD-001 |
| channel_sequences | Messages | shared/core/sequence-number.ts (allocator), message-service raw repair, workspace-sync (XD-020) | 3 writers |
| thread_sequences | Threads (bootstrap only) | shared/core/thread-sequence.ts called from Messages append (XD-018) | split write |
| runs | Runs | observability reads directly (XD-012); approvals/tools transition via runsGate | RUN-012 |
| runs_compensation | Runs | tools/tool-registry + coding-runtime journal via runsGate | in-domain |
| approval_requests | Approvals | routes read via gate | clean |
| agents | Agents | workspace-sync inserts (XD-021); capabilities/memories read; socket reads table directly (XD-022) | read coupling |
| runtime_states | Agents | shared/core/agent-heartbeat via agentGate (Q-1 fixed) | clean-ish |
| channels / categories | Channels | workspace-sync writes (XD-021); threads reads (XD-017); search reads (XD-001); socket reads (XD-022) | read coupling |
| artifacts | Artifacts | runtimes create via artifactsGate (tenant bug XD-016) | clean gate, bad scope |
| agent_instruction_stacks | Agents/Modules | routes/studio.ts direct delete+insert (XD-015) | bypass |
| agent_skills | Skills | fixed via skillsGate.replaceAgentSkills (SK-001 verified) | clean |
| token_usage_log | Observability/Shared | token-tracker inserts; cost-ledger reads | units split (XD-026) |
| channel_index / compressed_summaries | Shared librarian (no domain gate) | shared/core/index-builder + librarian-runtime | ungated |

### 1.2 Key runtime flows (crossing gates)

1. **Socket user:message** → channelGate.get → messageGate.append (broker) → agentRegistry.list(scoped) → runtimeGate.execute → RuntimeExecutor → stateGate.applyRunTransition → runsGate → broker fan-out → event-log onAny. WorkspaceId is carried (msgWorkspaceId) but **dropped at stateGate** (XD-002) and **not applied as ALS for runtime/artifact writes** (XD-016).
2. **HTTP thread message** → threadGate.get → messageGate.append (no broker) → route manual emit (XD-008) → threadGate.incrementCount (second write, XD-030).
3. **Tool approval** → tool-executor approvalGate.createPending → runsGate.transition(waiting_for_approval) with bare catch (XD-028) → poll approvalGate.getById → runsGate.transition(running) direct (bypasses stateGate, XD-009).
4. **Resume** → runsGate.resumeRun (emits typed-as-never, XD-023) → queueGate.enqueueRun OR inline runtimeGate.execute (delivery failure not surfaced, RUN-006) → RuntimeExecutor walk via stateGate.
5. **Research sub-runs** → runsGate.create child → queueGate.enqueueRun (bullmq) AND inline search (XD-019) → child transitions direct via runsGate (no stateGate).
6. **Events log** → broker onAny → recordBrokerEvent → payload workspaceId trusted before channel row (XD-013); reads by channelId only (XD-014).
7. **Sync/import** → workspace-sync bypasses all gates and events for channels/agents/messages replay (XD-021).

---

## 2. Boundary Contract Matrix

Legend: OK = gate-only + scoped; BYPASS = import past gate; SCOPE = tenant scope lost; EMIT = event emission ownership issue; TYPE = typing/contract drift.

| Consumer → Provider | Entry used | Verdict | Defect |
|---|---|---|---|
| state → runs | runsGate.transition | SCOPE | XD-002 (no workspaceId) |
| state → messages | messageGate.append | dead port | MSG-023 (not repeated) |
| approvals/tools → runs | runsGate.transition | EMIT/SCOPE | XD-009, XD-028 |
| observability → runs | direct table select | BYPASS | XD-012 / OBS-013 |
| observability → modules | moduleGate | OK | — |
| threads → messages/channels | direct table reads | BYPASS | XD-017 / THR-015 |
| messages → channels | channelGate.get (cached) | OK + dup cache | XD-024 |
| messages → workspace | workspaceGate.tierContextFor | OK | — |
| events → channels | shared local-file resolver (not channelGate) | indirect | XD-013 |
| events → event-broker | onAny subscriber | OK | — |
| search → channels/messages | raw SQL, no gate | BYPASS + SCOPE | XD-001 |
| routes/workspace → channels internals | dynamic import (allowlisted) | BYPASS | XD-006 / WS-015 |
| routes/studio → agent_instruction_stacks | direct delete+insert | BYPASS + ATOMICITY | XD-015 |
| routes/studio → skills | skillsGate.replaceAgentSkills | OK (fixed) | SK-001 verified |
| routes/channels → agents | agentGate.getById unscoped | SCOPE | XD-004 / AGT-004 |
| socket → agents | agentRegistry legacy export + direct table reads | BYPASS | XD-022 / AGT-003 partial |
| socket/runtime → artifacts | artifactsGate, bare getDb | SCOPE | XD-016 / ART-2 |
| capabilities → tools/skills/agents | all gates | OK | — |
| skills → agents (invalidate caches) | no agent import (db tables) | OK-ish | — |
| memories → agents/workspace | resolveMemoryDb + opts | SCOPE (call sites) | XD-003 (MEM-001 half-fixed) |
| agent-errors → messages | messageGate.append (broker passed) | OK | — |
| tool-registry → messages | messageGate.append | OK | — |
| swarm → agents/artifacts/runtime types | gates | OK | — |
| queue → event-broker | getSharedBroker | OK | — |
| shared/agent-heartbeat → memories/agents | gates | OK | Q-1 verified |
| shared/workspace-sync → channels/messages/agents tables | direct writes | BYPASS | XD-021 |
| event-types → messages/runs | type-only imports | OK | — |

---

## 3. Dependency-Cycle Report

Method: value imports only (type-only stripped), tests excluded, scan script audit/cross-domain/_scan.mjs. Result: **no domain↔domain runtime cycle among gated domains**; all cycles involve the exempt shared/ layer or db//types/.

| Cycle | Nature | Verdict |
|---|---|---|
| agents ↔ shared | shared/core/mention-parser, token-tracker, workspace-sync, sockets → agents; agents → shared helpers | Exempt-layer cycle; accepted by AGENTS §2 but keeps agents coupled to the socket hub |
| messages ↔ shared | shared/core/sequence-number, thread-sequence, librarian → message-local-store/messages; messages → shared | Exempt-layer cycle (sequence allocators live in shared while tables are Messages-owned → XD-018/XD-020) |
| memories ↔ shared | shared/agent-heartbeat → memories gate; memories → shared | Exempt-layer cycle, benign (Q-1 wiring) |
| runtime ↔ shared | shared/sockets/register-socket-server → runtime; runtime → shared | Exempt-layer; socket hub is the real coupling point (XD-022) |
| db ↔ shared, core ↔ shared, channels ↔ shared, modules ↔ shared, shared ↔ workspace | shared ↔ db/types/config helpers | Exempt layer by definition; no gated-domain cycle |
| event-broker → messages/runs/types | type-only imports (verified via type-only strip) | No runtime cycle |

Latent cycles that would appear if type-only imports became value imports: none found beyond the above (checked capabilities → runtime/types and runtime/types → capabilities are type-only both ways).

Gate→internal cycles: approvals gate ↔ sweeper is handled by dynamic import (approval-gate.ts:59-63 comment); worker.ts + create-app.ts allowlisted (check-gates.mjs KNOWN_VIOLATIONS).

---

## 4. Recommended Ownership Changes

1. **Runs owns its read port**: add runsGate.getMetaByIds(ids) for observability (XD-012).
2. **Messages owns channel_sequences AND thread_sequences end-to-end**: move allocateThreadSequence behind threadGate (Threads owns table bootstrap), move replica-repair raw SQL into the Messages allocator (XD-018, XD-020).
3. **State owns run.status_changed emission completely**: finish the funnel (approvals, tools, sweeps route through stateGate; stateGate carries workspaceId) (XD-002, XD-009).
4. **Channels owns workspace-of-channel resolution**: export one cached resolver; messages + events consume it (XD-024); events uses channel row as authority, payload workspaceId demoted to audit field (XD-013).
5. **A Sync domain (or explicit replay ports on Channels/Agents/Messages) owns workspace-sync writes** so replay cannot skip invariants/events (XD-021).
6. **Search becomes a proper domain** (gate + workspace-scoped read ports over Channels/Messages) or is moved under Channels/Messages routes (XD-001).
7. **Socket hub migrates to gates**: agentGate ports only, no direct workspaces/agents/channels table reads (XD-022).
8. **Artifacts + runtimes get tenant handle threading** (runWithDb for socket/worker execution paths) (XD-016).
9. **Threads message pages move behind messageGate ports** (XD-017).
10. **Instruction-stack replacement moves behind an Agents gate port** (XD-015).

---

## 5. Integration & Consumer-Driven Contract Test Plan

Tier 1 — tenant/scope (fail today, highest value):
1. Two-DB harness: socket-style run in workspace W; assert run row, run.status_changed hop, artifact row all land in W DB (XD-002, XD-016).
2. Search scoped: two workspaces; GET /api/search returns only caller-workspace rows (XD-001).
3. Channel settings pin: foreign-workspace agent id rejected 400/404 (XD-004).
4. Events: record with conflicting payload workspaceId; log lands in channel-owner workspace (XD-013); GET recent from another workspace's channel is 403/404 or documented (XD-014).
5. Memory audit: create/update/archive/suppress with {workspaceId}; memory_update_log row in same store (XD-003).

Tier 2 — event/state contracts:
6. One transition = exactly one run.status_changed, regardless of caller (executor, approval decide, sweeper, tool executor) (XD-009, XD-023).
7. Exactly one message:new per append path, including thread posts (XD-008).
8. Broker event count for a socket user message: message:new once, run.queued once (regression).

Tier 3 — data integrity:
9. Adapter test: channel msg + thread reply same logical seq both exist in PG replica (XD-007 / MSG-001 / THR-002).
10. Crash-injection: kill between append and incrementCount → documented/reconciled count (XD-030).
11. Queue retry: after forced closeRun failure, retried job with non-executable run status refuses execution (XD-027).
12. Approval wait: force transition transport error → observable signal, run state documented (XD-028).

Tier 4 — consumer-driven contracts (gate shape):
13. Gate-shape test per domain: exported object ports ⊇ documented Ports; no cross-domain import past gate (extend check-gates to table-symbol usage where feasible).
14. Pagination contract tests pinning accepted cursor formats per list port (XD-025).
15. Sync replay test: import/push emits domain events and passes gate invariants (XD-021).

---

## 6. Ordered Remediation Plan

P0 (S1, do first — data loss/cross-tenant):
1. XD-007/MSG-001/THR-002 thread-aware messages index migration + stop blind onConflictDoNothing.
2. XD-016/ART-2 tenant handle threading for socket/worker runtime execution (artifacts + runs).
3. XD-004/AGT-004 channel pin workspace scoping (one-line gate arg + test).
4. XD-002 state-gate workspaceId threading (pairs with RUN-007 in runs ledger).

P1 (S2, correctness at boundaries):
5. XD-003 finish MEM-001 call-site threading (4 lines).
6. XD-001 search workspace scoping (route or new domain).
7. XD-027 executor refuse non-executable statuses on reuse (RUN-026 alignment).
8. XD-028 tool-executor transition error visibility.
9. XD-015 instruction-stack atomic replace port.
10. XD-008 thread message single-emit ownership.
11. XD-013/XD-014 events tenant authority + read assertion.
12. XD-009 finish state funnel (after XD-002).
13. XD-021/XD-017/XD-018/XD-020 ownership moves (one at a time, docs in same task).

P2 (S3, hygiene/consistency):
14. XD-012 runs read port; XD-022 socket gate migration; XD-024 shared channel→workspace resolver; XD-019 research sub-run dedupe; XD-023 event typing; XD-025 pagination contract notes; XD-026 usage/cost unit contract; XD-029 socket payload-trust delivery; XD-030 count reconciliation; XD-031 compat notes; XD-032 bounded queries.

Each fix: same-task docs sync (Domain Spec + _index/_flow-index per AGENTS §6), no branches, review-gated commits.

---

## 7. Verified Known Cross-Refs (status)

| Ref | Verdict |
|---|---|
| RUN-012/OBS-013 | Open (XD-012) |
| MSG-001/THR-002 | Open, S1 (XD-007) |
| MSG-009 | Open (XD-008) |
| MSG-023/ST-002 | Confirmed dead (not repeated) |
| WS-015/CHN-020 | Open allowlist (XD-006) |
| THR-015/THR-016 | Open (XD-017/XD-018) |
| SK-001 | FIXED (skillsGate.replaceAgentSkills, studio.ts:155) — sibling XD-015 still open |
| ART-2 | Open on resume path (XD-016) |
| AGT-003 | FIXED (socket + mention-parser scoped) — AGT-004 still open (XD-004) |
| MEM-001 | PARTIAL: signature fixed, call sites not threaded (XD-003) |
| ST-001 | Open (XD-009) |
| Q-1 | FIXED (touchWorkingAgents exported + worker calls it) |
| AP-002 | FIXED (strict per-requester, fallback deleted) |
| EVT-02/EVT-03 | Open (XD-013/XD-014) |

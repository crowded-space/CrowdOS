# CrowdOS — Production Architecture & Agent-Runtime Audit

**Date:** 2026-08-26 · **Scope:** Full stack (`packages/server`, `packages/client`, `packages/pi-core`, `packages/shared`, infra, tests, docs)
**Method:** 11 parallel deep-audit passes (system inventory, runtime engine, agent/swarm lifecycle, pipeline/perf/cost, persistence, events/streaming, tools/security, frontend UX, prompt/memory architecture, testing, docs-vs-reality) + direct source verification of load-bearing claims.
**Evidence tags:** `[Observed]` verified in code/runtime · `[Inferred]` strongly implied · `[Missing]` no implementation · `[Broken]` implemented but incorrect · `[Risk]` works but dangerous · `[Opportunity]` improvement.

---

## A. Executive Verdict

> **Primary objective answer: No — CrowdOS cannot yet provide a seamless, reliable, observable, resumable, low-latency, cost-efficient multi-agent experience comparable to Codex / Claude Code / Cursor-class platforms.**
>
> It is a genuinely well-structured **prototype** with several production-grade seeds (typed event broker with durable replay, provider abstraction across 5 adapters, a disciplined 10-stage context pipeline, real streaming end-to-end, Discord-native UX that actually works). But its headline capability — **multi-agent orchestration — is simulated**, execution is **not durable or resumable**, security is **pre-production** (open-by-default auth, RCE-class shell escapes), and the observability layer is largely dead surface.

| Dimension | Score | Basis |
| --- | ---: | --- |
| Architecture Maturity | 4/10 | Clean domain-gate discipline (137 files, 0 violations via `check-gates.mjs`), typed broker, stateless runtimes over shared kernel; but conversation/execution/event conflation, no run entity, single-process design, ~600 lines dead core code. |
| Runtime Maturity | 3/10 | Conversational + Agentic are real and tested; Coding delegates credibly to pi-core; Research = alias of Agentic (`RuntimeExecutor.ts:31-39`); Swarm = 71-line prompt-stub (`SwarmRuntime.ts:28-38`). |
| Agent Orchestration | 2/10 | Delegation/spawn is theater: `setTimeout(800)` mock outputs (`agentSpawnManager.ts:385-388`), keyword verdicts (:435-443), canned escalations (`agentErrors.ts:138-163`); no recursion depth control, no cycle detection, no delegation records. |
| Backend Reliability | 3/10 | Heartbeat orphan-sweeper and 23505-retry loops are good patterns; but a crash kills every in-flight run (no queue/worker/checkpoint), sequence races on the socket path (`sequenceNumber.ts:6-11`), bootstrap DDL drifted from schema (missing `durable_events`!), zero transactions. |
| Performance | 4/10 | Parallel context pipeline, 50ms stream batching, TTL caches, tool-output clamping; undermined by serial per-agent triggering (`registerSocketServer.ts:415-438`), full-table loads per send, O(total-history) librarian reindex every 10 msgs, full-table SUM per completion. |
| Observability | 2/10 | `perfMetrics` computed then flushed to console only; no OTel; 14+ dead event types; correlation envelope (`eventId`) stripped at socket boundary; no runId anywhere. |
| Security | 2/10 | API open by default when `AUTH_TOKEN` unset (the actual `.env` state); unauthenticated sockets join any room; `find -exec` / npm-script RCE through the bash ALLOW list; coding agents operate on the CrowdOS repo itself; plaintext API keys at rest; no approval flow anywhere. |
| Developer UX | 5/10 | Real Discord-style workspace UI that works against the server; excellent mobile/a11y; mode switching mid-conversation works; missing cancel button, edit/regenerate, diffs, pagination. |
| Multi-Agent Readiness | 2/10 | Swarm/conspiracy/murder vocabulary only; spawn events have mismatched payloads (client renders garbage rows); pair channels deleted post-run destroying audit trail; `swarm:*` events never emitted. |
| Production Readiness | 2/10 | No CI, no Dockerfile, no migrations (drift already shipped a broken path), test suite gitignored, Playwright entry point finds 0 specs, e2e "tests" have zero assertions. |

**Strongest architectural decisions**
1. Domain-facade ("Gate") discipline enforced by a linter — rare and valuable; blast radius of internal refactors stays inside folders.
2. Stateless runtimes + rebuild-from-DB context each turn → runtime switching (Chat→Agentic→Coding) preserves context for free (`[Observed]` VisibilityMatrix rebuild).
3. Typed `BrokerEventMap` + dual-write durable event log with cursor replay endpoints — the right skeleton for an event-sourced runtime.
4. Provider adapter seam (`IProviderAdapter` ×5) with real SSE usage parsing — clean model-agnostic base.
5. pi-core as an embeddable session/loop kernel with compaction hooks.

**Largest weaknesses**
1. The product's reason to exist — hierarchical swarm orchestration — is fake beyond a single LLM call plus mocked spawn choreography.
2. No durable execution identity: there is no `runs` table; a crashed process loses every in-flight task; nothing can resume.
3. Security posture would not survive exposure: open-by-default auth + bash escape hatches + agents editing the host repo.
4. Event/prompt surface ships substantial dead or contradictory weight (14+ never-emitted events, phantom client handlers, triple-duplicated safety rules).

**Biggest hidden risks**
1. **Bootstrap DDL ≠ schema.ts** — a DB created by the documented `db:push` path lacks `durable_events`; every event-log write then fails silently (caught+logged only) → you lose the durability feature without noticing (`bootstrap.ts` vs `schema.ts:829`).
2. **Second-order prompt injection** — channel content → reflection memory notes → re-injected into future prompts unescaped, bypassing context trimming (`AgenticRuntime.ts:84-94`, `memoryRetrieval.ts:105-113`).
3. **Silent-skip tests** convert missing seed data into passing suites; the architectural-conformance test literally cannot fail (broken regex `runtimeLifecycle.test.ts:689`).
4. Librarian substitutes **fabricated summaries** on API failure, presented identically to real ones (`librarianRuntime.ts:198-205`).
5. Two contradictory sources of truth (board all-done vs master-checklist all-not-started) plus gitignored docs/tests mean fresh clones inherit the aspirational README and none of the corrective context.

**Highest-value improvements (ranked)**
1. Introduce a first-class `runs` entity + wire LoopArbiter + cancellation propagation (correctness backbone).
2. Close the security holes (real auth, workspace chroot fix, env scrubbing, remove repo-root coding sandbox).
3. Make Swarm real *or* remove it from the router until it is (honesty > vaporware).
4. Parallelize multi-agent triggering + bound hot-path queries (biggest latency wins, low risk).
5. Turn the event bus into the contract: emit run-lifecycle events, stop stripping correlation IDs, delete dead events.

---

## B. Runtime Matrix

| Runtime | Exists | Quality | Main Strength | Main Defect | Priority |
| --- | --- | --- | --- | --- | --- |
| **Chat** (Conversational) | Yes | 6/10 | Single-call low-latency path, streamed+persisted, monologue capture; tools correctly disabled | No escalation path to deeper runtimes without user re-send; monologue discarded if channel switched mid-stream | P2 polish |
| **Agentic** | Yes | 6/10 | Real ReAct loop (maxIterations=10), parallel-safe tool batching, per-iteration persistence, abort checkpoints | No loop detection wired (LoopArbiter exists, never called by this runtime); budget cap is per-run not per-iteration (~20k token overshoot possible) | **P1** |
| **Coding** | Yes | 6/10 | Full delegation to pi-core AgentSession: read/edit/write/bash, unified diffs from edit, compaction hook | **Bypasses ToolExecutor authz entirely**; operates on `process.cwd()` = the CrowdOS repo itself; abort signal never reaches pi-core loop; session rebuilt per-run (no continuity) | **P0** |
| **Research** | Alias | 3/10 | Inherits all Agentic behavior; librarian special-case routes to it | It *is* AgenticRuntime (`research: agenticInstance`); no source discovery/ranking/citation/dedup primitives; web_search tool is a canned mock | P1 (decide: build or rename) |
| **Swarm** | Stub | 1/10 | Cancellation checkpoint + status flips correct | One LLM call with extra prompt text describing delegation it cannot perform; de-facto engine (AgentSpawnManager) is fully simulated; `swarm:*` events never emitted; spawned artifacts leak on crash | **P0 decision** |
| **Other** — orchestrator/observer types | Declared, unregistered | 0/10 | Fall back to agentic with warning (`RuntimeExecutor.ts:58-62`) | Dead taxonomy | P3 |

---

## C. Complete Architecture Diagram

```text
                            EXISTING (solid)          RECOMMENDED (dashed)
┌───────────────────────────────────────────────────────────────────────────┐
│ Client UX  packages/client (REAL) · target-frontend (DEAD localStorage    │
│ mock — quarantine/delete)                                                 │
│  zustand god-store (2,288 ln) ── socket.io-client singleton               │
│  ❌ no cancel button ❌ no channel:join/replay consumption                 │
│  ✅ streams/tool cards/mobile ✅ file explorer + code viewer               │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ HTTP /api/* (Fastify, zod)      Socket.IO (rooms: channel/workspace)
                │ ⚠ auth = shared static token,   ⚠ NO auth; identity = client-
                │   open by default                  asserted userId; auto-joins
                ▼                                    workspace:default (leak vector)
┌───────────────────────────────────────────────────────────────────────────┐
│ Routes layer  ⚠ 6 route files bypass gates w/ direct getDb()              │
│  ⚠ no rate limiting anywhere   ❌ requireWorkspaceAccess = TODO stub       │
├───────────────────────────────────────────────────────────────────────────┤
│ Session/Channel lookup  (channels, categories tables; seq numbers ⚠race)  │
├───────────────────────────────────────────────────────────────────────────┤
│ Runtime Router  explicit composer mode → librarian special-case →         │
│  channel tags → authority-level fallback   [no intent classification]     │
├───────────────────────────────────────────────────────────────────────────┤
│ RuntimeExecutor → ContextAssembler → ContextPipelineManager               │
│  10 middlewares (≤70 parallel, tail serial) ✅ PIPELINE_PARALLEL          │
│  IdentityAuthority·ChannelAwareness·InstructionStack·SkillContext·        │
│  ToolSchema·ConstraintSafety·MemoryRetrieval·VisibilityMatrix·            │
│  HistoryCompression·ContextLimit(8000 tok cap, assembly-time only ⚠)      │
├───────────────────────────────────────────────────────────────────────────┤
│ Runtimes: Conversational ✅ · Agentic ✅ · Coding→pi-core ✅ ·             │
│           Research (=agentic) ⚠ · Swarm (stub) ❌                         │
│      │                                    │                               │
│      ▼                                    ▼                               │
│ RuntimeKernel (50ms stream batching,   PiEventBridge/PiToolBridge         │
│  persist-per-iteration, retry-on-seq)  ⚠ bypasses ToolExecutor authz      │
│      │                                    ⚠ cwd() sandbox                 │
│      ▼                                                                    │
│ Model layer: ProviderRegistry → Google/OpenAI/Anthropic/Ollama/Custom     │
│  ✅ SSE + real usage parsing   ❌ no timeouts   ❌ no retries              │
│  ⚠ modelRouter.ts misnamed (Gemma helpers, no routing); model = static    │
│    per-agent module; no cheap-task routing                                │
├───────────────────────────────────────────────────────────────────────────┤
│ Tools: ToolRegistry (16 native, 4 mock/fake ⚠) → ToolExecutor             │
│  chain: skill whitelist → authority level → Guard(bash-only)              │
│  ⚠ ASK hard-denied (no approval flow) ❌ timeout doesn't kill children    │
│  MCP: stdio-only manager ✅ hardened spawn ⚠ force-labels tools safe      │
├───────────────────────────────────────────────────────────────────────────┤
│ State: PostgreSQL 36 tables (Drizzle) ⚠ migrations dir empty; DDL drift   │
│  ❌ NO runs/tasks entity · messages conflate conversation+execution       │
│  ✅ durable_events(bigserial) + afterSeq replay endpoints (client unused) │
│  VFS: LocalVFS disk+DB metadata ⚠ non-transactional sync                  │
│  ❌ Redis/BullMQ: CLAIMED IN README, DOES NOT EXIST                       │
├───────────────────────────────────────────────────────────────────────────┤
│ Events: EventBroker (in-proc EventEmitter + 50-ring/channel)              │
│  ✅ typed map ✅ dual-write durable   ⚠ envelope stripped at socket        │
│  ❌ 14+ dead event types ❌ swarm:/approval:/run:* absent                 │
│ Telemetry: console '[perf]' logs only ❌ perfMetrics has no endpoint      │
├───────────────────────────────────────────────────────────────────────────┤
│ Background (in-process timers): heartbeat toucher/orphan sweeper ✅ ·     │
│  librarian reindex ⚠quadratic · snapshot broadcast 15s · retention 24h    │
│  ❌ scheduled_tasks table has NO consumer                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## D. Lifecycle State Machine

### Current (as-implemented)

```text
Agent status enum (schema.ts:23-26):        idle ⇄ working ⇄ paused · offline
Run result (one-shot, runtime/types.ts:87): completed | failed | loop_detected |
                                            budget_exceeded | cancelled
Spawn request (task.types.ts:2):            pending → in_progress → completed|failed
Workspace (schema.ts:34):                   CREATED INITIALIZING ACTIVE PAUSED
                                            TERMINATED ARCHIVED
```

Transitions are ad-hoc string writes scattered across ≥6 files (`AgenticRuntime.ts:43,245`, `agentErrors.ts:67-82`, `agentHeartbeat.ts:68-72`, `agentService.ts:204`). **No transition guard exists.** The orphan sweeper maps crash → `paused` + `errorInfo.code="ORPHANED"`. That is the entire recovery story.

### Ideal-vs-actual gap

| Ideal state | Exists? | Notes |
| --- | --- | --- |
| CREATED / QUEUED / STARTING | **No** | Runs begin synchronously inside the socket handler |
| RUNNING | ≈ `working` | |
| WAITING_FOR_TOOL | **No** | Tool await is opaque inside the loop |
| WAITING_FOR_APPROVAL | **No** | No approval flow exists at all |
| PAUSED | Yes | Sweeper + REST |
| RETRYING | **No** | Retry exists only as spawn-loop counter |
| COMPACTING | **No** | Compression synchronous inline; pi-core compaction is lossy truncation masquerading as summarization (`compaction.ts:46-55`) |
| CANCELLING | **No** | Abort instantaneous; cancel emits only `agent:status idle` |
| COMPLETING / VERIFYING | **No** | No verification stage concept |
| TIMED_OUT | **No** | Tool timeouts surface as generic failure |
| ORPHANED | Partial | An error code under `paused` |
| RESUMABLE | **No** | Nothing to resume from |

### Recommended target machine

```text
RUN:    CREATED → QUEUED → STARTING → RUNNING ⇄ WAITING_FOR_TOOL
        RUNNING ⇄ WAITING_FOR_APPROVAL → RUNNING
        RUNNING → RETRYING → RUNNING (bounded, backoff)
        RUNNING → COMPACTING → RUNNING
        any → CANCELLING → CANCELLED
        RUNNING → COMPLETING → VERIFYING → COMPLETED | FAILED
        RUNNING -(heartbeat miss)-► ORPHANED → RESUMABLE → RUNNING | FAILED
Rules:  transitions validated by a single state-machine module; every transition
        emits run.status_changed{from,to,reason} to the durable log; terminal
        states are immutable; RESUMABLE requires a persisted checkpoint record.
```

---

## E. Pipeline Bottleneck Report

| # | Problem | Evidence | Root cause | Impact | Fix | Est. improvement | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Serial multi-agent execution on role mentions (`for…await` per matched agent) | registerSocketServer.ts:415-438 | Sequential dispatch loop | N agents = N× wall-clock (each run is minutes) | Parallelize with existing per-`channelId:agentId` controllers | N× → 1× wall-clock | Low |
| 2 | Unbounded hot-path reads: ALL memory notes per retrieval; 60-msg history + 30-msg roster fetched separately per assembly | memoryRetrieval.ts:41-47; VisibilityMatrixMiddleware.ts:38-42; ChannelAwarenessMiddleware.ts:40-44 | Missing LIMIT/recency windows; duplicated fetches | Latency grows with channel age & vault size; O(n) DB rows per message | Share one fetch; SQL-side scoring/LIMIT | Removes largest non-model latency term | Low |
| 3 | Librarian summarizes ENTIRE channel every 10 new msgs | indexBuilder.ts:59-83; librarianRuntime.ts:146-176 | No delta indexing | Quadratic cumulative token spend per channel | Summarize delta since last indexed seq | ~90%+ token reduction at scale | Low |
| 4 | TokenTracker full-table SUM per completion + 80%-warning spam | tokenTracker.ts:60-110 | No running counter; warning not edge-triggered | O(n) query forever; budget rows themselves consume budget | Cached rollup counter; one-shot threshold crossing | Constant-time accounting | Low |
| 5 | GET messages loads entire channel, no pagination; CPU regex merge | messageService.ts:8-105 | No keyset pagination | Slow channel opens; unbounded memory/localStorage client-side | Keyset pagination + virtualized list | Flat open time | Low-Med (API change) |
| 6 | Per-message full agents-table scans ×2 + rebuilt regexes | mentionParser.ts:43; registerSocketServer.ts:376 | No roster cache (unlike skills/model caches) | Wasted queries per send | 30s TTL roster cache | Minor but free | Low |
| 7 | Snapshot broadcast every 15s does 4 full-table queries | registerSocketServer.ts:82-87,246-250 | Polling-style presence | Constant churn | Event-driven deltas | Low | Low |
| 8 | Memory-preview block re-sent every agentic iteration; triple-duplicated safety rules (~350 tok/run) | RuntimeKernel.ts:337-340; Identity/ChannelAwareness/ConstraintSafety middlewares | Packet baked once; copy-pasted rule text | Up to 10× duplication per run | Inject once; canonicalize rules | ~500-1500 tok/run saved | Low |
| 9 | ContextLimit cap applied at assembly only; iterations append up to ~20k tokens past cap | ContextLimitMiddleware.ts:21-65; AgenticRuntime.ts:52,64-67 | No re-check per iteration | Cost + quality degradation on long loops | Per-iteration trim or pre-flight recount | Bounded worst case | Low |
| 10 | Pi bridge streams unbatched (per-delta emit vs kernel 50ms batching) | PiEventBridge.ts:43-56 vs RuntimeKernel.ts:23-26 | Two divergent streaming paths | Event volume spike during coding runs | Route Pi deltas through streamChunk coalescer | ~50× fewer socket writes | Low |

Latency budget note: the only instrumented stages are `llm.call` and persistence via console logs; `perfMetrics` p50–p99 series exist for context-assembly and tool-exec but are **never exposed** (console flush only, `perfMetrics.ts:82-91`). First deliverable of Phase 0 should be a `/metrics` endpoint so this table can carry measured p50/p95.

---

## F. Agent Architecture Report

**Current hierarchy (verified):**

```text
User ─@mention→ MentionParser (Levenshtein ≤2, role aliases @L0-@L3)
  → fallback: category owner → L0s → default-assistant (registerSocketServer.ts:443-478)
  → RuntimeRouter picks runtime BY AUTHORITY LEVEL (L≤1 agentic, L2 swarm, else chat)
  → AgentSpawnManager.dispatch_agent tool (authLevelRequired=2):
       spawn_requests row → batches of ≤5 L3 worker/supervisor pairs
       in private pair channels → SIMULATED work (setTimeout + template strings)
       → keyword verdict → retry ≤maxRetries or escalate → HARD-DELETE pair
         channels/agents/taskFiles (destroys audit trail)
```

- **Delegation reality:** recursion implicitly blocked (spawned pairs lack permissions/toolkits and sit below the L2 gate) but with **no explicit depth counter or cycle detection** `[Risk]`. Results return as full JSON copies into the parent's tool result — no summarization boundary.
- **Permissions:** flat per-agent JSON; `permissions.spawnAgents` has **zero consumers** — spawn authorization rests solely on one integer check (`ToolExecutor.ts:56-60`). Level-based permission inheritance: none. Species (Raven/Crow): decorative string.
- **Concurrency:** multiple agents run concurrently across sockets but serially within one mention batch; duplicate-run protection absent — second trigger **overwrites the first run's AbortController**, orphaning it from cancellation (`registerSocketServer.ts:41-50`).
- **Failure isolation:** sibling isolation via `Promise.allSettled` in spawn batches is sound; EscalationChain pause-and-handoff pattern is good — but escalation "responses" are canned setTimeout strings, never a real takeover.
- **Context boundaries:** structurally isolated (pair_private channels, visibility matrix) — and moot while work is simulated.

**Recommended target architecture:**

```text
Primary Agent (owns conversation, user-facing)
   → Planner step (cheap model, structured plan artifact)
   → Specialized Subagents (isolated contexts, focused tool grants, own budgets)
   → Tools via ONE gateway (ToolExecutor — no bypass lanes)
   → Verifier (independent reviewer pass before COMPLETE)
Contracts: parent receives summarized result + pointer to artifact;
           every delegation writes a delegations row + delegation:start event;
           depth limit (default 2) + visited-set cycle detection enforced centrally.
```

This matches the platform's existing Lv semantics instead of fighting them, and turns the already-present SpawnManager scaffolding into the real thing rather than a rewrite.

---

## G. UX Gap Analysis

Verified frontend = `packages/client` (works against server). `target-frontend/` = exported AI-Studio mock with setTimeout agents and zero socket code — quarantine or delete.

| Capability | Current | Target primitive | Gap | Priority |
| --- | --- | --- | --- | --- |
| Stop/cancel a run | Server implements `user:cancel`; **client never emits it** (store's only emit is `user:message`) | Stop button on streaming bubble | Trivial add; contract already live server-side | **P0** |
| Approval interrupts | None; Guard ASK→DENY throws | Permission card w/ allow-once/always/deny | End-to-end missing (server+event+UI) | **P0** |
| Background tasks (close & return) | Run survives browser close ✓; missed events lost; client ignores replay APIs (`channel:join`, `/api/events/recent`) | Missed-events digest + reconnect resume | Wire client to existing replay; keep stream-final signal | **P0** |
| Live multi-agent progress | Presence dots + folded tool cards; delegation cards render **only from seed data** (server never emits the type); spawn event payload mismatch injects garbage rows | Spawn tree / run timeline | Fix payload contract + emit delegation events | **P1** |
| Diff review | Whole-file editor, save overwrites | Side-by-side diff + accept/reject (edit.ts already produces unified diffs!) | Surface existing diff data | **P1** |
| Edit/regenerate/retry message | Absent | Hover actions | New feature | P1 |
| Completion notifications | Same-tab unread badges only; mute map lost on refresh | Browser notification on run completion | Notifications API | P1 |
| History management | Full fetch per switch, unbounded localStorage mirror | Cursor pagination + virtualization | API change | P2 |
| Search | ⌘K searches in-memory store only | Server-side search (channel_index exists!) | Wire endpoint | P2 |
| Fork/branch sessions | Absent both sides | Fork-from-message | Needs runs/messages separation first | P2 |
| Runtime transparency | Mode pinning works; no indication which runtime served past replies | Per-reply runtime badge | Cheap metadata display | P3 |
| Mobile/a11y | **Genuinely strong** (drawers, safe-area, aria, 44px targets) | — | Keep as benchmark | — |

Code health: 39 `: any` in store; every socket handler `(payload:any)`; client re-implements server ReAct parsing by scraping `<call_tool>` XML from streams (dup of `ReActStreamParser`); seeded fake agents render whenever backend is down ("local simulation mode") masking outages; hardcoded author `"Juan Hamzah"`.

---

## H. Backend Optimization Plan

### Quick wins (days, minimal disruption)
1. **Parallelize mention-triggered runs** (registerSocketServer.ts:415-497) — biggest wall-clock win.
2. **Bound memory retrieval** (`ORDER BY … LIMIT`, recency window) and share the history fetch between roster/visibility middlewares.
3. **Add `/metrics` endpoint** exposing existing `getMetricsSnapshot()`; log JSON not prose.
4. **Edge-trigger the 80% budget warning**; replace full-SUM with cached counter.
5. **Librarian delta indexing** since last indexed sequence.
6. **Canonicalize the triplicated safety rule**; drop memory preview after iteration 1.
7. **Fix `agent:spawned` payload** to match client (or vice versa) — stops garbage roster rows.
8. **Emit cancel button**: client `user:cancel` + stop button (server ready today).
9. Add missing indexes: `messages(channel_id,timestamp DESC)`, `token_usage_log(ts)`, `agent_memory_notes(agent_id,lifecycle_status,note_timestamp DESC)`; durable_events already indexed.
10. Delete dead surface: PromptFormatter/MemoryBuilder (~590 lines), unused ring-buffer APIs, phantom handlers, `core/LoopArbiter` alias.

### Medium-term (weeks)
1. **Runs entity + run-lifecycle events** (new `runs` table; `run.*` events through broker; status machine module). Everything else hangs off this.
2. **AuthN/AuthZ**: fastify-jwt, socket handshake verification, room-scoped joins, workspace-membership checks; rate limiting (HTTP + `tools/execute-test`).
3. **Provider call hardening**: per-request timeouts, typed error codes, retry w/ backoff for idempotent calls; propagate AbortSignal into CodingRuntime.prompt and PiToolBridge custom tools.
4. **One tool gateway**: PiToolBridge coding tools go through ToolExecutor authz (or inherit agent grants); kill the `process.cwd()` sandbox; env-scrubbed exec children; kill orphaned timeout processes via `execFile` + signal.
5. **Migrations**: adopt drizzle-kit versioned migrations; reconcile bootstrap DDL (missing `durable_events`!); CI job running `db:push` on clean Postgres.
6. **Client contract typing**: share `BrokerEventMap` payloads with client; delete client-side XML scraping; extract socket layer from god-store.
7. **Testing repair**: un-gitignore tests; fix vacuous gate-conformance test; seed-independent integration fixtures (or fail loudly); real Playwright specs; CI pipeline.

### Strategic (months)
1. **Durable execution**: queue-backed runs (Postgres SKIP LOCKED is sufficient initially — do NOT need Redis/BullMQ despite README), leases/heartbeats on runs, checkpoint records, resume-from-step, compensation notes for side effects.
2. **Real Swarm**: DAG/task-graph executor over the runs entity; worker leases; partial-failure aggregation; verifier stage; make Conspiracy/Murder real or retire the vocabulary.
3. **Research runtime**: source discovery/ranking/dedup/citation subagents with isolated contexts returning evidence bundles (web_search tool must become real first).
4. **Context service**: unified token accounting (incl. tool schemas), per-iteration budget enforcement, true summarizing compaction (pi-core marker currently lies), pgvector activation for semantic memory lanes.
5. **Observability**: OTel traces keyed by runId/agentId/toolCallId; event-bus-derived metrics; cost ledger per run.

---

## I. Priorities

### P0 — Critical (correctness/security/data loss/runaway)
1. Security closure package: real auth default-deny; socket identity verification; Guard path-prefix anchor fix (`startsWith(root+sep)`, Guard.ts:32); symlink resolution; `find -exec`/npm-script ALLOW-list removal or command-token validation; env-scrubbed exec; move coding sandbox out of repo root; encrypt or vault API keys.
2. Runs entity + durable run lifecycle (foundation for everything else).
3. Duplicate-run mutex + cancel-handle preservation (activeRuns overwrite bug).
4. Bootstrap/schema reconciliation (durable_events missing on documented setup path).
5. Stop deleting pair-channel audit trails; stop fabricated librarian summaries (fail visibly instead).

### P1 — High (latency/lifecycle/orchestration/UX majors)
Parallel agent dispatch; bounded context loads; approval flow (ASK becomes a real question); LoopArbiter wiring + per-iteration budget; provider timeouts/retries; cancel button + event contract fixes; delegation events + records; test-suite repair + CI.

### P2 — Medium
Pagination; server-side search; diff review UI; edit/regenerate; notifications; instruction-stack versioning; MCP tool danger-labeling policy; suppress-TTL enforcement + memory pruning job; pgvector semantic lanes.

### P3 — Optimization
Model routing economy (task-complexity-based cheap-model routing); OTel; speculative/incremental decoding patterns; fork/branching; omni-search server-side; store refactor; delete target-frontend.

---

## Top 10 Problems (severity-ranked)

1. **Simulated headline feature** — swarm/delegation/escalation outputs are hardcoded mocks presented as real (`agentSpawnManager.ts:385-443`, `agentErrors.ts:138-163`).
2. **Open-by-default security** — API open without `AUTH_TOKEN` (current `.env`), spoofable identity headers, unauthenticated sockets joining any room, zero rate limits.
3. **RCE-class tool escapes** — `find -exec` and npm-script pivots through bash ALLOW list; sibling-path prefix bug; symlink escape; coding agents editing the CrowdOS repo itself via `cwd()` sandbox.
4. **Non-durable execution** — no runs entity, no queue, no checkpoints; process death loses all in-flight work; restart = from scratch with half-applied file mutations unrecoverable.
5. **Migration drift** — empty migrations dir; hand-rolled DDL already diverged (fresh installs silently lose `durable_events` → durability feature dead on the documented path).
6. **Cancellation integrity bugs** — activeRuns overwrite strands live runs from cancellation; abort never reaches pi-core loop or bridged tools; timeout races leave orphan processes running.
7. **Conflated data model** — conversation ≠ execution ≠ events mixed in `messages`; tool structure recoverable only by parsing emoji-prefixed strings (`messageService.ts:22-65`).
8. **Dead/dishonest observability** — 14+ defined-never-emitted events, phantom client handlers (parliament/budget-warning), stripped correlation envelopes, metrics flushed to console, fabricated fallback telemetry in UI (`right-sidebar.tsx:22-53`).
9. **Test suite gives false confidence** — silent skips on missing seed data; gate-conformance test mathematically cannot fail; Playwright finds 0 specs; entire suite gitignored.
10. **Docs contradict code** — README claims Redis/BullMQ, Conspiracy/Murder, observability-first; board says 100% done while master checklist says 0%; contributors inherit false premises.

## Top 10 Opportunities (ROI-ranked)

1. Cancel button + `user:cancel` emission (server done; hours of work, headline UX win).
2. Parallel agent dispatch (one-line-ish change; N× latency win).
3. `/metrics` endpoint over existing perfMetrics (observability for free).
4. Delta-indexing librarian (~90% token reduction of background spend).
5. Unified diff already produced by `pi-core/edit.ts` → ship diff-review UI nearly free.
6. Runs table + run events unlock resume, timelines, debugging, cost attribution incrementally.
7. Client adoption of the existing replay endpoints → background-task continuity without new backend.
8. Shared event-payload types between server/client → kills whole class of payload-mismatch bugs.
9. OpenAI-compatible adapter base class (Ollama/Custom/OpenAI are ~80% duplicates).
10. pgvector is installed and idle — activate semantic memory lanes already stubbed in comments.

## Top 10 UX Improvements (user impact)

1. Stop button on streaming replies.
2. Approval cards for risky actions (unblocks ASK tier).
3. Missed-activity digest on return (replay wiring).
4. Diff review before save in code viewer.
5. Edit/regenerate/retry on messages.
6. Delegation timeline rendering live (fix payload, emit events).
7. Browser notifications on long-run completion.
8. Per-reply runtime badge (which mode answered).
9. Paginated, virtualized history (channels stay fast forever).
10. Honest telemetry panels (kill `length*1.5` fake token math and 42000 baselines).

## Top 10 Backend Improvements (latency/scale/cost/reliability)

1. Runs entity + state machine + durable run events.
2. Parallel dispatch + bounded hot-path queries.
3. Provider timeouts/retries/typed errors + abort propagation everywhere.
4. Per-iteration context budget enforcement.
5. Transactional multi-write paths + atomic sequences on socket path.
6. Versioned migrations reconciled with schema.
7. Single tool gateway (close PiToolBridge bypass), env-scrubbed exec, killed timeout children.
8. Token accounting rollup (constant-time budget checks).
9. Queue-backed background execution (Postgres SKIP LOCKED) enabling restart survival.
10. Metrics endpoint + OTel-ready correlation IDs preserved on the wire.

---

## Target Runtime Model

```text
                    ┌────────────────────────────┐
                    │ Runtime Router             │
                    │ explicit → intent classify │
                    │  (cheap model) → channel   │
                    │  policy → authority rules  │
                    └──────────┬─────────────────┘
       ┌───────────┬───────────┼─────────────┬──────────────┐
       ▼           ▼           ▼             ▼              ▼
   Chat        Agentic      Coding        Research       Swarm
 (fast model, (loop+tools, (pi-core      (isolated      (supervisor+
  no tools)    mid model)   sandboxed     research       workers over
               budget/iter  FS tools via  subagents,     DAG of RUNS,
               loop arbiter ToolExecutor, citations)      aggregator,
               checkpoint)  diffs)                       verifier)
       └───────────┴───────────┴─────────────┴──────────────┘
                     all runtimes share:
        ONE runs/state machine · ONE tool gateway · ONE event log
        context inherited from channel unless subagent-isolated
```

Key relations: Chat escalates to Agentic **in-place** (same channel, same context — already free due to stateless rebuild); Coding is Agentic + sandboxed FS tools + diff/verify stage; Research is Agentic with isolated high-volume subagents returning evidence bundles; Swarm executes a graph of child RUNS with leases and aggregation. All five are configurations of one Execution Engine, not five codepaths.

## Target Agent Model

```text
User intent
 → Primary Agent (conversation owner, user-visible)
    → Planner (structured plan artifact, cheap model)
    → Specialized Subagents (isolated ctx, focused tools, own budgets,
                             summarized results back, depth ≤2, cycle-safe)
    → Tool Gateway (single authz chokepoint, ALLOW/ASK/DENY)
    → Verifier (independent check before COMPLETE; reviewer ≠ author)
 Contracts: delegation rows + events; artifact pointers not raw dumps;
            parent cancellation propagates; sibling failure isolates.
```

## Target Lifecycle Model

See §D recommended machine. Non-negotiables: every run has an ID; every transition is emitted + persisted; terminal states immutable; RESUMABLE backed by checkpoints; heartbeats lease runs (not just agent rows); disconnect never cancels (explicit product rule, already honored); crash → ORPHANED → auto-RESUMABLE within one sweep interval.

## Target Event Model

Keep `domain:pastTenseVerb` naming; delete the duplicate `shared/events/runtime-events.ts` const; add:

```text
run.created run.started run.status_changed run.completed run.failed run.cancelled
run.checkpoint_created
agent.delegation_started agent.delegation_completed
tool.requested tool.approved tool.denied
approval.requested approval.granted approval.denied
artifact.created artifact.updated diff.created
compaction.performed budget.threshold_crossed
```

Wire rules: envelope `{eventId, seq, timestamp, runId, agentId, channelId}` survives to clients; ephemeral allowlist shrinks to stream chunks; every event has ≥1 emitter and ≤1 owning emitter module; consumer contracts generated from the shared type map.

## Target Permission Model

```text
Decision: DENY > ASK > ALLOW, evaluated at ONE gateway per action class.
Scope ladder (most specific wins): global → workspace → channel → agent →
                                  subagent(inherits, can only narrow) → tool →
                                  command/path/domain
Classes: read-workspace ALLOW · write-workspace ALLOW(or project ASK) ·
         execute-tests ALLOW · install-deps ASK · network ASK(domain allowlist) ·
         secrets CRITICAL(deny by default) · destructive/git-push/deploy/db-write
         HIGH→CRITICAL explicit approval · approvals: scope=reusable, audited,
         expire; ASK pauses run (WAITING_FOR_APPROVAL) with timeout default-deny.
Enforcement points: ToolExecutor (native+MCP+PiBridge — no bypass lanes),
                    LocalVFS (path+secrets guard moved here),
                    exec children (env scrub, process-group kill).
```

---

## Migration Roadmap

**Phase 0 — Instrument (1 wk)**
Objectives: see the system truthfully. Changes: `/metrics` endpoint; structured JSON logs; preserve event envelopes on wire; add `runs` table (write-only at first); CI skeleton (typecheck+lint+gates+vitest on Postgres service); un-gitignore tests/docs; delete junk artifacts. Deps: none. Risks: near-zero. Validation: dashboards show p50/p95 per stage; CI green on clean machine. Rollback: revert commit.

**Phase 1 — Stabilize (2-3 wks)**
Objectives: stop losing/corrupting work. Changes: security closure package (§I P0-1); duplicate-run mutex; abort propagation (CodingRuntime/PiToolBridge); provider timeouts/retries; transactional writes + atomic sequences; migration reconciliation; cancel button; stop audit-trail deletion; honest librarian failures. Deps: Phase 0 CI. Risks: auth may break dev flows — ship token-in-.env.example + dev bypass flag. Validation: failure-mode matrix from Goal.md §25 exercised in tests; unauthorized requests 401; kill-server mid-run leaves consistent state. Rollback: feature flags on auth strictness.

**Phase 2 — Optimize (2 wks)**
Changes: parallel dispatch; bounded queries; per-iteration budgets; token rollup; delta librarian; dedupe prompts; indexes; batched Pi streaming. Validation: latency budget table gains measured p50/p95; token-per-run drops measurable via token_usage_log. Rollback: flags (`PIPELINE_PARALLEL` pattern exists).

**Phase 3 — Unify Runtime (3-4 wks)**
Changes: runs state machine enforced; run.* events; resume-from-checkpoint for tool-boundary interruptions; queue-backed execution (Postgres SKIP LOCKED); disconnect semantics documented + tested. Deps: runs entity. Risks: highest-complexity phase; keep old direct-execute path behind flag until parity proven. Validation: start→kill→resume test green; no zombie runs after SIGKILL; replay reconstructs any run. Rollback: flag off returns to synchronous path.

**Phase 4 — Agent Orchestration (3-4 wks)**
Changes: real delegation (delegations table, depth/cycle guards, summarized returns); replace SpawnManager mocks with real subagent runs over the Phase-3 engine; verifier stage; LoopArbiter wired + persisted windows; SwarmRuntime v1 = small DAG executor (linear chains first, fan-out second). Validation: delegation e2e with real model mocks; chaos test: kill worker mid-batch → aggregation reports partial honestly. Rollback: router pins L2 to agentic.

**Phase 5 — Upgrade UX (3 wks)**
Changes: approval flow end-to-end (WAITING_FOR_APPROVAL + cards + audit); diff review; edit/regenerate; notifications; delegation timeline; runtime badges; pagination + server search; typed client event contracts; store decomposition. Validation: Playwright specs for each journey; payload-mismatch bug class eliminated by shared types. Rollback: incremental component flags.

**Phase 6 — Scale Swarm/Background (ongoing)**
Changes: DAG parallelism + leases + idempotency keys; Research runtime with real search providers + citation/evidence store; pgvector semantic memory; cost-aware model routing; OTel export; optional Redis/BullMQ swap-in if Postgres queue saturates (only then). Validation: load tests (concurrent swarms); cost dashboard shows routing effect. Rollback: per-feature flags; queue interface allows provider swap.

---

## Closing Assessment

CrowdOS's skeleton is better than its flesh: the gate discipline, the middleware context pipeline, the typed broker with durable replay, and the provider seam are foundations most prototypes lack. But the system currently **performs** multi-agent operation rather than performing it: the swarm is a puppet show, execution evaporates on crash, the security model would not survive first contact with a hostile network, and roughly a third of the declared surface (events, tools, runtimes, docs) is decorative. The fastest path to the Goal.md definition of success is not a rewrite — it is Phase 0–1 honesty work (instrumentation, durability, security), then letting the already-correct abstractions (runs, one tool gateway, one event log) absorb the fake parts and replace them.

**Definition-of-success checklist (Goal.md §36):** durable ✗ · observable ✗(partial) · cancellable ◑ · resumable ✗ · parallel ◑ · permission-aware ✗ · cost-aware ◑ · model-agnostic ✓ · runtime-agnostic ◑ · extensible ✓ · secure ✗ · fast ◑ · developer-friendly ◑.

*Report generated from 11 parallel audit passes with file:line evidence retained above; spot-verifications performed directly against source on 2026-08-26.*

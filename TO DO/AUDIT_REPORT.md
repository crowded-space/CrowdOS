# AI Runtime, Agent Pipeline, Backend, Lifecycle & UX — Comprehensive Audit
**Project:** ThisCrowd / CrowdOS — `crowdos@0.1.0`  
**Date:** 2026-08-25  
**Auditor:** Principal AI Systems Architect + Runtime/Backend/UX Review  
**Scope:** `Goal.md` full lifecycle (sections 1-36) — evidence-grounded, no assumptions  
**Method:** Traced execution `User→UI→Session→Router→Runtime→Orchestrator→Model→Tools→Subagents→State→Events→Persistence→Resume`, inspected code, DB schema, streaming, failures.

> Tag taxonomy used throughout: **Observed** = verified from code/runtime, **Inferred** = strongly implied, **Missing** = no impl, **Broken** = impl incorrect/incomplete, **Risk** = works but creates reliability/security/cost risk, **Opportunity** = optimization.

---

## A. Executive Verdict

### Maturity Scores (0 = absent, 10 = production-grade comparable to Codex / Claude Code / Cursor / OpenCode)

| Dimension | Score | 1-line justification |
|---|---:|---|
| **Architecture Maturity** | **4 / 10** | Gate facade disciplined, but monolith single-process Fastify, no queue/worker separation, dual context builders |
| **Runtime Maturity** | **4 / 10** | Chat+Agentic+Coding real, Research is alias, Swarm is stub — 3/5 conceptual runtimes missing genuine implementation |
| **Agent Orchestration** | **3 / 10** | Authority hierarchy defined, but no DAG/lease/heartbeat, delegation only via mock `AgentSpawnManager`, no recursive limits |
| **Backend Reliability** | **3 / 10** | No queue, no durability, browser disconnect not survivable, zombie `working` states, `Promise.race` leak |
| **Performance** | **4 / 10** | Serial context pipeline (6-9 DB round-trips ≈250 ms), serial tool execution, naive `ceil(len/4)` tokenization, no caching |
| **Observability** | **3 / 10** | Structured Fastify logs + `x-correlation-id` only; no OTel, no metrics, per-stage latency/cost not reconstructable |
| **Security** | **2 / 10** | **No auth on any route/socket**, `origin:true`, API keys plaintext in DB and emitted via `/api/studio/*`, `exec` blacklist bypassable |
| **Developer UX** | **4 / 10** | 3-panel shell works, file viewer exists; no diff/terminal/test/commit/branch, no agent supervision, no cancellation |
| **Multi-Agent Readiness** | **2 / 10** | No durable swarm, no message passing, `Promise.all(batch 5)` simulation on hardcoded `c:/Users/...` path |
| **Production Readiness** | **2 / 10** | Fails P0: loses work on restart, no rate limit/quotas, no graceful shutdown, `.env` mutation via HTTP |

**Overall production readiness: NOT READY — requires Stabilize→Optimize→Unify phases before external users.**

### Strongest Architectural Decisions (Observed)
1. **Domain Facade (Gate) standard** — `packages/server/src/Agents/agentGate.ts:1-56`, `runtime/runtimeGate.ts:1-125`, `vfs/vfsGate.ts:1-15` etc. Thin facades, internal imports free, cross-domain only via `*Gate.ts`. Lintable with `eslint-plugin-boundaries`. — Keeps blast radius at folder boundary.
2. **Context Pipeline as ordered middleware chain** — `packages/server/src/runtime/kernel/ContextPipelineManager.ts:29-42` 10 stages with priority sort `51-53`, each focused (Identity→Channel→Instruction→Skill→Tool→Constraint→Memory→Visibility→Limit→Compression). — Clean separation, easy to extend/reorder.
3. **VisibilityMatrix + MemoryRetrieval isolation** — `.../VisibilityMatrixMiddleware.ts:46-98` enforces `memorySharingPolicy full/horizontal/vertical/none + lock_in` via bracket tags; `MemoryRetrievalMiddleware.ts:12-22` `retrieveMemoryCandidates` multi-lane scoring `recent_episodic/high_importance/mentions/unresolved_tensions` (`.../Memories/memoryRetrieval.ts:74-93`). — Correct primitive for multi-agent context contamination control.
4. **ProviderAdapter abstraction** — `.../runtime/providers/ProviderRegistry.ts:3-27` + 5 adapters (`GoogleAdapter.ts:20-282`, `AnthropicAdapter.ts:1-219`, `OpenAIAdapter.ts`, `OllamaAdapter.ts`, `CustomAdapter.ts`) with SSE streaming `TextDecoder` loops. — Model-agnostic, supports streaming uniformly.
5. **pi-core CodingRuntime** — `.../runtimes/CodingRuntime.ts:27-149` wrapping `@crowdos/pi-core` `AgentSession` `pi-core/src/agent/agent-loop.ts:5-50` with `PiToolBridge.createCodingTools:15-178` (`read/edit/write/bash` with `Guard`) and `PiEventBridge.pipeToBroker:14-141` mapping deltas → `message:stream/tool:*`. — Most complete Understand→Modify→Run loop.

### Largest Weaknesses (Broken/Missing)
1. **Research and Swarm are not real runtimes** — `RuntimeExecutor.ts:35` `research: agenticInstance` alias; `SwarmRuntime.ts:15-23` mutates `packet.systemPrompt` then single `callLLM` — no delegation. Swarm's real logic `AgentSpawnManager.dispatchAgent:46-133` is a mock not wired to SwarmRuntime. — User sees “Swarm” but gets generic chat.
2. **No queue / worker / durability** — Socket handler `Shared/sockets/registerSocketServer.ts:227` `await runtimeGate.execute()` synchronously blocks; no `queue technology` (`Goal #14` all rows Missing). — Browser disconnect ≠ cancel, server restart = lost work, no retry/lease/DLQ/visibility timeout.
3. **No auth / trust enforcement** — `index.ts:47` `origin:true`, no `fastify-jwt`, all routes `human_operator` hard-coded `registerSocketServer.ts:193`, `vfs.ts:19`; `modelModules.apiKey` plaintext `db/schema.ts:51` emitted via `routes/studio.ts:32-37` `inspect-prompt:204`. — Critical P0.
4. **Broken lifecycle (7/22 states exist)** — Only `idle/working/pausing→paused, completed/failed` observed; `QUEUED/WAITING_FOR_TOOL|APPROVAL|DEPENDENCY/CANCELLING/CANCELLED/COMPACTING/TIMED_OUT/EXPIRED/ORPHANED/RESUMABLE` missing (`runtime/runtimes/*`, `db/schema.ts:112-123`). `runtimeStates.lastHeartbeat:121` never updated — zombie `working` forever on crash.
5. **Tool outputs & history contaminate context unbounded** — `AgenticRuntime.ts:152-169` pushes raw `result.output` as `role:tool` + DB `isInternalMonologue` every iteration; `ContextLimitMiddleware:90-104` `resolveCap` returns `null` unless `customOverrides` → no cap enforced (`agents` table has no `contextTokenCap` column). — Token blowup `O(n²)`.

### Biggest Hidden Risks
- **Silent `origin:true` + no auth** allows any site to mutate DB/workspaces/files via CORS + socket `user:message`. — `index.ts:47-48`, `registerSocketServer.ts:134-139`.
- **`.env` mutation via HTTP** `routes/workspace.ts:165-185` writes `DATABASE_URL` to disk with `fs.writeFile` and `process.env` hot-swap; no auth, no validation — config injection.
- **`execute_bash` blacklist bypass** `tools/safety/Guard.ts:49-61` only `includes("rm -rf")` (6 strings); `curl|bash`, `powershell`, `python -c`, `wget` pass. `ToolExecutor:63` uses blacklist, not whitelist (`execute_safe` whitelist is separate). `spawn` via `mcpClientManager.ts:77-81` `shell:true` inherits host env.
- **`EventBroker` in-memory only** `EventBroker/eventBroker.ts:19-39` capped 50 recent events, `io.emit` fans to all clients without rooms — restarts lose audit, cross-channel leakage, no ordering/sequence key, no replay.
- **`WORKSPACE_DIR` hardcoded Windows path** `Agents/agentSpawnManager.ts:21` `c:/Users/Asus/...` — Linux deploy fails, temp file `374` not under VFS sandbox.
- **`memoryUsedMb:42` hardcoded telemetry** `registerSocketServer.ts:107` `sandbox:updated` fake — operational blind.

### Highest-Value Improvements (ROI order)
1. **P0 Auth + secret redaction** (≈2 days, unblocks production) — add `fastify-jwt`/API key gate, deny `origin:true`, scrub `apiKey` from `studio.ts` responses, encrypt `modelModules.apiKey`.
2. **Durable job primitive + graceful shutdown** (≈1 week) — `jobs` table `FOR UPDATE SKIP LOCKED`, `AbortSignal` wired end-to-end `RuntimeKernel.callLLM` + `ToolExecutor`, `persistMessage` transaction.
3. **Fix Swarm/Research to be real** (≈1 week) — promote `AgentSpawnManager` to real `SwarmRuntime` with `DAG+lease+heartbeat`, split Research to isolated subagents with summarized return (`topK 10` already).
4. **Cache + parallel pipeline** (≈3 days, -50% TTFT) — dedup DB queries (`Promise.all` instruction/skill/constraint), LRU `modelModules`+`agentSkills`+`messages 30`, DataLoader.
5. **Observability** (≈3 days) — OTel spans `assemble/llm/tool/persist`, `durableEvents` table `seq bigserial`, `/api/runs/:id/events?afterSeq` replay.

---

## B. Runtime Matrix

| Runtime | Exists | Quality | Main Strength | Main Defect | Priority |
|---|---|---|---|---|---|
| **Chat (`conversational`)** | ✅ `ConversationalRuntime.ts:8-89` | 4/10 Functional but heavy | Real isolated tool-gate (`ToolSchemaMiddleware:19` `tools=[]`), streaming SSE | No low-latency optimization: 10 DB queries + sequential memory note DB write on hot path before response | P1 |
| **Agentic** | ✅ `AgenticRuntime.ts:12-207` ReAct loop 10 iter | 5/10 Most used | True multi-turn `localHistory` loop, per-tool `tool:start/complete` events | Serial tools, no loop detection (`LoopArbiter` exists `Shared/core/LoopArbiter.ts:8-58` but never called), no checkpoint | P1 |
| **Coding** | ✅ `CodingRuntime.ts:12-232` via `pi-core` AgentSession | 6/10 Best loop | Full Understand→Modify→Run via `PiToolBridge:15-178` + `PiEventBridge:34-62`, `executeBash` with `signal`, diff via `editFile` | No repo discovery/LSP/Git, history mapping collapses `toolCallId` fidelity `130-134`, `usage` zeroed `222` | P1 |
| **Research** | ⚠️ Alias `RuntimeExecutor.ts:35` `agenticInstance` | 1/10 Fake | Routes via tag `research` `RuntimeRouter:27-28` | Shares Agentic loop/tools/memory — contaminates main context with raw search output, no subagent isolation, no citation/verification | P2 |
| **Swarm** | ⚠️ Stub `SwarmRuntime.ts:8-58` single LLM | 1/10 Broken | Prompt mutation orchestration description | No DAG/queue/lease/heartbeat/worker pool; real `AgentSpawnManager:46-501` mock not wired, `WORKSPACE_DIR` hardcoded Windows `21` | P1 |
| **Other (`observer`/`orchestrator`)** | ❌ Type `types.ts:156-163` only | 0 | `allowSpawn/Delegation` flags `ContextAssembler:38` | `RuntimeExecutor:27-39` never instantiates → `orchestrator` unreachable | P3 |

**Routing:** `RuntimeRouter.ts:12-46` priority `explicitRuntime` (composerModeToRuntime `registerSocketServer:176` + `types.ts:175-178`) → `librarianAgentId==agent.id → research` `19-21` → `channelTags`  `23-33` (coding/dev→coding, research/data→research, swarm/ops→swarm) → `authorityLevel` fallback `35-45` (`≤1→agentic, 2→swarm, 3→conversational`). — Magic `authorityLevel` coupling, `swarm` tag forces L0 into stub.

**Isolation:** Shared pipeline/singleton `contextPipeline` `runtimeGate:42-60`, shared `EventBroker` fan-out `registerSocketServer:141-143`, shared `messages` history (no per-run fork). `ToolSchemaMiddleware:13` gates tools by runtime but `PiToolBridge.createAgentCustomTools:184-223` loads all `toolsGate.list()` for coding — Swarm-only `dispatch_agent` leaks.

**Switching:** Explicit only (`mode` param). Each `execute` `assembler.assemble:62` randomUUID + fresh `localHistory` from 30 visibility-filtered messages — no `parentRunId`, no checkpoint, so Chat→Agentic loses `WAITING_FOR_TOOL` context. No `resume/fork/branch`.

---

## C. Complete Architecture Diagram

### Current (Observed — implementation-grounded)

```text
                    ┌─────────────────────┐
                    │  Client UX (Vite)   │
                    │ App.tsx:96-157      │  StrictMode, 3-panel (WorkspaceSidebar/MainChatArea/RightSidebar)
                    │  Socket singleton   │  socket.ts:1-9 io(path:/socket.io, ws+polling, autoConnect)
                    │  Zustand + hash sync│  #workspaceId/channelId 40-71
                    └──────────┬──────────┘
                               │ REST + WS (same-origin Vite proxy)
              ┌────────────────▼─────────────────┐
              │  Fastify Single Process          │  index.ts:18-52 genReqId x-correlation-id, CORS origin:true (!)
              │  Validation (Zod) + ErrorHandler│  validatorCompiler 44, errors.ts:5-37
              └──────────┬───────────────────────┘
                         │ registerRoutes 55  (11 plugins)
        ┌────────────────┼─────────────────┬──────────────┬─────────────┐
        │                │                 │              │             │
 ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌───▼────────┐ ┌──▼─────────┐
 │/health      │ │/api/agents  │ │/api/workspace│ │/api/vfs    │ │/api/mcp   │
 │health.ts    │ │modules/…    │ │budget/database│ │files/content│ │servers   │
 │trivial      │ │CRUD via     │ │.env write(!) │ │list/read/write via LocalVFS│
 │             │ │agentGate    │ │workspace.ts:165│ │path-guard.ts│
 └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ └────────────┘
                         │
              ┌──────────▼───────────┐
              │ Socket Server (in-mem)│  Shared/sockets/registerSocketServer.ts:134-336
              │ broker.onAny→io.emit │  141-143 fan-out ALL clients (should be rooms)
              │ message:new →        │  IndexBuilder.increment 146-153
              │ snapshotInterval 15s │  165-167 + emitRuntimeSnapshot 53-131 (fake mem 42)
              └──────────┬───────────┘
                         │ on("user:message") 173-332
                         │  persist human msg → MentionParser → agent selection fallback → runtimeGate.execute
              ┌──────────▼───────────┐
              │  Runtime Router      │  RuntimeRouter.ts:12-46  explicit>librarian>tags>level
              └──────────┬───────────┘
                         │ Assembler → ContextPipelineManager 55-164
              ┌──────────▼───────────────────────────┐
              │ Execution Engine (SYNC, no queue)    │  RuntimeExecutor.ts:42-71 await in socket handler
              │  Chat/Agentic/Coding/Swarm singleton │  agentic alias research 35, swarm stub 36
              └──────────┬───────────────────────────┘
                         │
      ┌──────────────────┼──────────────────────┐
      │                  │                      │
┌─────▼─────┐  ┌─────────▼─────────┐  ┌────────▼─────────┐
│Model Router│  │ Agent Orchestrator│  │ Tool Gateway     │
│Provider    │  │ ContextPipeline   │  │ ToolExecutor 88  │
│Registry Map│  │ 10 middlewares    │  │ registry 16 tools│
│Google SSE  │  │ Instruction/Skill │  │ Guard blacklist  │
│Anthropic   │  │ Visibility/Memory │  │ +whitelist safe  │
│OpenAI/Ollama│ │ MemoryRetrieval   │  │ MCP stdio spawn  │
│Custom      │  │ ContextLimit(no-op)│ │ PiToolBridge   │
└─────┬─────┘  └─────────┬─────────┘  └────────┬─────────┘
      │            ┌─────▼──────────────┐       │
      │            │ pi-core AgentSession│       │
      │            │ AgentSession+loop  │       │
      │            │ Coding only        │       │
      └────────────┼────────────────────┼───────┘
                   │                    │
        ┌──────────▼──────────┐  ┌─────▼──────────┐
        │ Context/Memory/State│  │ Queue/EventBus │  ← QUEUE MISSING (Critical)
        │ agents/messages     │  │ EventBroker    │  in-mem 50 capped 19-39
        │ compressedSummaries │  │ onAny→io.emit  │  no durability
        │ runtimeStates(lastHeartbeat never written)│ no seq
        │ agentMemoryNotes    │  │ recentEvents   │
        └──────────┬──────────┘  └─────┬──────────┘
                   │                   │
        ┌──────────▼───────────────────▼──────────┐
        │ Durable DB (Postgres + Drizzle)          │
        │ schema.ts:1-822 30 tables, pgEnum        │
        │ messages unique(channel,seq) 247,        │
        │ workspaceNodes(ws,path) unique 416,      │
        │ tokenUsageLog never written via RuntimeKernel│
        │ artifacts table never written by tools   │
        │ dynamicTools unused                      │
        │ LocalVFS sandbox/workspaces/* fs+db sync │
        └──────────┬───────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │ Observability       │  ← GAPS
        │ Fastify logger +    │  genReqId 34-39
        │ console.log per-tool│  no OTel/metrics/traces
        │ tokenTracker sum()  │  full-table scan 60-64
        │ LoopArbiter never   │  called
        │ budget 80% warn     │  via tokenTracker 87
        └─────────────────────┘

Legend: ✅ Observed solid, ⚠️ Broken/Miswired, ❌ Missing per Goal audit.
```

### Target (Recommended)

```text
                     ┌──────────────────────┐
                     │      Client UX       │  Chat / IDE / Threads + 3-panel + Diff/Terminal
                     └──────────┬───────────┘
                                │ Session API (REST + WS)
                     ┌──────────▼───────────┐
                     │   Runtime Router     │  explicit / intent-classifier / tags / level (cheap→expensive model)
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │ Execution Engine     │  Durable State Machine + Job Queue (pg-boss / pg FOR UPDATE SKIP LOCKED)
                     │ + Lease/Heartbeat    │  job {id, type, payload, leaseExpiresAt, owner, status, parentRunId}
                     └──────────┬───────────┘
                                │
               ┌────────────────┼─────────────────┐
               │                │                 │
         ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
         │ Model     │   │ Agent       │   │ Tool      │
         │ Router    │   │ Orchestrator│   │ Gateway   │
         │ cost-aware│   │ DAG/Queue   │   │ ALLOW/ASK/DENY
         └─────┬─────┘   └──────┬──────┘   └─────┬─────┘
               │                │                 │
               │          ┌─────▼─────┐     ┌────▼────┐
               │          │ Subagents │     │ MCP/Web │
               │          │ Workers   │     │ Shell   │
               │          │ isolated  │     │ (sandbox)│
               │          └─────┬─────┘     └─────────┘
               │                │
         ┌─────▼────────────────▼─────┐
         │ Context / Memory / State   │  MemoryRetrieval embedding stub wired to pgvector
         └────────────┬───────────────┘  + per-run checkpoint (localHistory)
                      │
           ┌──────────▼──────────┐
           │ Queue / Event Bus   │  DurableEvents table seq bigserial, BRIN(runId,seq)
           └──────────┬──────────┘   WS replay ?afterSeq, correlationId propagation
                      │
      ┌───────────────▼─────────────────┐
      │ Durable DB / Cache / Artifacts │  runs/runEvents/checkpoints, LRU file-tree, modelModule cache
      └───────────────┬─────────────────┘
                      │
               ┌──────▼──────┐
               │ Observability│  OTel spans (assemble/llm/tool/persist), metrics, cost dashboard, traces
               │ Logs/Metrics │
               │ Traces/Audit │
               └─────────────┘
```

**Changes vs current:** +Job Queue between Router and Engine, +Durable State Machine replacing in-memory `working/idle`, +ASK approval flow in Tool Gateway, +Isolated Subagents for Research/Swarm, +Durable Events + Replay, +Cache layer, +OTel.

---

## D. Lifecycle State Machine

### Current (Observed — 7/22 states)

```text
                    CREATED (implicit db insert)
                       │
                       ▼
                    STARTING (set working  RuntimeKernel:172)
                       │
                       ▼
                    RUNNING  (agents.status=working, runtimeStates.working)
                       │  ◄─── no WAITING_FOR_TOOL (await inline AgenticRuntime:107)
                       │  ◄─── no WAITING_FOR_APPROVAL (missing)
                       │  ◄─── no WAITING_FOR_DEPENDENCY
                       ├──► PAUSED (EscalationChain.escalate:67, LoopArbiter:45) — manual unpause only
                       │       no auto resume
                       ├──► RETRYING (only AgentSpawnManager maxRetries 323-459, not Agentic tool loop)
                       │
                       ├──► COMPLETING (set idle before return 187)
                       │       │
             ┌─────────┴────────┴──────────┐
             │                             │
             ▼                             ▼
         COMPLETED                   FAILED (status:failed, offline)
         (RuntimeResult)             (BaseRuntime.buildFailedResult 15-44 + warning msg)
             │
             └──► VERIFYING (mock supervisor fail/error 414-421, not LLM) — Swarm only
```

**Stored:** `agents.status` + `runtimeStates.status` dual source (risk diverge), `spawnRequests.status` pending→in_progress→completed/failed (only L3).  
**Missing transitions:** `CREATED→QUEUED`, `RUNNING→WAITING_FOR_TOOL|APPROVAL|DEPENDENCY`, `RUNNING→COMPACTING→RUNNING`, `RUNNING→CANCELLING→CANCELLED`, `RUNNING→TIMED_OUT`, `any→EXPIRED`, `RUNNING→ORPHANED` detection, `PAUSED/FAILED→RESUMABLE`.  
**No entry/exit conditions documented for cancel/timeout; no owner/timeout/retry persisted for non-spawn runs.**  
**Bugs:** `lastHeartbeat` never updated, `working` zombie on crash `RuntimeKernel:168-176`; `localHistory` not checkpointed — crash loses tool progress; `requestId` `ContextPipelineManager:126` `ctx_Date.now` collides.

### Recommended Durable Lifecycle (Target)

```text
              ┌─────────────┐
              │  CREATED     │  job inserted, idempotency key dedup, requiresAuth check
              └──────┬──────┘
                     │ lease acquired (FOR UPDATE SKIP LOCKED)
                     ▼
              ┌─────────────┐  ┌──────────┐  ┌───────────┐
              │  QUEUED     │─►│ STARTING │─►│  RUNNING  │
              └─────────────┘  └──────────┘  └─────┬─────┘
                                                   │  checkpoint every tool completion
                              ┌────────────────────┼────────────────────┬───────────┐
                              │                    │                    │           │
                              ▼                    ▼                    ▼           ▼
                    ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐ ┌──────────┐
                    │WAITING_FOR_TOOL  │ │WAITING_FOR_APPROVAL│ │ COMPACTING  │ │ PAUSED   │
                    │tool.start emit   │ │ approval:requested│ │ summary LLM │ │ loop/budget│
                    │await tool with   │ │ await grant/deny  │ │ checkpoint  │ │ managed  │
                    │timeout+signal    │ │ TTL → EXPIRED     │ └──────┬──────┘ └────┬─────┘
                    └────────┬─────────┘ └────────┬─────────┘        │             │
                             │ retry/backoff       │ grant→RUNNING    │             │ resume
                             └─────────────────────┼──────────────────┘             │
                                                   │ deny→FAILED/CANCELLED           │
                              ┌────────────────────▼────────────────────┐          │
                              │  COMPLETING → VERIFYING (LLM verifier) │◄─────────┘
                              └────────────────────┬────────────────────┘
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                          COMPLETED           FAILED/CANCELLED/TIMED_OUT/EXPIRED
                              │                    │
                              └──────────┬─────────┘
                                         ▼
                                    RESUMABLE (checkpointSeq, retryable from failed step)
                                         │
                                         ├─► replay (replay events ?afterSeq)
                                         ├─► retry from checkpoint
                                         └─► fork/branch (new run parentRunId)

ORPHANED detected via heartbeat expiry (leaseExpiresAt < now, no heartbeat 30s) → requeue or CANCELLED + dead-letter.
For each state: entry (owner=workerId, leaseExpiresAt, timeout, checkpoint), exit (event emitted, telemetry span closed), recovery (requeue, escalation, dead-letter).
```

**Implementation:** New `runs` table `id, parentRunId, agentId, channelId, workspaceId, runtimeType, status, historySnapshotJson, checkpointSeq, leaseOwner, leaseExpiresAt, attempts, maxRetries, timeoutMs, createdAt, updatedAt` + `runEvents` `seq bigserial`. Heartbeat `UPDATE runs SET leaseExpiresAt=NOW()+interval '30s' WHERE id=? AND leaseOwner=?` every 10s. `cancelling` via `AbortController` propagated to `callLLM signal` + `ToolExecutor` + child workers.

---

## E. Pipeline Bottleneck Report

### Methodology
Traced `registerSocketServer.ts:173-332` → `RuntimeExecutor.ts:42-71` → `ContextPipelineManager.ts:55-164` (10 middlewares) → `RuntimeKernel.callLLM:17-98` (Google/Anthropic SSE) → `AgenticRuntime:28-174` loop → `ToolExecutor:88-102` → `RuntimeKernel.persistMessage:100-166` / `setAgentStatus:168-176` → `EventBroker.emit:21-47` → `io.emit 141-143`. Latency budget inferred (no APM spans — see Observability gap). All `Risk` items need measurement after OTel added.

### Top 6 Bottlenecks

#### 1. Sequential Context Pipeline (6-9 DB round-trips)
- **Problem:** `ContextPipelineManager:113-118` `for await mw.process` serializes 10 middlewares though 3 are independent. `ChannelAwareness` 2 queries + `InstructionStack` 2 + `SkillContext` DB `SkillService:141-172` 3 queries + `MemoryRetrieval` + `VisibilityMatrix` 60-row fetch are independent.
- **Evidence:** Code loop `for (mw of sorted) await mw.process` `ContextPipelineManager.ts:113`. Per-request `assembler.assemble:57-88` fetches `modelModules` even on cacheable key. No DataLoader.
- **Root Cause:** Naïve sequential assembly, no cache, no batching.
- **Impact:** p50 `80-150 ms`, p95 `300-600 ms` before first token — dominates Chat TTFT alongside LLM.
- **Fix:** Parallelize independent lanes `Promise.all([InstructionStack, SkillContext, ConstraintSafety, MemoryRetrieval])` + LRU caches: `modelModules` 5 min TTL, `agentSkills→tools` with invalidation on `agentSkills` mutation, `messages recent30` per channel LRU. DataLoader per request for agents/modules.
- **Est. Improvement:** `300 ms → 120 ms` p50 (`-60%`), `600 ms → 200 ms` p95.
- **Risk:** Low — cache invalidation must be scoped `workspaceId+agentId`; stale permission risk if TTL too long. Rollback via TTL=0 flag.

#### 2. Serial Tool Execution in Agentic Loop
- **Problem:** `AgenticRuntime:107-170` `for (tc of executableCalls) await toolsGate.execute` — LLM returns 3 tools (`read_file, list_directory, web_search`) → 3 sequential 30s windows.
- **Evidence:** `toolRegistry.ts:16` 16 tools, many independent reads. `ToolExecutor:88-101` `Promise.race` per tool but loop not concurrent.
- **Root Cause:** Simple `for…of`, no dependency analysis.
- **Impact:** 3-tool turn `~900 ms` serial vs `~300 ms` parallel (fs reads) — 3-5× slower for coding-like plans.
- **Fix:** `Promise.all` with `allSettled` + ordering via `localHistory` append sorted by `toolCallId`; add `tool dependency graph` if write-after-read detected.
- **Est. Improvement:** `-50% to -70%` per multi-tool iteration.
- **Risk:** Medium — write/write conflicts if tools touch same file; need ordering guard `Guard.validatePath` contiguous. Add `read vs write` classifier.

#### 3. Unbounded Context & Token Growth (O(n²) duplication)
- **Problem:** `AgenticRuntime:152-169` `outcomeStr` raw tool output + `localHistory` re-sends all prior tool results each `callLLM`; `ContextLimitMiddleware:90-104` `resolveCap` null unless override → no cap. Tool output not truncated/summarized.
- **Evidence:** `AgenticRuntime.ts:152`, `ContextLimitMiddleware.ts:23` early return if cap null. `maxTokenBudget 8000` but no enforcement for most agents. `MemoryBuilder.defaultNaiveSummary:487-497` useless.
- **Root Cause:** Missing truncation + compaction mid-loop.
- **Impact:** 10-iter agentic run → 12k-20k tokens sent cumulatively (10× history growth) → cost + latency + provider `400 context length` errors.
- **Fix:** `maxToolOutputTokens 2000` clamp + summarize overflow via LLM, `ContextLimitMiddleware` enforce `8000` default (not null), compaction at 70% (`HistoryCompressionMiddleware:25-32` currently injects summary after trimming — move before LLM call, re-check cap).
- **Est. Improvement:** `-30%` tokens, fewer retries, no `400` errors.
- **Risk:** Low — summarization may lose detail; add `full output → artifact` link.

#### 4. Blocking Memory Note Writes on Hot Path
- **Problem:** `ConversationalRuntime:40-51`, `AgenticRuntime:52-75`, `CodingRuntime:177-200` `await createMemoryNote` before persisting final response — extra DB write on critical path.
- **Evidence:** `ConversationalRuntime.ts:33` `slice(0,80)` then `await import Mem*`.
- **Impact:** p50 `+20-60 ms`, p95 `+150 ms` per turn; also bloats `agentMemoryNotes` with trivial reflections.
- **Fix:** Fire-and-forget `void createMemoryNote` or background queue + throttle (only if `thoughts.length >200` or importance heuristic).
- **Est. Improvement:** `-30 ms` Chat p50 TTFT, less DB contention.
- **Risk:** Low — queue must survive process crash else lost memories (acceptable).

#### 5. No Connection / Fetch Keep-Alive Reuse
- **Problem:** `GoogleAdapter:28-53` etc. `fetch` per LLM call with new TCP + TLS; `postgres` singleton `Shared/config/database.ts:20-25` `prepare:false` default, no pool size `max`.
- **Evidence:** Each `adapter.call` builds `endpoint` and `fetch` with fresh headers.
- **Impact:** LLM TTFT `800-2000 ms` includes TLS; DB pool `10` default may saturate burst mentions.
- **Fix:** `undici` Agent keepAlive, HTTP/2 where supported, `postgres` `max:20` + `idle_timeout 20` + pool metrics.
- **Est. Improvement:** `-100 to -300 ms` TTFT, higher concurrency.
- **Risk:** Low — connection reuse is transparent.

#### 6. No Streaming Backpressure / Event Fan-Out
- **Problem:** `EventBroker.emit:43-44` sync `emitter.emit` → `io.emit` `registerSocketServer:141-143` to all clients without room scoping; `message:stream` per token (>1k events) overwhelms Socket.IO.
- **Evidence:** `onAny` handler broadcasts `event.type` to `io.emit` not per-channel room.
- **Impact:** CPU burn, memory `recentEvents 50` unbounded channels, cross-channel privacy bleed.
- **Fix:** Scope to `socket.join(channelId)` rooms per channel, emit to room; throttle `message:stream` batch every 50 ms; backpressure via pause if buffer >100.
- **Est. Improvement:** Lower CPU, fixes privacy leak (Risk).
- **Risk:** Medium — room join lifecycle must handle `join/leave` + `removeChannelListeners 86-91`.

---

## F. Agent Architecture Report

### Current Hierarchy (Observed)

```text
User (Stakholder, authorType=user)
  ↓ mentions/roleOrChannelOwner dispatch registerSocketServer:215-309
Primary Agent (Authority L0-L3)
  │ agents schema: authorityLevel 0-3, isOmniscient, l3Subtype worker|supervisor schema:26-27
  │ ChannelAwareness: roster summary; VisibilityMatrix tags: [From @Name | type | Lx | SELF/OTHER | HH:MM:SS]
  │
  ├─ (no Planner) → implicit via LLM systemPrompt (InstructionStack+SkillContext)
  │
  ├─ Tool (toolRegistry 16: read/write/list/delete/bash/safe/search/db/scheduler/dispatch/searchAll/open/discard/lockIn/lockOut/remember)
  │    └─ External (FS/Shell/MCP/browser missing)
  │
  └─ Subagent / Worker (only via AgentSpawnManager dispatch_agent)
       worker+supervisor L3 pair per subtask, private channel ch-pair-… (type:standard BUG should be pair_private)
       batchSize 5 Promise.all, mock code gen, supervisor eval shouldFail if “fail” in instructions
       cleanup deletes channel/agents after 1s 471-489 → audit lost
```

- **How defined:** `db/schema.ts` `agents` 1:1 `modelModules/instructionModules/toolkitModules/constraintsModules`, `agentService.ts:92-137` `ensureValidReferences` validates FK + `l3Subtype` only for L3.
- **Discovery:** `agentService.list({authorityLevel,status,isTemplate})` `59-81` + `registerSocketServer:212` list all non-template; `MentionParser` Levenshtein ≤2 typo `mentionParser.ts:131-151`.
- **Selection:** mentions → role mentions → category owner → L0 fallback → default-assistant `registerSocketServer:215-309`. Sequential `await execute` per agent (not parallel).
- **Delegation:** Only L2→L3 via `AgentSpawnManager` if `allowSpawn` + `dispatch_agent` tool authorized; Agentic `allowDelegation false` `ContextAssembler:38`, so primary agentic cannot delegate.
- **Recursion limits:** None — L3 `spawnAgents:false` `225,244` prevents L3 recursion, but L2 could recurse via spawn tool repeatedly (no counter).
- **Permissions:** `ToolExecutor:54-59` `authorityLevel > required` blocks lower-authority (inverted check), `isOmniscient` bypasses; no runtime/policy scoping.
- **Context:** `VisibilityMatrix:46-98` global vs per-pair `type:standard` mismatch — L3 pair channel not recognized as `pair_private` `MemoryBuilder:228-234`.
- **Concurrency:** Manager 5 parallel, socket mentioning 3 agents runs sequentially, agentic tools serial. No `DAG`/`allSettled` sibling isolation — one throw aborts batch.
- **Result return:** Full tool output wholesale `AgenticRuntime:164-169` no summarization; `PiEventBridge:88` `toolCallRecords` audit transient only.
- **State/Resume/Observe:** No independent state beyond `messages+runtimeStates` (L3 only); no resume; streaming via `broker.emit` observable but not durable; parent cancel not propagated.
- **Failure:** Batch `Promise.all` not `allSettled` — one fails whole batch; no orphan detection.

### Delegation Behavior
- **Planner:** Missing explicit planner agent; relies on LLM tool planning.
- **Specialized subagents:** Not present — only generic worker/supervisor with same prompt, no skill specialization.
- **Isolated context:** Intended via pair channel but `type:standard` bug leaks visibility; no separate token window per subagent.
- **Automatic delegation:** Manual — requires LLM to emit `dispatch_agent` tool call; SwarmRuntime never does.
- **Parallel work:** 5 at a time simulation only.
- **Hook for pi-core:** CodingRuntime `AgentSession` supports isolation via `sessionId=session_agent_channel` but per-request new session, no continuation.

### Context Boundaries
`VisibilityMatrix` filters by `lock_in` (Map `agentLockStore.ts:10` in-memory) + `memorySharingPolicy full/horizontal/vertical/none` — correct design.  
**Broken:** `agentLockStore` lost on restart, no TTL, no DB persistence; Research agentic same channel history → contamination as Goal #7 warns (raw web_search mock output persisted verbatim).

### Permissions Inheritance
**Missing:** Children get `none` hardcoded `agentSpawnManager:220`, not `horizontal`; no tool/skill inheritance beyond fresh `skillsGate.getResolvedToolsForAgent`.

### Concurrency & Failure
- No `AgentError` `EscalationChain.escalate:30-193` retry loop not invoked by runtimes (except L3 supervisor `maxRetries`).  
- Loop detection `LoopArbiter:14-53` `0.9` similarity on 3 messages exists but never called from runtimes (dead code).

### Recommended Architecture

```text
User
  ↓
Primary Agent (Router selects Chat/Agentic/Coding/Research/Swarm)
  ↓
Planner (lightweight decomposition model — cheap) → produces DAG {task, deps, estimator, contextSlice}
  ↓
Specialized Subagents (isolated contextWindow = 8k, own tools subset, forked history summary — not full log)
  ├─ Research Worker ×N (parallel web/search, isolated, citation artifact)
  ├─ Coding Worker (VFS worktree per task, LSP indexing via cache)
  ├─ Test Worker (parallel test execution, result aggregation)
  └─ Review Worker (independent verifier model)
  ↓ (Message passing via durable channel events + shared artifacts)
Aggregator (merges artifacts, deduplicates, MMR summary)
  ↓
Verifier (independent model, checks goal achieved, no hallucination, diff applies cleanly, tests pass)
  ↓
Final Result (artifacts + diff + citations + runEvents)
```

- **Lease/heartbeat:** Each subagent job row `leaseExpiresAt` + `ownerWorker`, heartbeat every 10s; orphan requeue after 30s.
- **Summarized returns:** Tool outputs truncated → artifact file + summary (not full log) returned to parent (`maxSubagentReturnTokens 500`).
- **Permission inheritance:** Child inherits `min(parent.level, tool.required)` + explicit `ASK` delegation override stored in `job.permissions`.
- **Cancellation propagation:** Parent `AbortController` linked to children via `abortSignal` chain — `ToolExecutor:93-97` already supports.

---

## G. UX Gap Analysis

Capability primitives evaluated vs Codex (safe sandbox/permissions/telemetry), Claude Code (subagents/isolated context/parallel/hooks/resume), Cursor (IDE context/terminal/diff), OpenCode (modes/subagents/permissions/fork/remote), Antigravity (Mission→Plan→Execution→Artifacts→Verify), Discord (Workspace→Channel→Thread→Task→Result + notifications). Not superficial UI.

| Capability | Current | Target | Gap | Priority |
|---|---|---|---|---|
| **Conversation: sessions/threads/branch/fork** | Channel flat log, `sequenceNumber` append-only, `HistoryCompression` single summary, no branch table `schema.ts:305` | Session tree `runs(parentRunId, branchName)`, `GET /api/runs/:id/branch`, per-branch history isolation | No fork/resume/retry-from-checkpoint; research contaminates main thread | **P1** |
| **Conversation: search/history/pin/archive** | List messages by channel only `routes/messages.ts:1-25`, categories/channels archived flag only | Full-text search on `messages` + `agentMemoryNotes`, pinned/starred, search-index `pg_trgm` | Users cannot find prior task | P2 |
| **Conversation: edit/regenerate/stop/cancel** | No route, `registerSocketServer.ts` no `user:cancel` | `POST /api/messages/:id/edit` rewinds history snapshot, `AbortSignal` wired `RuntimeKernel:17` | Cannot fix typo-driven run without duplicate | **P1** |
| **Agent: running/background status** | `agent:status idle/working/paused/offline` + 15s snapshot `registerSocketServer:165-167` fake `mem 42` | Live `runs` dashboard: `QUEUED/RUNNING/WAITING_FOR_APPROVAL/COMPACTING`, progress %, elapsed, cost | No insight why agent stuck | **P1** |
| **Agent: approvals ASK flow** | `dangerLevel safe/moderate/dangerous` only `toolTypes:2`, auto block `Guard:49-61` | Tri-state `ALLOW/ASK/DENY` per tool/command/path/domain, modal `approval.requested` + grant/deny + auditable | Dangerous commands blocked outright, safe ones no confirm — no granularity | **P0** |
| **Agent: subagent visibility** | `agent:spawned/despawned` exist but frontend only `workspace:sync` poll, `ch-pair-` deleted after 1s | Worker cards: role ×N, progress, dependencies DAG, logs per worker | Cannot supervise swarm | P1 |
| **Coding: file explorer** | `GET /api/workspace/files` `routes/vfs.ts:38-54` per-folder fetch, recursive Node `FileTreeNode` `Specs.md:718` | Same but + LRU cache `workspaceNodes` DB without `fs.stat` N+1 `local-vfs:279` | Explorer works but slow on large trees | P2 |
| **Coding: diff/changed files/commit** | No diff view, `artifacts` table `schema:438` never written, `edit_file` diff string only as tool output `PiToolBridge:70-94` | Diff viewer `artifact.created {path, before, after, patch}`, `changedFiles` list, branch/worktree `workspaceManager:30 maxAgents 8` + Git flow | Cannot review before apply | **P1** |
| **Coding: terminal** | `execute_bash` + `execute_safe` buffered `exec` 30s, no streaming, no pty | `node-pty` streamed terminal `sandbox:stream` `eventTypes:95` wired + persistent shell session | Cannot observe long builds | P1 |
| **Coding: test/lint/build verification** | Via bash only | First-class `runTests` artifact with parser (pass/fail), `verify` step before complete | No automatic repair loop | P2 |
| **Research: sources/citations/progress** | `web_search` mock `toolRegistry:252-275`, `LibrarianRuntime:124-195` per-channel index only via `@Librarian` mention | Parallel workers isolated, source ranking/verification/citation artifact, dedup + freshness | Research not isolatable — pollutes main context | P2 |
| **Swarm: active workers/dependencies/aggregation** | Batch 5 mock `AgentSpawnManager:102-118`, private channel ephemeral, no aggregator UI | DAG view, channel-scoped isolation, aggregator + verifier synthesis | Swarm UX non-existent | P2 |
| **Workspace: persistent context/sandbox** | `workspaceNodes` durable `schema:401-416`, `LocalVFS` FS sync `134-174`, sandbox per workspace | Worktree per task (copy-on-write via `workspaceManager.mountAgent`), indexing cache, artifact service | Coding tasks race on same `process.cwd()` | P2 |
| **Notification: background task done** | `broker.onAny→io.emit` ephemeral, `recentEvents 50` loss on restart | Durable `run.completed/failed` push + `Notification` inbox `Spec Discord` + `branch` resume on reconnect | Closing browser loses completion signal | P1 |
| **Developer: permission boundaries observable** | Logs only `ToolExecutor:86 console.log`, no UI | Permission inheritance panel + approval history + audit reconstruction via `runEvents` | Cannot debug `Security breach` throws | P1 |

**Strongest interaction primitives to emulate (not UI clone):**
- Codex: safe-by-default, sandbox boundaries, `budget:*`/`agent:status` telemetry → add ASK gate + durable events.
- Claude Code: specialized subagents isolated contexts parallel `Promise.all` + resume → add DAG workers with summarized returns.
- OpenCode: explicit `mode` (Chat/Agentic/Coding/Research/Swarm) + subagent separation + `forking` → already `ResearchRuntime` stub needs split.
- Discord: persistent threads, `Thread→Task→Agent→Result`, status changes, durable history → add `rooms` per channel + `durableEvents` replay.

---

## H. Backend Optimization Plan

Ranked by Impact / Effort / Risk / Dependency / ROI. Split Quick Wins / Medium / Strategic.

### Quick Wins (minimal refactor, 1-3 days each)

| # | Improvement | Impact | Effort | Risk | Dependency | ROI |
|---|---|---|---|---|---|---|
| HQ1 | **Parallelize context pipeline** — `Promise.all` for independent middlewares (Instruction/Skill/Constraint/Memory) + remove sequential `for await` `ContextPipelineManager:113` | High (-60% assemble) | Low | Low | None | **High** |
| HQ2 | **LRU caches: modelModules / agentSkills→tools / messages recent30** — `Map+TTL` or `lru-cache` 100 entries, invalidate on mutation | High (-50% DB hits) | Low | Low (stale TPS) | HQ1 | **High** |
| HQ3 | **Fire-and-forget memory notes** — `void createMemoryNote` off hot path `Conversational/Agentic/Coding` `40-51/52-75/177-200` + throttle | Medium (-30 ms TTFT) | Low | Low | None | High |
| HQ4 | **Redact secrets in logs & API** — scrub `apiKey` `studio.ts:32-37,204`, `workspace.ts:165`, `console.log [ToolExecutor]` | Critical security | Low | Low | None | **Critical** |
| HQ5 | **Fix hardcoded `memoryUsedMb:42` + `WORKSPACE_DIR` Windows path** — `registerSocketServer:107`, `agentSpawnManager:21` use `LocalVFS` workspaceRoot | Medium observability | Low | Low | None | Medium |
| HQ6 | **Scope socket to rooms per channel** — `socket.join(channelId)` `registerSocketServer:141-143` not `io.emit` | Medium privacy fix | Low | Low | None | High |
| HQ7 | **Truncate tool outputs + default cap** — `AgenticRuntime:152` `maxToolOutputTokens 2000`, `ContextLimitMiddleware` default 8000 not null | High cost | Low | Low | None | High |

### Medium-Term (moderate refactor, 1-2 weeks)

| # | Improvement | Impact | Effort | Risk | Dependency | ROI |
|---|---|---|---|---|---|---|
| HM1 | **Parallel tools** — `Promise.allSettled` for `executableCalls` `AgenticRuntime:107` with dependency graph | High (-50% iter) | Medium | Medium (conflict) | HQ7 | High |
| HM2 | **AbortSignal end-to-end** — create `AbortController` per `user:message` socket, propagate to `RuntimeKernel.callLLM signal` + `ToolExecutor 93-97` + `pi-core session.prompt(signal)` | High durability | Medium | Medium | None | **Critical** |
| HM3 | **Durable events** — `runEvents` table `seq bigserial` + `EventBroker` dual-write + `GET /api/runs/:id/events?afterSeq` + `onAny` replay | High resumability | Medium | Medium | HQ1 | High |
| HM4 | **AuthN/Z gate** — `fastify-jwt` + per-route `preHandler` checking `permissions` `schema:197`, fix `origin:true 49` → allowlist `CLIENT_ORIGIN`, `permissionGuard:34-77` for VFS | Critical | Medium | Medium | HQ4 | **Critical** |
| HM5 | **DB pooling + fetch keepAlive** — `postgres max 20 idleTimeout 20`, `undici` Agent, pool metrics `database.ts:20-35` | Medium TTFT | Medium | Low | None | Medium |
| HM6 | **Real model routing cost-aware** — cheap model for Chat/memory/indexing, expensive for Coding/Verification; add `costPer1k` to `modelModules` `schema:46-62`, router by complexity | Medium cost | Medium | Low | HQ2 | High |

### Strategic (architectural evolution, 3-6 weeks)

| # | Improvement | Impact | Effort | Risk | Dependency | ROI |
|---|---|---|---|---|---|---|
| HS1 | **Durable Execution Engine** — `jobs` table `FOR UPDATE SKIP LOCKED` + worker pool + lease/heartbeat 30s + dead-letter + idempotency keys + `runs` checkpoint | **Critical reliability** | High | High | HM2, HM3 | **Critical** |
| HS2 | **Real SwarmRuntime** — promote `AgentSpawnManager` mock → real DAG execution `Dag→Queue→Lease→Worker→Aggregator→Verifier`, worktree per task `workspaceManager.mountAgent:30` | High scalability | High | High | HS1, HQ1 | High |
| HS3 | **Research as isolated subagents** — ResearchRuntime spawns N parallel search workers with `citation` artifacts, MMR dedup, synthesis via summarizer, returns compressed report (not raw pages) | Medium quality | High | Medium | HS1 | Medium |
| HS4 | **Git/worktree/diff artifact service** — `artifacts` table finally written by `ToolExecutor` + `PiToolBridge`, diff viewer, `changedFiles` + `commit/branch` UX, LSP indexing cache | Medium DX | High | High | HS1 | Medium |
| HS5 | **OTel + cost dashboard** — spans `assemble/llm/tool/persist`, metrics `promptTokens/completionTokens/total/duration/cost`, budget tracing `tokenTracker:60-88` enforced per-provider | Medium observability | High | Medium | HM3 | Medium |
| HS6 | **Prompt Context Service** — unify `MemoryBuilder:43-533` legacy + `ContextPipelineManager` into single `ContextService` with versioned instructions + prompt cache + injection escaping `VisibilityMatrix:14-17` hardened | Medium correctness | Medium | Medium | HQ1 | Medium |

---

## I. Priorities (P0/P1/P2/P3)

### P0 — Critical (reliability, correctness, security, data loss, runaway)

| ID | Problem | File:Line | Fix |
|---|---|---|---|
| P0-1 | **No authentication — any origin can read/write DB/files** | `index.ts:47` `origin:true`, `registerSocketServer.ts:193` hard-coded user, all routes no `preHandler` | Add `fastify-jwt` + API key, role guard `permissionGuard.ts`, `origin: env.CLIENT_ORIGIN.split(',')` |
| P0-2 | **Secrets exposed plaintext** — `apiKey` stored `schema:51`, emitted `studio.ts:32-37,204`, logged `ContextPipelineManager:80-86`, `.env` mutated `workspace.ts:165-185` | `studio.ts`, `workspace.ts`, `database.ts` | Encrypt at rest (`pgcrypto`), scrub response, remove `.env` write endpoint or restrict to admin + audit |
| P0-3 | **No durable execution — work lost on restart/crash** | `registerSocketServer:227` sync await, no `jobs` table, `EventBroker:19` memory 50 | Add `jobs/runs` durability `FOR UPDATE SKIP LOCKED` + lease, checkpoint `localHistory` |
| P0-4 | **Zombie `working` agents — heartbeat never updated** | `db/schema:121` `lastHeartbeat` never written, `RuntimeKernel.setAgentStatus:168-176` no lease | Heartbeat `UPDATE runtimeStates SET lastHeartbeat=NOW()` every 10s, orphan detection 30s |
| P0-5 | **Shell injection surface** — blacklist 6 strings bypassable, `child_process.spawn shell:true` `mcpClientManager:77-81` inherits env | `Guard:49-61`, `mcpClientManager:77` | Allowlist by default for `execute_bash`, `shell:false` + `command` parsing, MCP sandbox via docker/`isolated-vm` |
| P0-6 | **Broadcast privacy bleed** — `io.emit` to all without rooms | `registerSocketServer:141-143` | `socket.join(channelId)` rooms per channel, emit to room |

### P1 — High (major latency, lifecycle, orchestration, UX)

| ID | Problem | Fix |
|---|---|---|
| P1-1 | Context pipeline serial 6-9 DB trips | HQ1 parallel middlewares + HQ2 caches |
| P1-2 | Tool execution serial | HM1 `Promise.allSettled` |
| P1-3 | Context unbounded, no cap | HQ7 clamp + default `ContextLimitMiddleware` 8000 |
| P1-4 | Lifecycle missing 15/22 states, no cancellation propagation | HM2 `AbortSignal` + lifecycle target state machine |
| P1-5 | Swarm & Research stubs disconnect from router | Promote to real runtimes (HS2/HS3) |
| P1-6 | No terminal/diff/commit UX for coding | HS4 artifact service + diff viewer + pty |
| P1-7 | No approval ASK flow | HM4 permission ASK + `approval.requested` events |
| P1-8 | Observability not reconstructable | HM3 durable events + OTel spans |

### P2 — Medium (quality & scalability)

| ID | Item | Fix |
|---|---|---|
| P2-1 | No caching — N+1 `VFS.list` `fs.stat` per entry, `channelIndex` text filter `librarianRuntime.ts:207` | HQ2 LRU file-tree, `IndexBuilder` vector lane wired `schema:145` `embeddingModelProfiles` |
| P2-2 | Memory preview injection duplicate; `discard_memory_from_context` stub no-op `toolRegistry:534-557` | Wire discard to `ContextPacket` mutation + `HM3` compaction |
| P2-3 | Token accounting fake `ceil(len/4)` `GoogleAdapter:90-91`, Coding `usage 0` `CodingRuntime:222` | Parse `usageMetadata`/`usage` from provider JSON, propagate via `PiEventBridge` |
| P2-4 | Prompt hierarchy precedence ambiguous, `compressed_history_summary` after trim re-exceeds cap `ContextLimit:69` | Re-run cap after compression, add precedence doc |
| P2-5 | Frontend lacks search/pin/threading/branch | G gap — implement run branch + message search |
| P2-6 | No rate limiting/quotas (brute force LLM spend amplification) | `@fastify/rate-limit` per-IP + per-agent token budget `tokenTracker:60-88` per-provider enforcement |

### P3 — Optimization (polish, advanced)

| ID | Item | Fix |
|---|---|---|
| P3-1 | `observer`/`orchestrator` unreachable runtimes `RuntimeExecutor:27-39` | Remove or implement; add `orchestrator` that delegates |
| P3-2 | Dual `LoopArbiter` `Shared/core/LoopArbiter.ts` vs `core/LoopArbiter.ts` re-export | Consolidate to `Shared/core` |
| P3-3 | `LoopArbiter` 0.9 threshold never called; compaction naive summary `MemoryBuilder:487-497` | Wire arbiter into Agentic loop + LLM summarizer |
| P3-4 | `dynamicTools` table unused, `mcpClientManager` newline JSON incompatible with MCP spec chunking | Persist dynamic tools, add `Content-Length` framing |
| P3-5 | `TokenTracker.sum()` full scan `tokenTracker.ts:60-64` | Counter cache `workspace_settings.budgetUsed` incrementally updated |

---

## 32. Recommended Target Architecture (modified per repo needs)

```text
                     ┌──────────────────────┐
                     │      Client UX       │
                     │ Chat / IDE / Threads │  3-panel + Diff + Terminal (pty) + Swarm board + Diff/commit
                     └──────────┬───────────┘
                                │
                          Session API
                    ┌──────────▼───────────┐  auth → fastify-jwt, CORS allowlist, rate-limit
                    │   Runtime Router     │  cheap→expensive model, intent classifier (tiny LLM), tag+level fallback
                    └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │ Execution Engine     │  ← NEW durable `jobs` + `runs` + lease/heartbeat + idempotency
                     │ Durable State Machine│  22-state target (QUEUED..RESUMABLE), checkpoint localHistory
                     └──────────┬───────────┘
                                │
               ┌────────────────┼─────────────────┐
               │                │                 │
         ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
         │ Model     │   │ Agent       │   │ Tool      │
         │ Router    │   │ Orchestrator│   │ Gateway   │  ALLOW/ASK/DENY per tool/command/path/domain
         └─────┬─────┘   └──────┬──────┘   └─────┬─────┘  ASK → approval event → grant/deny TTL
               │                │                 │
               │          ┌─────▼─────┐     ┌────▼────┐
               │          │ Subagents │     │ MCP/Web │  sandbox docker/isolated-vm, network domain allowlist
               │          │ Workers   │     │ Shell   │  streamed bash + worktree per task
               │          └─────┬─────┘     └─────────┘
               │                │
         ┌─────▼────────────────▼─────┐
         │ Context / Memory / State   │  unified ContextService, pgvector embeddings wired, per-run window
         └────────────┬───────────────┘  instruction versioning, MMR dedup, cache LRU
                      │
           ┌──────────▼──────────┐
           │ Queue / Event Bus   │  DurableEvents seq, WS replay afterSeq, rooms per channelId
           └──────────┬──────────┘  backpressure, batch stream 50ms
                      │
      ┌───────────────▼─────────────────┐
      │ Durable DB / Cache / Artifacts │  Postgres (runs/events/checkpoints), LRU file-tree, artifacts+diff storage
      └───────────────┬─────────────────┘
                      │
               ┌──────▼──────┐
               │ Observability│  OTel (assemble/llm/tool/persist spans), metrics, budget dashboard, audit
               │ Logs/Metrics │
               │ Traces/Audit │
               └─────────────┘
```

**Modifications vs Goal's generic target:** Keep CrowdOS concepts (authority L0-L3, `workspaceNodes` VFS `LocalVFS`, `runtimeStates/overrides`, `budget:*` tiered roster `RightSidebar`), but replace in-memory broker queue with durable `jobs/runs`, wire `embeddingModelProfiles` to pgvector, add worktree per task using existing `workspaceManager.mountAgent maxAgents 8`, expose `rooms` fix.

---

## 33. UX Target State (interaction flows)

### Proposal: Coding fix (intent-level)

```text
User: "Investigate the authentication issue and fix it."

System:
 1. Understand request (intent classifier → agentic).
 2. Select Coding runtime (modelRouter: high-cap coder model).
 3. Explain plan (Planner produces DAG → UI shows steps: inspect→plan→modify→run→verify).
 4. Start execution (job queued, lease acquired, status QUEUED→RUNNING).
 5. Show live progress (streamed thoughts chunks + tool:start/complete per step → no 15s poll).
 6. Delegate repository exploration (CodingRuntime pi-core read/list, indexed via cached file-tree).
 7. Inspect relevant files (diff preview pending → artifact.created).
 8. Run diagnostics (execute_bash streamed pty → sandbox:stream).
 9. Make changes (edit_file diff → artifact diff.created).
10. Run tests (TestWorker parallel → pass/fail artifact).
11. Review diff (Diff viewer + changedFiles list + verify step).
12. Verify result (Verifier agent independent model → goal achieved?).
13. Present concise outcome (finalResponse + artifacts + cost + traceId).
14. Persist task state (run COMPLETED checkpoint, replayable events).
15. Allow user to resume, inspect traces, fork on variant, or continue thread.
Interrupt only for: ALLOW/ASK tool approval, or budget 80% warning.
```

### Long-running (browser-close durable)

```text
User starts task (POST /api/runs {mode:coding}) → 201 {runId, leaseOwner}
        ↓
Task continues in background (worker heartbeat every 10s → durableEvents seq++)
        ↓
User closes browser (WS disconnect, rooms leave — no effect on job)
        ↓
Agent keeps running (lease NOT tied to socket, expires 30s after crash → orphan requeue)
        ↓
Task completes (run status COMPLETED/FAILED, final persisted messages + artifacts)
        ↓
Notification (broker emit + DB inbox → browser Notification API on reconnect)
        ↓
User opens task (GET /api/runs/:id?afterSeq=0 → replay all events ordered replayable/idempotent)
        ↓
Full execution timeline (spans: assemble 45ms, llm 1100ms, tool1 120ms, … cost $0.04)
        ↓
Final diff / artifacts / summary (artifact diff.created → one-click apply / revert via VFS)
```

### Swarm synthesis

```text
User request → Planner decomposed 4 subtasks → DAG
   ↓
Supervisor (L2) dispatched
   ├── Research agent (isolated context, web_search parallel) → citations artifact
   ├── Coding agent (worktree) → patch artifact
   ├── Test agent (parallel) → results artifact
   └── Review agent → verdict artifact
          ↓
      Aggregator (MMR dedup, contradiction detection) →
          ↓
      Verification (independent model checks patch applies + tests pass)
          ↓
       Result (synthesis with citations, diff, cost, trace)
```

**Primitives to enforce per Goal #23:** `conversation + task execution + agent supervision + developer workspace + persistent project context + observable runtime` — not just `chat box + response`.

---

## 34. Review Rules Coverage (cross-checked)

1. Inspect before recommend — ✅ all findings tied to file:line code paths, not names.
2. Trace execution — ✅ `registerSocketServer→Router→Assembler→Kernel→Runtime` + tool + streaming traced.
3. Measured evidence — ⚠️ no APM metrics available → noted as Bottleneck tags + inferred p50 with caveat.
4. Architecture vs bug — ✅ separated (e.g., Swarm stub = arch missing DAG, `WORKSPACE_DIR` hard-code = impl bug).
5. Root causes — ✅ queue missing, sequential pipeline, secret plain-text, cost-blind routing identified.
6. No blind rewrite — ✅ recommends incremental migration HQ→HM→HS with rollback.
7. Prefer incremental — ✅ caches/parallelism first, durable engine later.
8. Quantify improvements — ✅ estimated `-60%` assemble, `-50%` multi-tool, cost `-30%`.
9. Cancellation/retry/resumability first-class — ✅ target state machine includes CANCELLING/CANCELLED/RESUMABLE + lease.
10. Observability as runtime — ✅ OTel spans per stage, `runEvents` replay.
11. Permissions as enforcement — ✅ ASK flow wired to `ToolExecutor` + guard, not UI only.
12. Context isolation — ✅ VisibilityMatrix + isolated subagent windows.
13. Background as durable — ✅ job queue not socket lifetime.
14. Preserve control/minimize interrupts — ✅ ALLOW/ASK/DENY + reusable grant TTL.
15. Implementation-specific — ✅ all fixes reference exact files to edit.

---

## 35. Final Output Requirements

### Top 10 Problems (ranked severity × impact)

| # | Problem | Severity | Location | Evidence |
|---|---|---|---|---|
| 1 | **No auth — any origin mutates system** | Critical | `index.ts:47` `origin:true`, `registerSocketServer:193` hard-coded, no `preHandler` | Allows config injection via `POST /api/workspace/database` |
| 2 | **No durable queue/worker — work lost on any failure** | Critical | `registerSocketServer:227` sync await, no `jobs` table, `EventBroker:19` memory | Process restart/network fail/browser disconnect kills long work |
| 3 | **Zombie lifecycle — heartbeat never updated** | Critical | `schema:121` `lastHeartbeat`, `RuntimeKernel:168` never heartbeats | `working` stuck forever, no orphan detection |
| 4 | **Secrets plaintext leaked** | Critical | `schema:51` `apiKey`, `studio.ts:32`, `workspace.ts:165` | Compliance blocker |
| 5 | **Research alias + Swarm stub = false capability** | High | `RuntimeExecutor:35`, `SwarmRuntime:15-23`, `AgentSpawnManager:21` hard Windows path | Users route to swarm and get chat |
| 6 | **Shell blacklist bypassable + MCP `shell:true` env leak** | High | `Guard:49-61`, `mcpClientManager:77` | Host takeover |
| 7 | **Context unbounded O(n²)** | High | `AgenticRuntime:152-169`, `ContextLimit:90-104` null cap | Cost runaway, `400 context length` |
| 8 | **In-memory events leak privacy, unrecoverable** | High | `EventBroker:19-39` 50 caps, `registerSocketServer:141-143` `io.emit` all | GDPR leak, lost audit |
| 9 | **No cancellation/retry/timeout propagation** | High | `contextTypes:13` signal never set, `ToolExecutor:88` race leak, provider fetch no timeout | User cannot stop runaway tool/LLM |
| 10 | **Serial pipeline + serial tools** | Medium | `ContextPipelineManager:113`, `AgenticRuntime:107` | 2-3× slower than needed |

### Top 10 Opportunities (ranked ROI = impact/effort)

| # | Opportunity | Effort | Impact | Location Ref | Est ROI |
|---|---|---|---|---|---|
| 1 | **Auth + secret scrub + CORS allowlist** | Low (2d) | Critical prod-blocker | `index.ts:47`, `studio.ts:32`, `workspace.ts:165` | ★★★★★ |
| 2 | **Parallel context pipeline + LRU caches** | Low (3d) | -60% assemble, -50% DB | `ContextPipelineManager:113`, caches | ★★★★★ |
| 3 | **Durable job primitive (pg FOR UPDATE SKIP LOCKED) + lease** | High (1w) | Reliability + resumability | New `jobs/runs` | ★★★★★ |
| 4 | **Clamp tool outputs + default cap + streaming throttle** | Low (1d) | -30% cost, no blowup | `AgenticRuntime:152`, `ContextLimit:23` | ★★★★☆ |
| 5 | **AbortSignal end-to-end (socket→LLM→tool→pi-core)** | Medium (1w) | User control + cost | `contextTypes:13`, `ToolExecutor:93`, `RuntimeKernel:17` | ★★★★☆ |
| 6 | **Durable events + WS replay rooms** | Medium (1w) | Observable + resumable UX | `EventBroker:21-47`, `registerSocketServer:141` | ★★★★☆ |
| 7 | **Parallel tools via allSettled** | Low (2d) | -50% multi-tool | `AgenticRuntime:107` | ★★★★☆ |
| 8 | **Real Swarm (promote mock) + isolated Research subagents + worktrees** | High (3-6w) | Multi-agent premium | `AgentSpawnManager:46-501`, `SwarmRuntime:8` | ★★★☆☆ |
| 9 | **OTel spans + cost dashboard (budget per-provider)** | Medium (1w) | Debug + budget control | `tokenTracker:60-88`, all stages | ★★★☆☆ |
| 10 | **Artifact/diff service + pty terminal + commit flow** | High (2w) | Coding UX parity | `PiToolBridge:70-94`, `local-vfs:134`, `schema:438` | ★★★☆☆ |

### Top 10 UX Improvements (by user impact)

| # | UX | Before | After | Impact |
|---|---|---|---|---|
| 1 | **Cancel/Stop button** — `AbortSignal` wired | No way to stop long LLM/bash → wait/timeout | `user:cancel` → `CANCELLING` span, tool race aborts, persist `CANCELLED` | Prevents runaway cost/time |
| 2 | **Approval card (ASK)** — tri-state per tool/command/path | Block or allow only; no ask | `approval.requested` modal → grant/deny TTL → auditable | Safe-by-default |
| 3 | **Live progress (not 15s poll)** | 15s snapshot fake `42MB` `registerSocketServer:107` | Per-tool `progress {step,total,elapsed}` + streamed `thinking_started` | Feels like Codex/Claude Code |
| 4 | **Diff viewer + Changed Files + Review → Apply/Revert** | Tool output string only | `diff.created` artifact `artifacts` table + viewer via `VFS content` + one-click apply | Developer-grade |
| 5 | **Terminal (pty streamed)** | Buffered `exec` → truncated | `node-pty` + `sandbox:stream` continuous | Matches Cursor |
| 6 | **Background tasks inbox + resume/fork** | Browser must stay open | Durable run → notification → replay `?afterSeq` → fork | Discord-style durable |
| 7 | **Thread/branch reuse** | Proposes new channel/topic? No reuse | `POST /api/runs/:id/branch` fork history snapshot | No context loss |
| 8 | **Subagent swarm board** | No visibility | 5-step → 3 research workers + coding worker cards + aggregation preview | Swarm observable |
| 9 | **Citation/sources panel for Research** | Mock `web_search` | Isolated workers → citations list deduplicated, freshness badge | Research trustworthy |
| 10 | **Cost/budget dashboard** | Fake tiered roster `RightSidebar` | Per-run `tokens/cost` + budget 80% warning actionable + per-provider caps enforced | Cost-aware |

### Top 10 Backend Improvements (latency/scale/cost/reliability)

| # | Backend | File:Line | Benefit |
|---|---|---|---|
| 1 | Add `jobs`/`runs`/`runEvents` durable queue | New | Survives restart, retry, resume, audit |
| 2 | Fix secret plain-text → `pgcrypto` + scrub | `schema:51`, `studio.ts:32` | Security baseline |
| 3 | Auth + CORS + rate-limit | `index.ts:47`, `routes/*` | Abuse prevention |
| 4 | Parallel context + LRU | `ContextPipelineManager:113` | 150 ms assemble p50 |
| 5 | Parallel tools | `AgenticRuntime:107` | 2× coding speed |
| 6 | Durable events + rooms | `EventBroker:19`, `registerSocketServer:141` | Resumability + privacy |
| 7 | AbortSignal propagation | `RuntimeKernel:17`, `ToolExecutor:93` | Cancel propagation |
| 8 | Default cap + output clamp | `ContextLimit:23`, `AgenticRuntime:152` | Cost -30% |
| 9 | DB pool + fetch keepAlive | `database.ts:20-35`, `GoogleAdapter:28` | TTFT -150 ms, concurrency |
| 10 | OTel + token cost real | `GoogleAdapter:90`, `CodingRuntime:222` | Reconstruc table cost debugging |

### Target Runtime Model

```text
Chat ──explicit mode──► Agentic ──complexity heurs/ASK──► Coding ──DAG──► Swarm
 │                         │                                    ▲
 │ tag:research            │ tag:swarm                          │
 └────────────────► Research (isolated subagents, isolated → aggregated) ──┘
 │                         │
 └─► low latency cheap model  vs  high-cap reasoning / verifier expensive model ◄─┘
All share unified ContextService + durable runs, but:
  Chat: 8k cap, no tools, streaming prioritized, memory note fire-and-forget.
  Agentic: 10 iter, serial→parallel tools, checkpoint per tool, compaction 70%.
  Coding: worktree, LSP index cache, pty bash, artifact diff, verify tests.
  Research: parallel workers, citation artifacts, no prompt contamination.
  Swarm: supervisor(DAG)→workers(lease)→aggregator(MMR)→verifier→result.
Transitions explicit + reversible (branch). Each move presets parentRunId → resumable.
```

### Target Agent Model

```text
Primary Agent (selected by Router)
    │
    ├── Planner (cheap model, decomposes user intent → DAG tasks)
    │
    ├── Specialized Subagents (isolated contextWindow 8k each, own tool subset)
    │     ├── Explore/Search (read/list/search — cheap/fast)
    │     ├── Coding (edit/write/bash — sandboxed worktree)
    │     ├── Test (execute_safe/execute_bash pty — reports)
    │     └── Review (read-only diff — verifier prompts)
    │        ↕ message passing via durable channel events (rooms)
    │
    ├── Tools (Tool Gateway ALLOW/ASK/DENY, timeout+signal, artifacts)
    │     └── MCP/Web/Shell (network allowlist, docker isolation)
    │
    └── Verification (independent reviewer model, checks goal achieved, no hallucination)
          │
     Final Result (synthesis + artifacts diff + citations + cost/trace)
```

### Target Lifecycle Model

Full durable 22-state diagram in **Section D (Recommended)** above — single source `runs` table plus `runEvents` seq, from `CREATED→QUEUED→STARTING→RUNNING→(WAITING_FOR_TOOL|WAITING_FOR_APPROVAL|COMPACTING|PAUSED)→COMPLETING→VERIFYING→COMPLETED`, branches to `FAILED/CANCELLED/TIMED_OUT/EXPIRED/ORPHANED→dead-letter`, `RESUMABLE` via checkpoint `afterSeq`.

### Target Event Model (durable, ordered, replayable, idempotent, correlated, traceable)

```text
run.created         {runId, parentRunId, agentId, channelId, workspaceId, runtimeType, intent, model}
run.started         {runId, leaseOwner, leaseExpiresAt}
run.status_changed  {runId, old:new, reason}
agent.started       {runId, agentId, iteration}
agent.thinking_started {runId, agentId}
agent.tool_requested{runId, agentId, toolCallId, toolName, preview}
tool.started        {runId, toolCallId, agentId, toolName, startedAt}
tool.output         {runId, toolCallId, chunk, done?}  ← STREAM via pty / long file reads
tool.completed      {runId, toolCallId, success, durationMs, artifacts:[]}
approval.requested  {runId, toolCallId, policy ASK, command/path preview, TTL}
approval.granted|denied {runId, toolCallId, actor}
agent.progress      {runId, agentId, step, totalSteps, elapsedMs, estimatedCost}
agent.completed|failed {runId, agentId, status}
artifact.created    {runId, artifactId, type:file|diff|citation, path, patch?, seq}
artifact.updated    {runId, artifactId, patch}
diff.created        {runId, artifactId, path, beforeHash, afterHash, additions/deletions}
run.completed       {runId, finalResponse, usage:{prompt,completion,total}, cost, traceId}
run.failed          {runId, code, message, failedStep, retryable}
run.cancelled       {runId, requestedBy, atStep}

All events: {eventId uuid, runId, channelId, type, payload jsonb, seq bigserial (global order), parentSeq?, correlationId, traceId, timestamp, idempotentKey}
Durable write → Postgres (BRIN runId,seq) + emit to room(channelId) + OTel span link.
Replay: GET /api/runs/:id/events?afterSeq=N&limit=100 — ordered, idempotent (client dedup by seq), correlated (traceId), traceable (OpenTelemetry).
```

### Target Permission Model

Hierarchy (lowest wins: DENY > ASK > ALLOW), evaluated per `ToolExecutionContext`:
```text
Global Policy   (config, env, default deny for execute_bash/write outside sandbox)
  ↓
Organization / Workspace Policy (workspaceSettings.permissions read/write/execute/network, mountAgent maxAgents 8)
  ↓
Project Policy (repo root allowlist, network domain allowlist, file glob allowlist *.md/*.ts)
  ↓
Runtime Policy (allowToolCalls/allowSpawn  ContextAssembler:36-40, ToolSchemaMiddleware tool list)
  ↓
Agent Policy (authorityLevel + isOmniscient + skill-resolved toolkitModule.tools, capabilities)
  ↓
Subagent Policy (inherits min(parent, tool.required) + job-scoped override, no escalate)
  ↓
Tool Policy (definition authLevelRequired + dangerLevel safe/moderate/dangerous, timeout)
  ↓
Command-level (Guard blacklist → allowlist; bash command parser, shell:false)
  ↓
Path-level (path-guard.ts traversal check + sandbox root allowlist per workspace, symlink resolve)
  ↓
Domain-level (mcp HTTP url allowlist per workspacePermissions.network false default)
  ↓
Per-Request Override (runtimeOverrides instructionPatch/permissionPatch TTL, approval grant expiresAt)
```

Effective decision per tool call:
```text
if DENY at any level → deny (throw Security breach ToolExecutor:45-58)
else if ASK at any level → emit approval.requested → await grant/deny (TTL 5min) → cache grant per session
else → ALLOW (execute with timeout 30s + signal, emit tool.started→completed, log audit)
Audit: approval_requests table {id, runId, toolName, command, path, requestedBy, status, grantedAt, expiresAt, grantedBy}
```

---

## Migration Roadmap

### Phase 0 — Instrument (Week 0, no behavior change, low risk)

- **Objectives:** Make system measurable before changing it.
- **Changes:** Add `process.hrtime`/`perf_hooks` timers in `ContextPipelineManager.assemble`, `RuntimeKernel.callLLM`, `ToolExecutor.execute`, `persistMessage`; add OTel SDK (pino + `@opentelemetry/api`) no-op spans; add `durableEvents` stub table + dual-write flag (off by default); add `correlationId` propagation `genReqId → EventBroker emit options`.
- **Dependencies:** None.
- **Risks:** Span overhead ~2% CPU, flag off prevents durability cost.
- **Validation:** `GET /health` shows `timings{assembleP50}`, no perf regression `vitest run` passes.
- **Rollback:** Disable OTel env var, drop `durableEvents` table.

### Phase 1 — Stabilize (Weeks 1-2, P0 security + reliability)

- **Objectives:** Close critical security holes, eliminate zombies, stop work loss.
- **Changes:**
  - Auth: `fastify-jwt` APIKey gate, `preHandler` on all `routes/*`, `origin` allowlist `Shared/config/env.ts:CLIENT_ORIGIN list`, rate-limit `@fastify/rate-limit` 60/min IP + per-agent token budget `TokenTracker:60-88` per-provider.
  - Secrets: migrate `modelModules.apiKey` to `pgcrypto` `encrypt`, `studio.ts:32-37` scrub `omit(apiKey)`, remove `POST /api/workspace/database` `.env` write or restrict `requireAdmin`.
  - Shell: `Guard.validateCommand` allowlist-first (use `isCommandWhitelisted` for bash), `shell:false` `spawn` `mcpClientManager:77`, add `file://` symlink resolve `path-guard:68`.
  - Lease/heartbeat: `UPDATE runtimeStates SET lastHeartbeat=NOW(), leaseExpiresAt=NOW()+30s` in `RuntimeKernel.setAgentStatus` + interval 10s; orphan GC `UPDATE agents SET status='paused' WHERE lastHeartbeat < NOW()-30s`.
  - Broadcast fix: `socket.join(channelId)` `registerSocketServer:141` rooms, add `disconnect` handler.
- **Dependencies:** Phase 0 spans for validation.
- **Risks:** Auth may break existing clients/scripts — provide migration `ANON->API_KEY` map; heartbeat adds DB QPS ~1/10s/agent.
- **Validation:** Pen test CORS/Auth fails without key, `lastHeartbeat` updates observable in snapshot, zombie recovery test `kill -9` → 30s paused.
- **Rollback:** Toggle `ENABLE_AUTH=false` env, heartbeat interval 0 fallback to no-op.

### Phase 2 — Optimize (Weeks 3-4, P1 latency + cost)

- **Objectives:** Half TTFT, halve token cost, unblock Chat low-latency.
- **Changes:** HQ1-HQ7 parallel pipeline, LRU caches (`lru-cache` 5min), clamp, fire-and-forget memory notes, scope to rooms, throttle stream batch `PiEventBridge:39-62` 50ms. Parallel tools `HM1` `allSettled`. Keep fallback env `PIPELINE_PARALLEL=false`.
- **Dependencies:** Phase 1 heartbeat stable.
- **Risks:** Stale cache → permission drift; parallel tool write/write conflict.
- **Validation:** p50 assemble `300→120 ms` measured, multi-tool iter `-50%`, cost `-30%` in `tokenTracker.sum`, `message:stream` CPU -20%.
- **Rollback:** Cache TTL 0 or `PIPELINE_PARALLEL=false`, tools fallback to serial.

### Phase 3 — Unify Runtime (Weeks 5-6)

- **Objectives:** Research/Swarm become real, single ContextService.
- **Changes:** Split `research` off `agenticInstance` `RuntimeExecutor:35` into `ResearchRuntime` (parallel isolated workers → aggregated citations), wire `SwarmRuntime` to `AgentSpawnManager` real logic (switch `WORKSPACE_DIR` to `LocalVFS workspaceRoot`, `FOR UPDATE SKIP LOCKED` batch, DAG param). Merge `MemoryBuilder` legacy `312-380` + new `ContextPipelineManager` into `ContextService` with versioned instructions, fix `type:standard`→`pair_private`, unify `ContextLimitMiddleware` default cap 8000.
- **Dependencies:** Phase 2 caches (research needs isolated context).
- **Risks:** Swarm DAG adds complexity; research citations ranking may be noisy.
- **Validation:** `research` channel tag returns isolated citations artifact not wholesale pages; Swarm `ops` tag spawns 5 workers → `aggregator` → `verifier` end-to-end `dispatch_agent` test passes `AgentSpawnManager:95-118` now real LLM not mock string `366`.
- **Rollback:** `RUNTIME_UNIFIED=false` router falls back to `agenticInstance` alias.

### Phase 4 — Improve Agent Orchestration (Weeks 7-8)

- **Objectives:** Real planner/subagent isolation + verification + resumability.
- **Changes:** Implement Planner cheap-model DAG decomposer, `Subagent` pool `contextWindow 8k` isolated, `Aggregator` MMR + `Verifier` independent model, wire `LoopArbiter:14-53` into `AgenticRuntime` loop, compaction mid-loop `HistoryCompressionMiddleware` with LLM summarizer, `discard_memory` wired.
- **Dependencies:** Phase 3 DAG + Phase 2 caches.
- **Risks:** Verifier may reject valid patches (false positive).
- **Validation:** Agentic 10-iter loop with compaction never exceeds `400 context length`; loop injection test triggers `PAUSED` + escalate deterministically; verifier gate test `mock verifier` catches hallucinated file write.
- **Rollback:** `ORCHESTRATOR_V2=false` uses old single-loop.

### Phase 5 — Upgrade UX (Weeks 9-10)

- **Objectives:** Developer-grade workspace parity with Cursor/Codex/Claude Code.
- **Changes:** Approval card `approval.requested` modal, live progress `agent.progress`, diff viewer `artifacts` diff table `schema:438`, pty terminal `node-pty` streamed `sandbox:stream` `eventTypes:95`, changed files/commit flow via `worktree`, background inbox `Notification` + `run.completed` push, thread branch `POST /api/runs/:id/branch`.
- **Dependencies:** Phase 4 orchestration stable, `durableEvents` from Phase 0/1.
- **Risks:** Worktree clone I/O heavy; terminal escape handling XSS.
- **Validation:** Manual UX benchmark per Goal #22: Codex-style sandbox approval + telemetry, Claude subagent isolate, Cursor terminal/diff loop, OpenCode mode/fork — scorer `Developer UX 4→8`.
- **Rollback:** Feature flags `UX_APPROVALS`, `UX_DIFF`, `UX_TERMINAL` toggle to old chat-only.

### Phase 6 — Scale Swarm / Background Execution (Weeks 11-12)

- **Objectives:** Durable execution at scale — queue partitioning, backpressure, graceful scale.
- **Changes:** Promote in-mem queue to durable `jobs` PG `FOR UPDATE SKIP LOCKED` partitioning by `workspaceId`, worker pool (configurable `maxAgents 8` → `workspaceManager:30` dynamic), priority queue `priority` column, visibility timeout 60s, DLQ, graceful `SIGTERM` drain `index.ts:100-111` (add handler), `closeDatabaseConnection` on shutdown, horizontal scale via multiple Fastify instances sharing PG lock.
- **Dependencies:** All prior phases.
- **Risks:** Lock contention at scale; clock skew on `leaseExpiresAt`.
- **Validation:** Load test 100 concurrent `user:message` → no duplicate seq `23505` beyond handled, worker crash → job requeued within visibility timeout, graceful restart drains 0 lost jobs.
- **Rollback:** `ENABLE_DURABLE_QUEUE=false` falls back to sync `RuntimeExecutor:42` + `in-memory` mode (single instance).

**Per-phase risk matrix:** Phase 0 Low, Phase 1 Medium (auth migration), Phase 2 Low/Med, Phase 3 Med, Phase 4 Med/High, Phase 5 Med, Phase 6 High. Mitigate via feature flags + dark-launch on `workspaceId=canary`.

---

## 36. Definition of Success (To Achieve)

> **One persistent workspace where the user can converse, delegate work, run agents, inspect progress, approve sensitive actions, see code changes, perform research, run parallel agents, receive background results, recover interrupted tasks, and resume work without losing context.**

### Gaps to success (current vs target)

| Principle | Current gap | Target |
|---|---|---|
| **Durable** | In-mem `recentEvents 50`, cannot survive restart | `jobs/runs/runEvents` durable, `closeDb` on SIGTERM, replay `afterSeq` |
| **Observable** | Fastify log + `console.log` per-tool, fake `42MB`, no trace | OTel spans `assemble/llm/tool/persist`, `runId/traceId` correlated, costs reconstructable |
| **Cancellable** | `abortSignal` plumbing disconnected `contextTypes:13` | `AbortController` per-run, propagates to LLM fetch + tools + subagents, `CANCELLING→CANCELLED` |
| **Resumable** | `ctx_Date.now` random, no checkpoint, no fork | `parentRunId + checkpointSeq` → `retry from failed step / replay / branch` |
| **Parallel** | Serial pipeline + serial tools, 3 agents sequential | Parallel middlewares + `Promise.allSettled` tools + 5-worker DAG + throttled stream |
| **Permission-aware** | `dangerLevel` binary, blacklist bypassable | `ALLOW/ASK/DENY` × 9 levels, auditable grants, reusable TTL |
| **Cost-aware** | `ceil(len/4)` fake, per-provider budget ignored, no cheap routing | Real usage parsed, `costPer1k` per `modelModules`, cheap vs verifier model |
| **Model-agnostic** | 5 adapters exist, but model chosen via stale `modelModules` cache miss | Model Router complexity→model (fast/cheap vs high-reasoning), keepAlive reuse |
| **Runtime-agnostic** | aliased `research`, stub `swarm` | 5 runtimes real + uniform Engine + Router priority `explicit > classifier > tag > level` |
| **Extensible** | `toolRegistry` Map, MCP stdio newline JSON | `dynamicTools` wired + MCP spec framing + `watcher` + `skillService` invalidation |
| **Secure** | `origin:true`, no auth, plaintext keys | JWT + allowlist + `pgcrypto` + `shell:false` + domain allowlist |
| **Fast** | 300 ms assemble + 1-2s TTFT dominated by serial | 120 ms assemble + 800 ms TTFT + throttled stream TTFT, no hot-path memory write |
| **Developer-friendly** | Chat box + tool output strings | Chat + IDE diff + pty terminal + swarm board + thread branching + audit |

**Quality interaction primitives (vs imitating UI):** The goal is not to clone Cursor's diff view or Codex's sidebar verbatim, but to achieve the same primitives: safe-by-default sandbox, explicit lease ownership, configurable network boundaries, specialized subagent contexts, parallel execution with backpressure, session forking, durable event replay.

**Final checklist before declaring success:**
- [ ] `user:message` survives process kill (job lease, replay) — tested `failure mode analysis` 12 scenarios (#25 table) all Detect→Persist→Inform→Recover→Resume→Retry→Idempotent→Observable→UX.
- [ ] `chat→agentic→coding→research→swarm` transitions observable reversible `RUNTIME_MATRIX` green.
- [ ] Approvals `ASK` → `grant/deny` auditable, reusable, not repetitive.
- [ ] Swarm `Supervisor→Workers→Aggregator→Verifier→Result` `AgentSpawnManager` real LLM, no mock `export function runTask()` `366`.
- [ ] Artifacts `diff.created` + citations + `tool.output` stream visible; final state not “reconstruct from raw logs”.
- [ ] Tokens/cost per run traceable, budget enforcement per-provider.
- [ ] Security boundaries runtime-enforced, not UI-only (sandbox, network, approval).

---

## Appendices

### A. System Inventory (abbreviated — full table in subagent dump `*.local/share/opencode/tool-output/tool_037...`)

| Domain | Component Location | Purpose | State | Failure | Risk |
|---|---|---|---|---|---|
| Entry | `index.ts:1-111` | Fastify bootstrap, CORS, VFS bootstrap | In-mem app + DB | `exit(1)` no SIGTERM | SPOF single process |
| Config | `Shared/config/env.ts:1-12`, `database.ts:1-63` | `DATABASE_URL`, `postgres` singleton `prepare:false` | Singleton globals | no retry/pool tuning | no pgVector call at boot |
| DB | `db/schema.ts:1-822` 30 tables | agents/channels/messages/workspaces/nodes/memories/skills/mcp | PG durable | FK cascade deletes | `modelModules.apiKey` plaintext, `embeddingModelProfiles` unused |
| API | `routes/index.ts:1-31` 11 plugins | REST CRUD agents/modules/skills/mcp/VFS/channels | PG | Zod 400 via `errors.ts:5-37` | no rate-limit/quotas/CORS allow-all |
| Socket | `Shared/sockets/registerSocketServer.ts:1-336` | `Server({cors:true})`, `onAny→io.emit`, `snapshot 15s`, `user:message` pipeline | ephemeral | intervals leak, no disconnect cleanup | privacy bleed, no durability |
| Broker | `EventBroker/eventBroker.ts:1-98` | `emit/onAny recent 50`, `eventTypes.ts:79-126` 30 types | memory | `off` safe | no durability/seq |
| Runtime | `runtime/*` | Router→Executor→Kernel→ReActParser→ProviderRegistry(5 adapters SSE) | per-request | `catch→failed` fallback to agentic | serial long request |
| Context | `runtime/kernel/ContextPipelineManager:29-42` | 10 middlewares Identity→Compression | per-request | swallowed error `117-118` | sequential, no cache |
| Agents | `Agents/agentService:58-268`, `agentSpawnManager:46-501` | Registry + mock spawn batches 5 | PG | retry escalate mock | Windows hard path |
| Tools | `tools/toolRegistry:48-700` 16 + `ToolExecutor:88-102` | Registry + authorize+timeout 30s race | memory+PG | success:false not throw | leak after race, blacklist |
| MCP | `tools/mcp/mcpClientManager:73-269` | `spawn shell:true`, newline JSON `tools/list/call` | mem sessions | stderr warn | shell injection, sse not impl |
| VFS | `vfs/local-vfs:77-336`, `path-guard:10-73`, `Guard:24-43` | `workspaceNodes` sync, traversal check | PG+FS `sandbox/` | ENOENT 404 | bypass via backup names |
| Workspace | `Workspace/workspaceManager:30,194` `maxAgents 8`, `permissionGuard:34-77` | mountAgent quota, VFS permissions read/write/execute | `ws.settings.json` | quota throw | `.env` mutate |
| Memories | `Memories/memoryRetrieval:74-93`, `agentMemoryStore` | Multi-lane retrieval, preview block injection | PG | `topK10` no threshold | no embedding wire |
| Client | `client/src/App.tsx:96-157`, `socket.ts:1-9`, `Stores/*` | 3-panel, Zustand hash sync, composer mentions/file drag | browser memory | lazy fallback null | no diff/terminal |

*Full inventory per Goal #2 requested table `Component|Location|Purpose|Owner|Boundary|Dependencies|Runtime|State|Failure|Observability|Risk` — generated by subagent, 300+ rows, tagged Observed…Opportunity.*

### B. Anti-Patterns Detected (Goal #29)

Checked each — ✅ present = observed violated:
- giant monolithic agent loop — ✅ `AgenticRuntime:28-174` inline 10-iter loop with tool handling mixed
- frontend-driven orchestration — ✅ socket handler awaits `runtimeGate.execute` `registerSocketServer:227`
- runtime-specific duplicated logic — ✅ `modelRouter.ts` duplicate Google endpoint `GoogleAdapter:178-196`
- implicit state machines — ✅ `if (!runtime) fall back agentic` `RuntimeExecutor:57`
- unbounded recursion/spawning — ✅ L2 spawn no counter
- synchronous long-running requests — ✅ socket `await execute`
- polling where streaming appropriate — ✅ snapshot 15s `registerSocketServer:165` vs events
- duplicated context — ✅ `MemoryBuilder:315-379` vs `VisibilityMatrix` re-read
- duplicated model calls — Inferred on `LibrarianRuntime:124-195` per channel
- excessive tool chatter — ✅ tool result `🛠️` persisted + re-sent verbatim
- raw tool output copied to context — ✅ `AgenticRuntime:164-169` no clamp
- fragile retries — ✅ `Promise.race` timeout leak `ToolExecutor:88`
- non-idempotent jobs — ✅ sequence race handled but duplicate content still creates new row
- missing cancellation — ✅ signal disconnected `contextTypes:13`
- missing timeouts — ✅ provider fetch no timeout
- hidden permissions — ✅ `apiKey` plain leak
- global mutable agent state — ✅ `agents.status` global race
- shared context leakage — ✅ Research shares channel `AgenticRuntime` loop
- agent state only in memory — ✅ `localHistory` in-memory Agentic loop, `recentEvents 50` memory
- browser disconnect killing work — ✅ not durable but also not killed (unstable middle)
- tasks cannot resume — ✅ no checkpoint
- no durable identity — ✅ `ctx_Date.now` `ContextPipelineManager:126` not durable
- no correlation IDs — ✅ `requestId` not emitted as event field
- no audit reconstruction — ✅ `runEvents` missing, `tokenUsageLog` not written via runtime
- unclear task ownership — ✅ `leaseOwner` missing
- no backpressure — ✅ `onAny→io.emit` unconstrained
- queue starvation — Missing queue entirely
- retry storms — Risk if L2 repeatedly spawns
- zombie jobs — ✅ `working` forever on crash
- orphaned workers — ✅ `agentSpawnManager:188` `ch-pair-` left on crash
- model/provider coupling — ✅ `modelModules` lookup per request no router abstraction
- UI tightly coupled to backend internals — ✅ `workspace:sync` polls full `fetchWorkspaces` on any `agent:spawned`

### C. Testing Strategy Audit (Goal #30)

- **Unit:** Coverage present minimally — `runtime/kernel/contextPipeline.test.ts`, `ReActStreamParser.test.ts`, `runtimes/CodingRuntime.test.ts`, `AgenticRuntime.test.ts`, `runtimeLifecycle.test.ts` — stateTransitions tested partially; permission/route/retry/context/adapter missing.
- **Integration:** runtime execution tested via spawn `simulated` not real LLM; no DB `queue` integration, no MCP integration test, no streaming `SSE` integration.
- **E2E:** `e2e/`, `playwright.config.ts` — but Chat/Agentic/Coding/Research/Swarm e2e not wired to real provider (mock `web_search` hard-coded `toolRegistry:270-273`).
- **Failure/recovery:** No disconnect/restart/timeout/cancellation/worker-failure/tool-failure/model-failure tests (Goal #25 table all Missing).
- **Performance:** No latency/concurrency/throughput/memory/token/cost perf harness.
- **UX:** No task visibility/approval/progress/resume/error handling automated tests (`stores/modeStore.test.ts` only trivial).
- **Recommended priority P0 tests:** `auth gate 401`, `sequenceNumber race retry`, `abortSignal propagation cancel`, `heartbeat zombie → paused`, `parallel tool ordering`, `permission ALLOW/ASK/DENY matrix`, `event replay afterSeq`, `usageMetadata real vs ceil`, `Guard traversal bypass attempt`.

### D. File Evidence Index (absolute, key)

- `C:\Users\Asus\Documents\GitHub\.ThisCrowd\packages\server\src\index.ts:1-111` — entry
- `packages/server/src/routes/index.ts:1-31`, `routes/workspace.ts:165-185` — .env mutate
- `.../Shared/config/database.ts:1-63` — postgres singleton
- `.../db/schema.ts:1-822` — enums/tables, `modelModules:46-62`, `runtimeStates:112-123`, `spawnRequests:250-261`
- `.../Shared/sockets/registerSocketServer.ts:1-336` — socket orchestration, `107 mem 42`, `141-143 io.emit`, `173-332 user:message`
- `.../EventBroker/eventBroker.ts:1-98`, `eventTypes.ts:79-126` — in-mem broker
- `.../runtime/RuntimeRouter.ts:12-46`, `RuntimeExecutor.ts:22-84` (research alias `35`)
- `.../runtime/kernel/RuntimeKernel.ts:17-232` — callLLM stream `25-52`, persist retry `115-145`, `buildUserPrompt:228-231`
- `.../runtime/kernel/ContextPipelineManager.ts:29-42,113-123`, `ContextAssembler.ts:21-65`, `runtimeGate.ts:1-125`
- `.../runtime/runtimes/ConversationalRuntime.ts:8-89`, `AgenticRuntime.ts:12-207`, `CodingRuntime.ts:12-232`, `SwarmRuntime.ts:8-58`
- `.../runtime/providers/GoogleAdapter.ts:20-282`, `AnthropicAdapter.ts:1-219`, `ProviderRegistry.ts:1-27`
- `.../runtime/bridges/PiToolBridge.ts:15-224`, `PiEventBridge.ts:14-141` — coding pi bridge
- `.../Agents/agentService.ts:58-268`, `agentSpawnManager.ts:1-501` (hard path `21`, mock code `366`, retries `322-459`)
- `.../tools/toolRegistry.ts:48-700` (16 tools), `ToolExecutor.ts:1-119` (auth `54-59`, timeout `88-102`), `safety/Guard.ts:10-73` (blacklist `49-61`)
- `.../tools/mcp/mcpClientManager.ts:1-269` — stdio spawn `shell:true` `77-81`
- `.../vfs/local-vfs.ts:1-336`, `vfs/path-guard.ts:10-73`
- `.../Workspace/workspaceManager.ts`, `permissionGuard.ts`, `workspaceTypes.ts`
- `.../Memories/memoryRetrieval.ts:74-93`, `agentMemoryStore.ts`
- `.../client/src/App.tsx:96-157`, `config/socket.ts:1-9`, `Specs.md` — UX spec
- `.../types/runtime.types.ts`, `runtime/types.ts:156-163` — observer/orchestrator dead types
- `.../Shared/core/LoopArbiter.ts:1-86`, `Shared/core/tokenTracker.ts:60-88` — never called / sum scan

---

## Deliverable Checklist (Goal #31)

- [x] **A Executive Verdict** — scores 10 dimensions + strongest/weakest/risks/opportunities
- [x] **B Runtime Matrix** — 6 runtimes `Exists|Quality|Strength|Defect|Priority`
- [x] **C Architecture Diagram** — current implementation-grounded + target
- [x] **D Lifecycle State Machine** — current 7/22 + recommended 22-state durable
- [x] **E Pipeline Bottleneck Report** — 6 with Evidence/Root/Impact/Fix/Improvement/Risk
- [x] **F Agent Architecture Report** — hierarchy/delegation/context/concurrency/failure + target
- [x] **G UX Gap Analysis** — `Capability|Current|Target|Gap|Priority` 14 rows + primitives vs Codex/Claude/Cursor/OpenCode/Antigravity/Discord
- [x] **H Backend Optimization Plan** — Quick (7) / Medium (6) / Strategic (6) with Impact/Effort/Risk/Dependency/ROI
- [x] **I Priorities P0/P1/P2/P3** — P0 6 critical + P1 8 + P2 6 + P3 5 table
- [x] **32 Target Architecture** — conceptual modified diagram
- [x] **33 UX Target State** — coding, long-running, swarm flows
- [x] **35 Top 10s** — Problems/Opportunities/UX/Backend + Target Models (Runtime/Agent/Lifecycle/Event/Permission) + Roadmap Phases 0-6 with objectives/changes/deps/risks/validation/rollback

*All sections per AGENTS.md Domain Facade Standard: Gate is contract. Audit verified facade compliance: imports via `*Gate.ts` observed correct except legacy `MemoryBuilder` vs pipeline split — noted in risks.*

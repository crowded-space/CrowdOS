# CrowdOS — System Specification (Post-Phase 7)

> **Source of truth:** `REMEDIATION_SPEC.md` v1.0 (2026-08-26) + `Goal.md` §§1–36.  
> **Generated:** Aug 2026 after Phases 0–7. Replaces stale `packages/client/Specs.md` snapshot (client-only) and reconciles `DEVELOPMENT_BOARD.md` vs `execution-plan/`.

## 1. Architecture Overview

```
Client (React 19 + Zustand + Socket.io)
  ↓  HTTP + WS (CORS allowlist, token-bucket)
Fastify 5 (Pino, correlation id, Zod, rate-limit)
  ↓  authGate (api_keys, roles)
EventBroker (typed, durable_events, replay)
  ↓  ContextAssembler (10 middlewares, parallel lane PIPELINE_PARALLEL)
    → modelRouting (MODEL-1 tiers) → Provider adapters (5) → TokenTracker (O(1) ledger + reconciler)
    → ToolExecutor (Guard + process-group kill + approvals) → Artifacts (diff/report/citations)
  ↓  RuntimeExecutor (router → Conversational/Agentic/Coding/Research/Swarm)
  ↓  Queue (BullMQ: runs/maintenance/scheduler, idempotency channel:agent:message, 15m lease, 7d DLQ) + Runs (17-state machine, checkpoint + compensation)
  ↓  Swarm (DAG swarm_tasks + aggregator + verifier,Delegations depth≤2) / Research (Brave/Tavily/Serper evidence bundle)
  ↓  VFS (LocalVFS, 10s LRU) + Memories (pgvector hybrid, cap 500) + Observability (OTel spans runId-keyed + cost ledger)
  ↓  Postgres 16 + Redis 7
```

**Gated domains (18):** `Agents`, `Approvals`, `Artifacts`, `Channels`, `EventBroker`, `Memories`, `Messages`, `Modules`, `Observability`, `Queue`, `Runs`, `runtime`, `SearchProviders`, `Skills`, `Swarm`, `tools`, `vfs`, `Workspace` — enforced via `scripts/check-gates.mjs` (dynamic discovery) + `check-redaction.mjs` + `check-events.mjs` in CI.

## 2. Runtime Model

| Runtime | Exists | Quality | Strength | Defect | Priority |
|---|---|---|---|---|---|
| Chat | ✓ | high | TTFT via stream coalescing (50ms), 17-state cancel, reconnect digest | — | — |
| Agentic | ✓ | high | ReAct loop, tool R/W classifier, per-iteration budget, checkpoint/resume | — | — |
| Coding | ✓ | high | PiCore loop + VFS + diff artifacts, real `process.cwd()` sandbox | PiBridge still env-complete not allowlist | P2 |
| Research | ✓ | v1 | Isolated sub-runs, evidence bundle deduplicated + synthesized cited report, raw never leaks to parent | Sub-runs inline not yet BullMQ durably queued | P2 |
| Swarm | ✓ | v1 | DAG `swarm_tasks`, leaf workers (BullMQ leases), aggregator dedupe, verifier gates COMPLETED, partial-failure honest | Linear chains first, fan-out second | P2 |

All route via `RuntimeRouter` (explicit `explicitRuntime` or `composerMode` tag) → `RuntimeExecutor` (pins research→agentic when `RESEARCH_V1=false`, swarm→agentic when `SWARM_V1=false`).

## 3. Lifecycle State Machine (Goal §D target, RUN-1)

```
CREATED → QUEUED → STARTING → RUNNING ⇄ WAITING_FOR_TOOL / WAITING_FOR_APPROVAL → RETRYING / COMPACTING → COMPLETING → VERIFYING → COMPLETED | FAILED
                                          ↘ CANCELLING → CANCELLED
                                          ↘ ORPHANED → RESUMABLE → (resume) QUEUED ...
```

- **17 states:** created, queued, starting, running, waiting_for_tool, waiting_for_approval, retrying, compacting, completing, verifying, completed, failed, cancelled, cancelling, orphaned, resumable (+ queued)
- **Guards:** `Runs/runStateMachine.ts:26` `TRANSITIONS` map, terminal immutable (`completed`/`failed`/`cancelled` no outgoing except noop), every hop emits `run.status_changed{from,to,reason,runId}`.
- **Orphan:** `ORPHAN_AFTER_MS=60s` heartbeat sweeper (`agentHeartbeat`) flips `running` + stale `lastHeartbeat` → `orphaned` → `resumable`.

## 4. Event Model (Goal §16, CTX-1)

**32 declared** (`EventBroker/eventTypes.ts:159`, `shared/events/runtime-events.ts:32`):

`agent:status`, `message:new`, `message:stream`, `agent:thinking`, `agent:spawned`, `agent:despawned`, `agent:paused`, `agent:resumed`, `strike:initiated`, `runtime:snapshot`, `sandbox:updated`, `swarm:created/updated/terminated` (whitelist), `escalation:created`, `budget:warning/exceeded`, `workspace:sync`, `tool:start/complete`, `run.status_changed`, `run.queued`, `run.compensations`, `index:degraded`, `scheduled:triggered`, `approval.requested/decided`, `delegation:start/completed`, `artifact.created`, `diff.created`, `artifact.updated`

- **Envelope:** `{eventId, seq, timestamp, type, payload}` (EVT-0). Live `seq=null`, replay carries persisted `seq`.
- **Durable:** non-ephemeral via `durable_events` (bigserial, `durable_events_channel_seq_idx`), dual-write fire-and-forget, 24h retention, replay `GET /api/events/recent?channelId&afterSeq&limit`.
- **Client:** `unwrapEnvelope` prefers `payload`, `persistSeq` caps per-channel cursor, `while-away` digest.

## 5. Persistence & Resume (Goal §15)

- **Conversation ≠ execution ≠ event log ≠ agent state ≠ artifact:** separate tables (`messages` + `runs` + `durable_events` + `runtime_states` + `artifacts` + `agent_memory_notes`).
- **Checkpoint:** `runs.checkpoint {watermarkSeq, completedCallIds, historyRef, updatedAt}` touched per tool boundary.
- **Resume:** `POST /api/runs/:id/resume` or `socket run:resume` re-enqueues from watermark, skips completed calls. Orphaned `RUNNING` → `RESUMABLE` via sweep, then `RESUMABLE → QUEUED → STARTING → RUNNING`.
- **Compensation:** `runs_compensation` inverse ops (`delete`/`restore` + `priorHash`) surfaced `run.compensations` banner with `run:compensations:list`/`run:compensation:undo`.

## 6. Observability & Cost (Goal §17, SCL-3)

- **Logs:** `Shared/core/structuredLog.ts` JSON + `redact.ts` (no `[perf]` prose).
- **Metrics:** `Shared/core/perfMetrics.ts` p50/p90/p95/p99 per `stage` (`context.assemble`, `llm.call`, `tool.execute`, `persist.message`, `trace.*`, `token.cost`) — `GET /metrics` (admin).
- **Traces:** `Observability/tracing.ts` OTel-compatible spans `assemble`/`llm`/`tool`/`persist` keyed `runId` (dynamic `@opentelemetry/api` when `OTEL_ENABLED`), `GET /api/observability/trace/:runId` reconstructs any run.
- **Cost ledger:** `token_usage_log (run_id) × model_modules.cost_per_1k` → `cost_ledger_per_run` view, `GET /api/observability/cost/dashboard` (±1% `verifyLedgerAccuracy`), `GET /api/observability/cost/ledger?runId`.

## 7. Security & Permissions (Goal §18)

- **Auth:** `api_keys` scrypt, `AUTH_STRICT=true` default-deny (roles admin>operator>viewer), legacy `AUTH_TOKEN` only when `false`. `docker-compose.yml` now `AUTH_STRICT=true`. Handshake `socketAuth` verifies key, `x-user-id` spoof ignored.
- **Rooms:** `canJoinChannelRoom` / `canJoinWorkspaceRoom` existence check (no `workspace:default` mirror), disconnect leaves rooms (no cancel).
- **Guard:** `Guard.ts` deny pipe-to-shell, interpreter one-liners (`python -c`, `perl -e` …), `find -exec`, `shred`, `.env` variants; `validatePath` anchored + `realpath` symlink escape; `execFile` + process-group kill; timeout via `AbortController`; env allowlist (mcp pattern).
- **Secrets:** `secretBox` AES-256-GCM `enc:v1:` envelope, `CREDENTIALS_ENCRYPTION_KEY` (hex/base64/passphrase), single `redactLogPayload` lint.
- **MCP:** `mcpClientManager` per-server `defaultDangerLevel`/`requiredEnvVars`, `shell:false`, pending reject on exit, Content-Length framing.

## 8. Prompt & Context (Goal §19, CTX-2)

- **Precedence:** `constraints (10) > instructions (15) > persona (IdentityAuthority 20) > history` — enforced by block order + test.
- **Wrapping:** `<untrusted source="…">` for history/roster/memory hooks; `reflectionSanitizer` strips control/blocklike; `SOURCE-INTEGRITY` canonical once.
- **InstructionStack:** deterministic `orderBy priorityOrder`, scoped `replace` by module id, expiry sweep.

## 9. UX Target (Goal §33)

**Sync:** `user → plan → run:queued → tool approvals? → live streaming + delegation timeline + diff viewer → verify → artifact + cost → persist → resume/fork`

**Background:** `start → close tab → worker keeps running (no cancel) → notification → reopen → replay gap (afterSeq) + digest`

**Swarm:** `Supervisor (LLM plan) → DAG leaf workers (BullMQ leases, heartbeats) → aggregator (dedupe/conflict) → verifier (goal+artifact) → COMPLETED honest X/Y`

All UX ships with Playwright journeys (`e2e/*.spec.ts`: chat, agentic tools, coding diff UX-3, approval UX-2, resume UX-5, swarm timeline UX-6, perf pagination) — see `TST-4`.

## 10. Configuration Flags (§13 registry)

45 flags in `Shared/config/env.ts` zod schema, fail-fast, redacted report. Key:

`AUTH_STRICT`, `QUEUE_MODE`, `SWARM_V1`/`SWARM_LEGACY`, `APPROVALS_ENABLED`, `RESEARCH_V1`, `DELTA_INDEX`, `PER_ITERATION_BUDGET`, `DEMO_FALLBACK`, `OTEL_ENABLED`, `EMBEDDING_ENABLED`, `PIPELINE_PARALLEL`, `STREAM_BATCH_MS`, `ORPHAN_AFTER_MS`, `TOOL_RWP`, `MODEL_ROUTE`, `CREDENTIALS_ENCRYPTION_KEY` etc. — generated docs via `npm run gen:env-doc` → `docs/environment.md`.

## 11. Validation Strategy (per phase §14)

Each phase closes with: (a) suite + acceptance tests green on clean containers; (b) Goal §25 failure drill; (c) metrics snapshot archived; (d) flag flip rollback rehearsal.

**Definition of Done (whole program):** Goal §36 checklist (durable, observable, cancellable, resumable, parallel, permission-aware, cost-aware, model-agnostic, runtime-agnostic, extensible, secure, fast, developer-friendly) — evidenced by SCL suites and zero OPEN audit items (V1+V2 traceability matrix).

---

*Spec snapshot: post-Phase 7, verified `npm run typecheck && npm run lint:gates && npm test && npm run build` on postgres:16 + redis:7.*

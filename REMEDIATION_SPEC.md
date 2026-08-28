# CrowdOS Remediation Specification

**Version:** 1.0 · **Date:** 2026-08-26 · **Status:** Approved
**Sources:** `AUDIT_REPORT_2026-08-26.md` (V2), `TO DO/AUDIT_REPORT.md` (V1, 2026-08-25)
**Approved decisions:** Durable execution = **Redis + BullMQ** · Swarm = **build real v1** · Auth = **key-based now (users table later)** · Packaging = **this master spec**

---

## 1. Ground rules

1. **Gate standard holds.** Every new capability lands as a gated domain (`Queue/queueGate.ts`, `Runs/runsGate.ts`, `Approvals/approvalGate.ts`, `Swarm/swarmGate.ts`, …). Nothing outside a domain imports its internals. `check-gates.mjs` is extended to cover ALL domains under `packages/server/src` and runs in CI.
2. **Flags before risk.** Every behavior-changing item ships behind an env flag with a safe fallback. Flag registry in §11.
3. **Incremental only.** No rewrites of working subsystems. The existing kernel/pipeline/broker/provider seams are preserved; we fill gaps and fix wiring.
4. **Every item has:** evidence refs → change spec → acceptance criteria → rollback → deps → estimate.
5. **Two-process future.** From Phase 4 the server runs as `api` + `worker` processes sharing Postgres + Redis. All timers that behave like jobs migrate to BullMQ repeatable jobs.
6. **Honesty invariant.** Any feature that cannot be made real in its phase is hidden (router/UI), never simulated. Mock fallbacks require an explicit `DEMO_FALLBACK=true`.

Estimates are single-engineer working days. Total ≈ **46 days** across Phases 0–6; Phase 7 ongoing.

---

## 2. Traceability matrix (audit finding → spec item)

Legend: status as of 2026-08-26. `FIXED` = verified resolved; `PARTIAL` = improved, residual tracked; `OPEN` = untouched.

### From V1 (`TO DO/AUDIT_REPORT.md`)

| V1 ID | Finding | Status | Spec item(s) |
|---|---|---|---|
| P0-1 | No authn/authz, `origin:true` | PARTIAL (allowlist + authGate landed; open-by-default remains) | SEC-1, SEC-2 |
| P0-2 | Plaintext secrets, emitted keys, `.env` HTTP write | PARTIAL (redaction + admin gate landed) | SEC-4 |
| P0-3 | No durable execution / work lost on restart | OPEN | QUE-1…3, RES-1 |
| P0-4 | Zombie `working` agents, heartbeat never written | FIXED (agentHeartbeat toucher+sweeper) | residual → RES-1 |
| P0-5 | Shell blacklist bypassable | PARTIAL (deny/ASK lists expanded; new escapes found) | SEC-3 |
| P0-6 | Broadcast privacy bleed (`io.emit` all) | PARTIAL (rooms + durable_events exist; `workspace:default` mirror still leaks) | SEC-2 |
| HQ1 | Serial context pipeline | FIXED (`PIPELINE_PARALLEL`) | — |
| HQ2 | No caching | FIXED (TtlCache); residual unbounded loads | PERF-2 |
| HQ3 | Blocking memory-note writes | FIXED (fire-and-forget) | — |
| HQ4 | Secrets in logs/responses | PARTIAL (console.log sites bypass redaction) | SEC-4 |
| HQ5 | Fake `memoryUsedMb:42`, hardcoded Windows path | FIXED (real process metrics; env-based dir) | — |
| HQ6 | Room scoping | PARTIAL | SEC-2 |
| HQ7 | Unbounded context/tool output | FIXED (clamp+cap); residual per-iteration budget | PERF-3 |
| HM1 | Serial tool execution | PARTIAL (parallel-safe batch only; no r/w classifier) | PERF-8 |
| HM2 | AbortSignal end-to-end | PARTIAL (cancel works chat/agentic/swarm; not coding loop/PiBridge; no timeouts) | CAN-1 |
| HM3 | Durable events + replay | PARTIAL (server done; envelope stripped; client never consumes) | EVT-0, UX-5 |
| HM4 | AuthN/Z gate + rate limit | PARTIAL | SEC-1, SEC-5 |
| HM5 | Pool tuning / keep-alive | PARTIAL (pg pool tuned; fetch keep-alive absent) | PERF-9 |
| HM6 | Cost-aware model routing | OPEN | MODEL-1 |
| HS1 | Durable job primitive | OPEN (superseded by approved BullMQ choice) | QUE-1…3 |
| HS2 | Real SwarmRuntime | OPEN | SW-1, SW-2 |
| HS3 | Research isolated subagents | OPEN | RT-1 |
| HS4 | Artifact/diff service, git flow | OPEN | ART-1, UX-3 (stretch: ART-2) |
| HS5 | OTel + cost dashboard | OPEN | SCL-3 |
| HS6 | Unified ContextService + injection escaping | OPEN | CTX-2 |
| P1-6 | Terminal/pty streaming | OPEN (stretch) | UX-TERM |
| P2-1 | VFS stat N+1, index text-filter search | PARTIAL | PERF-2, UX-8 |
| P2-2 | `discard_memory_from_context` no-op | OPEN | MEM-2 |
| P2-3 | Fake token accounting | FIXED (real usage parsed in adapters) | verify pi path in CAN-1 |
| P2-4 | Precedence ambiguity, cap-after-compression | OPEN | CTX-2, PERF-3 |
| P2-5 | Search/pin/thread/branch UX | OPEN | UX-8, UX-9(stretch) |
| P2-6 | Rate limiting absent | OPEN | SEC-5 |
| P3-1 | Dead observer/orchestrator types | OPEN | RT-5 |
| P3-2 | Dual LoopArbiter files | PARTIAL (re-export alias; delete) | HYG-2 |
| P3-3 | LoopArbiter never called; naive summaries | OPEN | RT-3, RT-4 |
| P3-4 | `dynamicTools` unused; MCP newline-JSON framing | OPEN | SEC-6, DB-1(disposition) |
| P3-5 | Full-table SUM token scan | OPEN | PERF-4 |

### From V2 (`AUDIT_REPORT_2026-08-26.md`) — new findings

| V2 finding (evidence) | Spec item(s) |
|---|---|
| Bootstrap DDL drift; fresh installs lack `durable_events`; migrations dir empty | DB-1 |
| `find -exec`/npm-script ALLOW RCE; sibling-path prefix bug `Guard.ts:32`; symlink escape; coding sandbox = `process.cwd()`; PiToolBridge bypasses ToolExecutor | SEC-3 |
| No runs entity; crash loses runs; restart-from-scratch only | RUN-0/1, QUE-*, RES-1 |
| `activeRuns` overwrite strands cancel handles; abort never reaches pi-core loop/PiBridge tools | CAN-1 |
| Conversation≠execution conflation; tool structure recovered by emoji-string regex | DB-5 |
| 14+ dead event types; phantom handlers; undeclared `strike:initiated`; duplicate RuntimeEvents const | CTX-1 |
| Envelope stripped at socket boundary; perfMetrics console-only | EVT-0, OBS-1 |
| `agent:spawned` payload mismatch → garbage roster rows; client never emits `user:cancel`/`channel:join`; replay endpoints unconsumed | UX-6, UX-1, UX-5, EVT-2 |
| Silent-skip tests; vacuous gate test; Playwright finds 0 specs; suite gitignored; no CI | CI-1, TST-1…7 |
| Second-order prompt injection via reflection notes; triple-duplicated safety rules | CTX-2 |
| Librarian fabricates summaries on failure; quadratic reindex | DB-3, PERF-4 |
| InstructionStack `replace` wipes stack nondeterministically | CTX-2 |
| HistoryCompression `findFirst` no orderBy → stale summary | RT-4 |
| Memory: `suppress_until` never enforced; O(n) note-ID scan; creates unlogged | MEM-1 |
| Sequence races on socket path; non-transactional multi-writes | DB-2 |
| Pair-channel/spawn artifact hard-delete destroys audit trail | DB-3 |
| Fake tools (`query_database`, `web_search`, `system_scheduler`) | TOOL-1 |
| MCP force-labeled safe; silent env-var drop; pending calls not rejected | SEC-6 |
| `artifacts` table never written; snapshots dir unused | ART-1 |
| pgvector installed, zero vector columns | SCL-2 |
| README/board/checklist contradictions; junk artifacts committed | HYG-1, DOC-1…3 |

---

## 3. Phase 0 — Instrument & guardrails (≈3d)

### CI-1 · CI pipeline
- **Evidence:** No `.github/`; `npm run test:e2e` discovers 0 specs; tests gitignored (commit 2026-08-19).
- **Change:** `.github/workflows/ci.yml`: install → typecheck → lint → `node scripts/check-gates.mjs` → vitest (Postgres+Redis service containers) → build → Playwright smoke (Phase ≥6 only until specs exist). Required status check on PR.
- **Accept:** Green run on clean checkout with only `.env.example` vars + service containers.
- **Rollback:** Disable workflow. **Deps:** none. **Est:** 1d.

### OBS-1 · Metrics endpoint & structured logs
- **Evidence:** `perfMetrics.getMetricsSnapshot()` computed, flushed console-only (`perfMetrics.ts:82-91`); `[perf]` prose logs (`RuntimeKernel.ts:53,188`).
- **Change:** `GET /metrics` (admin role) returning snapshot JSON; replace prose logs with pino child loggers `{stage,durationMs}`.
- **Accept:** curl shows context.assemble/tool.exec p50/p95; no `[perf]` lines in output.
- **Rollback:** route behind flag. **Deps:** SEC-1 (roles). **Est:** 0.5d.

### EVT-0 · Event envelope preservation
- **Evidence:** `registerSocketServer.ts:206` emits `event.payload` only; eventId/timestamp stripped; replay rows lack seq.
- **Change:** emit `{eventId, seq, timestamp, type, payload}`; include seq in replay payloads.
- **Accept:** client receives correlation fields on every event; replay rows carry seq.
- **Rollback:** none needed (additive). **Deps:** none. **Est:** 0.5d.

### RUN-0 · `runs` table v0 (write-only)
- **Evidence:** No run entity anywhere (schema.ts); execution state smeared across messages+memory.
- **Change:** migration adds `runs(id uuid pk, parent_run_id, agent_id, channel_id, workspace_id, runtime_type, status, error_code, checkpoint_seq bigint, created_at, updated_at)`; insert on `RuntimeExecutor.execute`, update terminal status. Stamp `runId` onto messages metadata + broker events.
- **Accept:** every persisted assistant turn traceable to a run row; `run.status_changed` visible in durable_events.
- **Rollback:** table unused if disabled. **Deps:** DB-1 (migrations first). **Est:** 1d.

### HYG-1 · Repo hygiene
- **Evidence:** zips (`backup 23-5.zip`,`client.zip`,`fe.zip`,`be.zip`,`crowdos.zip`), `tmp_patch*.js`, `audit_temp.cjs`, `debug.log`, `codex session id.txt` tracked/root; `target-frontend/` dead mock; tests/configs/docs gitignored.
- **Change:** delete junk; move `target-frontend/` → `_archive/target-frontend/` (gitignored); un-ignore test configs, e2e, docs, board files.
- **Accept:** clean clone contains no archives/junk; `npm test` discoverable from fresh clone.
- **Rollback:** git history retains deletions. **Deps:** none. **Est:** 0.5d.

### TST-2 · Fix vacuous boundary test + linter coverage
- **Evidence:** `runtimeLifecycle.test.ts:689` regex `(?:import|export)[^''"]jvfrom` can never match; linter covers 8/16 domains.
- **Change:** delete in-test duplicate; extend `check-gates.mjs` DOMAINS to Skills, vfs, runtime, core, Memories-adjacent folders; wire into lint script.
- **Accept:** planted cross-domain import fails CI.
- **Rollback:** revert script. **Deps:** CI-1. **Est:** 0.5d.

**Phase 0 exit criteria:** CI green on clean machine; `/metrics` live; every event carries correlation fields; runs rows appear per execution.

---

## 4. Phase 1 — Security closure (≈6d)

### SEC-1 · Key-based authentication (users later)
- **Evidence:** `authGate.ts:24-32` open when `AUTH_TOKEN` unset (current reality); identity from spoofable headers (`:30,49`).
- **Change:** new `api_keys` table `(id, key_hash, label, role enum(admin,operator,viewer), created_at, last_used_at, revoked_at)`; `AUTH_STRICT=true` default-deny; bootstrap seeds one admin key printed once; `requireAuth` resolves key→identity server-side; legacy shared-token mode only when `AUTH_STRICT=false`.
- **Accept:** all routes (incl. `POST /api/tools/execute-test`, `/api/studio/*`) 401 without valid key; role gates admin endpoints; spoofed `x-user-id` ignored.
- **Rollback:** `AUTH_STRICT=false`. **Deps:** DB-1. **Est:** 1.5d.

### SEC-2 · Socket trust & room isolation
- **Evidence:** handshake trusts client userId/workspaceId, fallback `user-1` (`registerSocketServer.ts:269-277`); any join accepted (:280-310); auto-join + mirror to `workspace:default` (:211,:277); no disconnect handler.
- **Change:** key verification in handshake auth payload; rooms joined only after server-side membership check (workspace_nodes/channel visibility); delete `workspace:default` mirror fan-out; add disconnect handler (leave rooms, cleanup maps — runs NOT cancelled, preserving product rule).
- **Accept:** integration test: socket B cannot receive channel A events without membership; impersonated identity rejected.
- **Rollback:** flag reverts to open sockets in dev only. **Deps:** SEC-1. **Est:** 1.5d.

### SEC-3 · Tool gateway hardening
- **Evidence:** unanchored prefix `Guard.ts:32`; no realpath; ALLOW list admits `find -exec`, npm scripts, bare interpreters; `child_process.exec` interpolation (`toolRegistry.ts:207,241`); no signal/kill on timeout (`ToolExecutor.ts:123-131`); PiToolBridge bypasses executor + cwd() sandbox (`PiToolBridge.ts:32,68,112,159`); children inherit full env.
- **Change:**
  1. `validatePath`: anchored prefix (`root + sep`), `fs.realpathSync` resolution, deny symlink escape.
  2. Command policy: tokenizer-based classification; remove `find`/interpreters/package-manager-run from ALLOW (move to ASK); DENY unchanged.
  3. Execution: prefer `execFile`+arg-array; when shell required, escaped + process-group spawn; timeout kills group via signal; env allowlist (reuse MCP pattern `mcpClientManager.ts:78-96`).
  4. Coding sandbox: PiToolBridge file/bash tools rooted at workspace rootPath; routed through ToolExecutor grant check (inherit agent skill whitelist + authority level); executor timeout applies.
- **Accept:** automated exploit suite passes blocked: `find -exec cat .env`, malicious `package.json` pivot, sibling-path traversal, symlink escape, timeout-orphan process, env exfiltration, out-of-workspace coding write.
- **Rollback:** per-rule flags; legacy Guard behind `LEGACY_GUARD=true` (dev only). **Deps:** none. **Est:** 2d.

### SEC-4 · Secrets management
- **Evidence:** plaintext `api_key` columns (`schema.ts:52,133,151,163`, `mcp_servers.env_vars`); console.log sites bypass redaction; `inspect-prompt` exposes compiled prompts (`studio.ts:205-214`).
- **Change:** pgcrypto encrypt-at-rest for key columns (encrypt on write, decrypt in provider adapter only); single `redactLogPayload` adopted by all log sites (grep-enforced lint rule banning raw console.log of config objects); inspect-prompt requires `admin`.
- **Accept:** DB dump contains ciphertext; lint fails on unredacted logging; 403 non-admin inspect.
- **Rollback:** decrypt fallback reads plaintext columns during migration window. **Deps:** DB-1. **Est:** 1d.

### SEC-5 · Rate limiting
- **Evidence:** zero rate limits anywhere; `execute-test` runs arbitrary tools unthrottled.
- **Change:** `@fastify/rate-limit` global (per-key), strict bucket on execute-test + studio inspect; socket-level per-connection message throttle (token bucket).
- **Accept:** burst harness receives 429s; legit traffic unaffected at 10× current volume.
- **Rollback:** disable plugin. **Deps:** SEC-1. **Est:** 0.5d.

### SEC-6 · MCP client hygiene
- **Evidence:** tools force-labeled `dangerLevel:'safe'`, fixed `authLevelRequired:2` (`mcpClientManager.ts:148-150`); env-vars matching secret patterns silently dropped (:87-90); pending calls unresolved on crash; newline-JSON framing (P3-4).
- **Change:** per-server config: `defaultDangerLevel`, `requiredEnvVars` (declared ones passed through, warn otherwise); reject pending promises on `exit`; adopt MCP-spec framing (Content-Length where transport demands / verify stdio delimiter contract against spec version pinned in mcpTypes).
- **Accept:** compromised-server fixture cannot register destructive tool labeled safe; crash rejects waiters in <100ms.
- **Rollback:** config defaults preserve old behavior per server. **Deps:** none. **Est:** 1d.

**Phase 1 exit criteria:** exploit suite (SEC-3) green; unauthorized access impossible with `AUTH_STRICT=true`; secrets encrypted; rate limits enforced.

---

## 5. Phase 2 — Correctness & data integrity (≈6d)

### RUN-1 · Run state machine
- **Evidence:** ad-hoc string writes across ≥6 sites (`AgenticRuntime.ts:43,245`, `agentErrors.ts:67-82`, `agentHeartbeat.ts:68-72`, `agentService.ts:204`); no guards.
- **Change:** `Runs/runStateMachine.ts` — allowed transitions per Goal §D target (CREATED→QUEUED→STARTING→RUNNING⇄WAITING_FOR_TOOL/WAITING_FOR_APPROVAL→RETRYING/COMPACTING→COMPLETING→VERIFYING→COMPLETED|FAILED; CANCELLING→CANCELLED; ORPHANED→RESUMABLE); all writers call it; terminal immutable; every transition emits `run.status_changed{from,to,reason,runId}`.
- **Accept:** unit test rejects illegal transitions; integration shows full transition log for one agentic run.
- **Rollback:** n/a (internal discipline). **Deps:** RUN-0. **Est:** 1d.

### CAN-1 · Cancellation & timeout integrity
- **Evidence:** `activeRuns` overwrite strands controllers (`registerSocketServer.ts:41-50`); `session.prompt(userInput)` without signal (`CodingRuntime.ts:165`); PiBridge drops signal (`PiToolBridge.ts:208-211`); no provider timeouts; `Promise.race` losers keep running (`ToolExecutor.ts:123-131`).
- **Change:** duplicate trigger on same `${channelId}:${agentId}` → reject with explicit "already running" event (or queue per product choice; default reject); AbortController registry becomes array-safe; signal plumbed into `AgentSession.prompt(signal)`, PiBridge custom tools, provider fetches (connect timeout 10s, streaming idle timeout 120s, both abortable); typed provider errors (`ProviderTimeoutError`, `ProviderAbortError`) replacing string matching (`BaseRuntime.ts:70`); pre-stream failures retry ×2 exponential backoff; exec children killed on timeout (from SEC-3).
- **Accept:** kill-mid-stream test: final state CANCELLED, no orphan processes, no zombie controller; provider-hang fixture times out at 120s and retries then fails visibly.
- **Rollback:** timeouts configurable to previous infinite behavior via env. **Deps:** SEC-3. **Est:** 2d.

### DB-1 · Migration reconciliation
- **Evidence:** migrations dir = `.gitkeep`; hand-rolled `bootstrap.ts` drifted (no `durable_events`; `mcp_servers`/`dynamic_tools` column sets differ from `schema.ts`); `drizzle-kit push --force` alternate path can silently drop columns.
- **Change:** generate baseline drizzle migration from schema.ts; bootstrap.ts reduced to seed-only; CI step applies migrations to empty Postgres then runs suite; dispose of `dynamic_tools` (deprecated stub — documented) and legacy profile tables (fold into model_modules) unless claimed.
- **Accept:** `docker compose up` fresh → migrate → seed → full suite green (proves `durable_events` present).
- **Rollback:** bootstrap retained behind `LEGACY_BOOTSTRAP=true` one release. **Deps:** none. **Est:** 1d.

### DB-2 · Transactional writes & atomic sequences
- **Evidence:** dual UPDATEs untransacted (`RuntimeKernel.ts:217-224`); message+durable_event+index increment independent; socket path SELECT-MAX+1 race (`sequenceNumber.ts:6-11`); `msg-${Date.now()}` PK collisions.
- **Change:** single tx helper for {persistMessage + durable_event + index drift}; setAgentStatus tx; sequences allocated via dedicated `channel_sequences` row locked `FOR UPDATE` (or `INSERT … RETURNING` subquery everywhere); ULID message ids.
- **Accept:** concurrency test (20 parallel sends/channel): zero 23505 surfaced, zero gaps.
- **Rollback:** retry logic already masks legacy path. **Deps:** DB-1. **Est:** 1d.

### DB-3 · Stop destroying evidence
- **Evidence:** pair channels/agents/taskFiles hard-deleted post-verdict (`agentSpawnManager.ts:496-507`); librarian substitutes fabricated mock summaries on API error (`librarianRuntime.ts:198-205`).
- **Change:** spawn artifacts retained with `archived_at` + retention sweeper (30d default); librarian failure → visible degraded marker on channel_index (`status='degraded', last_error`) + event, never synthetic content.
- **Accept:** post-spawn audit reconstructable; forced API failure produces degraded flag, not fake summary.
- **Rollback:** n/a. **Deps:** none. **Est:** 0.5d.

### DB-5 · Structured tool-call records
- **Evidence:** tool results persisted as `` `🛠️ [Tool Result…]` `` strings, recovered via regex (`messageService.ts:22-65`).
- **Change:** messages gains `tool_calls jsonb` (name,args,result,truncated,durationMs,callId); AgenticRuntime/PiEventBridge write structured rows; reader prefers column, falls back to legacy strings.
- **Accept:** round-trip test: tool card data identical pre/post migration; legacy channels render unchanged.
- **Rollback:** fallback parser retained. **Deps:** DB-1. **Est:** 1d.

### MEM-1 · Memory lifecycle enforcement
- **Evidence:** `suppress_until` stored, never enforced (`schema.ts:342`, retrieval filters active only); `generateNoteId` full-table scan (`agentMemoryStore.ts:199-213`); creates unlogged; unbounded reflection growth.
- **Change:** sweep job flips expired suppressions; per-agent note caps (archive oldest low-importance beyond N=500); date-sequence from counter row; log creates in `memory_update_log`; reflection throttle (≥1 note per run, dedupe by hook similarity).
- **Accept:** soak test (50 runs): vault bounded, suppression expiry observed, no full-scan in query log.
- **Rollback:** flags per behavior. **Deps:** QUE-2 (sweeper as repeatable job) or timer interim. **Est:** 1d.

### MEM-2 · Wire discard_memory_from_context
- **Evidence:** returns success string, mutates nothing (`toolRegistry.ts:551-556`).
- **Change:** marks note suppressed-for-session on packet context (and persists soft-suppress with short TTL).
- **Accept:** agent test: discarded note absent from subsequent previews.
- **Rollback:** n/a. **Deps:** none. **Est:** 0.25d.

### CTX-1 · Event surface truth-out
- **Evidence:** 14+ defined-never-emitted; phantom handlers (parliament×2, budget:warning, agent:paused/resumed); undeclared `strike:initiated`; unused ring-buffer APIs; duplicate `RuntimeEvents` const nothing imports.
- **Change:** per event: WIRE (paused/resumed/budget:warning via sweeper/tracker), EMIT-CORRECTLY (swarm:* gated to Phase 5), or DELETE (lifecycle/override/state/patched/snapshot/sandbox:stream|process, escalation.updated/resolved until built, parliament handlers); declare strike:initiated; delete `shared/events/runtime-events.ts` duplicate (shared BrokerEventMap becomes contract); delete dead broker APIs.
- **Accept:** CI grep-check: zero defined-never-emitted, zero handled-never-emitted (whitelist for planned Phase-5 events).
- **Rollback:** git. **Deps:** EVT-0. **Est:** 0.75d.

### RT-5 · Runtime taxonomy cleanup
- **Evidence:** `observer`/`orchestrator` declared, unregistered, fall back with warning (`RuntimeExecutor.ts:58-62`); `core/LoopArbiter.ts` vestigial alias.
- **Change:** remove dead types from union + composer options; delete alias file (imports → Shared/core directly).
- **Accept:** typecheck green; router warns only on genuinely unknown runtime.
- **Rollback:** git. **Deps:** none. **Est:** 0.25d.

**Phase 2 exit criteria:** kill-mid-run leaves consistent resumable-marked state; fresh-migrate DB runs full suite; audit trails survive spawns; event map fully accounted.

---

## 6. Phase 3 — Performance & cost (≈6d)

### PERF-1 · Parallel mention dispatch
- **Evidence:** serial `for…await` per matched agent (`registerSocketServer.ts:415-438`).
- **Change:** `Promise.allSettled` over matched agents, each with own controller from CAN-1 registry; configurable `MAX_PARALLEL_AGENTS` (default 4); ordering of resulting messages preserved by seq allocation (DB-2).
- **Accept:** 3-agent mention completes in ≈ slowest-agent time (test asserts <1.3×).
- **Rollback:** env→1 restores serial. **Deps:** CAN-1, DB-2. **Est:** 0.5d.

### PERF-2 · Bounded hot-path queries
- **Evidence:** ALL memory notes loaded per send (`memoryRetrieval.ts:41-47`); duplicate history fetches (VisibilityMatrix 60 + ChannelAwareness 30); uncached agents scans ×2/send; VFS per-entry stat N+1 (P2-1).
- **Change:** memory retrieval SQL-side window (`ORDER BY scored_proxy LIMIT 60` then JS lane-score); ContextAssembler shares one history fetch between middlewares; 30s TTL roster cache invalidated on agent mutation; VFS list uses single readdir + batched stat.
- **Accept:** query-count-per-send flat vs channel age (regression test with 5k-message channel).
- **Rollback:** flags. **Deps:** none. **Est:** 1.5d.

### PERF-3 · Per-iteration context budget
- **Evidence:** cap applied assembly-time only; iterations append past cap (`AgenticRuntime.ts:52,64-67` vs ContextLimitMiddleware); memory preview resent every iteration; safety rule triplicated; tool schemas uncounted.
- **Change:** kernel re-checks char-budget each iteration (trim oldest OTHER first, keep last SELF); preview injected iteration 1 only; canonical `[SOURCE INTEGRITY]` block authored once (IdentityAuthority) referenced elsewhere by one line; tool-schema tokens estimated into budget.
- **Accept:** 10-iteration run total prompt tokens ≤ cap + 15% (test with verbose mock provider).
- **Rollback:** `PER_ITERATION_BUDGET=false`. **Deps:** none. **Est:** 1d.

### PERF-4 · Accounting & librarian economy
- **Evidence:** librarian reloads entire channel per 10 msgs (`librarianRuntime.ts:146-176` + `indexBuilder.ts:59-83`); full-table SUM per completion (`tokenTracker.ts:60-64`); 80%-warning spam (`:87-110`).
- **Change:** delta-index since last indexed seq (store `last_seq` on channel_index); `workspace_settings.budget_used` incrementally updated + daily reconcile job; warning edge-triggered per threshold crossing.
- **Accept:** librarian input tokens −80% on 1k-message channel (fixture); accounting queries O(1).
- **Rollback:** `DELTA_INDEX=false`. **Deps:** DB-2. **Est:** 1d.

### PERF-5 · Pagination
- **Evidence:** `findMany` no limit (`messageService.ts:8-11`); client full-fetch + localStorage mirror growth.
- **Change:** keyset cursor `(timestamp,seq) LIMIT 50` on GET messages (+ `before` param); client virtualized list loading pages upward; localStorage mirror capped.
- **Accept:** channel-open latency constant at 10k msgs (Playwright timing assert).
- **Rollback:** legacy limit param honored. **Deps:** DB-5. **Est:** 1d.

### PERF-6 · Stream parity
- **Evidence:** Pi bridge emits per-delta unbatched vs kernel 50ms coalescing (`PiEventBridge.ts:43-56` vs `RuntimeKernel.ts:23-26`).
- **Change:** pipe Pi deltas through `streamChunk` coalescer.
- **Accept:** coding-run socket write rate ≈ kernel-path rate (event-count assert).
- **Rollback:** none needed. **Deps:** none. **Est:** 0.25d.

### PERF-7 · Indexes
- **Change:** add `messages(channel_id,timestamp DESC)`, `token_usage_log(created_at)`, `agent_memory_notes(agent_id,lifecycle_status,note_timestamp DESC)`, `spawn_requests(status)` via migration.
- **Accept:** EXPLAIN confirms usage on hot queries. **Est:** 0.25d.

### PERF-8 · Tool parallelism classifier
- **Evidence:** only all-`PARALLEL_SAFE` batches parallelize; no read/write analysis.
- **Change:** static classifier per tool (read-only vs mutating); mixed batches parallelize reads, serialize writes preserving order.
- **Accept:** mixed-batch test: reads concurrent, writes ordered, results deterministic.
- **Rollback:** `TOOL_RWP=false`. **Deps:** none. **Est:** 0.5d.

### PERF-9 · HTTP keep-alive
- **Change:** shared undici Agent (keepAlive, pipelining) injected into all provider adapters.
- **Accept:** TTFT benchmark −100ms+ warm. **Est:** 0.25d.

### MODEL-1 · Model routing economy v1
- **Evidence:** model = static per-agent module; `modelRouter.ts` misnamed helpers; no task-tier selection (README's Lv-based allocation aspirational).
- **Change:** rename file `googleModelHelpers.ts`; add routing table: runtime+task-class → preferred module (chat/classify/summarize → flash-tier; planning/coding → frontier) resolved from existing modules with fallback chain; librarian/reflections pinned to cheap tier; `cost_per_1k` column on model_modules feeding budget math.
- **Accept:** routing-decision logged per call; cheap tier demonstrably used for reflections/librarian; cost/run drops measurably in token_usage_log.
- **Rollback:** `MODEL_ROUTE=static`. **Deps:** DB-1. **Est:** 1d.

**Phase 3 exit criteria:** latency budget table (Goal §E format) populated from `/metrics` with measured p50/p95 before-vs-after.

---

## 7. Phase 4 — Durable core: Redis + BullMQ + resume (≈8d)

### QUE-1 · Infrastructure
- **Change:** `docker-compose.yml` (postgres:16, redis:7); deps `ioredis`,`bullmq` in server package; scripts `dev` (api+worker), `dev:worker`; `worker.ts` entry importing gates only; health checks report queue connectivity.
- **Accept:** `docker compose up` → api+worker healthy; suite green against services.
- **Rollback:** compose optional locally. **Deps:** DB-1. **Est:** 1d.

### QUE-2 · Queue domain
- **Evidence:** all execution inline under socket handler; background work = ad-hoc timers (librarian 10min, snapshot 15s, retention hourly, sweeps).
- **Change:** new `Queue/` domain (gate wraps BullMQ): queues `runs`(agent executions), `maintenance`(repeatables: librarian-delta, heartbeats-touch, orphan-sweep, suppress-expiry, retention); `QUEUE_MODE=inline|bullmq` (inline preserves today's synchronous behavior for dev/tests); socket handler enqueues run and returns immediately; runtime:snapshot becomes event-driven deltas (churn fix) with 15s full snapshot as repeatable fallback.
- **Accept:** both modes pass full suite; maintenance timers no longer registered when bullmq mode on.
- **Rollback:** `QUEUE_MODE=inline`. **Deps:** QUE-1, RUN-0/1. **Est:** 2.5d.

### QUE-3 · Job semantics
- **Evidence (V1 §14):** no idempotency, retries, DLQ, graceful drain.
- **Change:** jobId = idempotency key (channel+agent+messageId); attempts 3 exponential backoff (1m/5m/25m); lock duration 15min renewed by run heartbeat; `failed` events retained 7d (DLQ inspection endpoint admin-only); SIGTERM → worker drains (finish current, close queues, exit).
- **Accept:** chaos tests: `kill -9` worker mid-job → retried exactly-once (idempotency verified); SIGTERM drains with 0 lost.
- **Rollback:** inline mode. **Deps:** QUE-2. **Est:** 1.5d.

### RES-1 · Resume from checkpoint
- **Evidence:** crash mid-run = lost; sweeper only pauses agent; half-applied VFS mutations unrecoverable-but-indistinguishable.
- **Change:** runs.checkpoint updated at each tool boundary ({historySnapshotJson ref or msg-seq watermark, completedToolCallIds}); `resume` action (socket + REST) re-enqueues from watermark skipping completed tool calls; orphaned RUNNING runs flipped RESUMABLE by sweep; compensation journal: VFS-mutating tools record inverse ops (delete created / restore prior content hash) surfaced as "pending side effects" banner with accept/undo.
- **Accept:** e2e: start agentic run → SIGKILL worker at tool 2/4 → worker restarts → resume completes remaining steps exactly once; banner lists/undoes side effects correctly.
- **Rollback:** resume button hidden; behavior = restart-from-scratch. **Deps:** QUE-3, RUN-1. **Est:** 2d.

### CFG-1 · Config consolidation
- **Evidence:** 15+ ad-hoc `process.env` reads scattered (env.ts validates only 3 vars).
- **Change:** zod schema for full env matrix (§11 flags incl.), fail-fast startup report of effective config (redacted).
- **Accept:** unknown/malformed var blocks boot with named fix; doc generated from schema.
- **Rollback:** lenient parser flag. **Deps:** none. **Est:** 1d.

**Phase 4 exit criteria:** browser-close/server-crash/worker-kill survival demonstrated per Goal §15 lifecycle test; V1-P0-3 closed.

---

## 8. Phase 5 — Orchestration: Research, Swarm v1, approvals, context integrity (≈10d)

### RT-1 · Real Research runtime
- **Evidence:** `research: agenticInstance` alias (`RuntimeExecutor.ts:31-39`); `web_search` canned mock (`toolRegistry.ts:270-274`).
- **Change:** `SearchProviders/` domain: Brave/Tavily/Serper adapter behind one interface (key via config); ResearchRuntime = supervisor packet spawning isolated research sub-runs (own window, search+fetch tools only) producing **evidence bundle** artifact (sources, snippets, timestamps, dedupe by URL+similarity, freshness); synthesis step compresses to cited report returned to channel; raw results never enter main context.
- **Accept:** research run yields citation artifact; main-channel prompt-token delta ≤ report size (assert); dedupe/freshness visible in artifact.
- **Rollback:** router pins research→agentic (today's behavior) behind flag. **Deps:** QUE/RES (sub-runs as jobs), ART-1. **Est:** 3d.

### SW-1 · Real Swarm v1
- **Evidence:** SwarmRuntime = prompt-stub (`SwarmRuntime.ts:28-38`); AgentSpawnManager mocks (`setTimeout(800)`, template code, keyword verdicts `:385-443`).
- **Change:** new `Swarm/` domain: supervisor LLM emits structured plan → `swarm_tasks` DAG `(id, run_id, depends_on[], assignee_template, status)` → leaf tasks dispatched as worker runs (BullMQ, leases reuse run heartbeats) → aggregator merges outputs (dedupe/conflict notes) → verifier pass (independent model, goal+artifact check) gates COMPLETED; partial failure aggregates honestly (`completed X/Y`); linear chains first, fan-out second; AgentSpawnManager retired behind `SWARM_LEGACY` flag one release.
- **Accept:** e2e linear chain (plan→2 workers→aggregate→verify→result) green; worker-kill mid-swarm → partial aggregation reported truthfully; no mocked strings anywhere (grep test bans template literals from old manager).
- **Rollback:** `SWARM_V1=false` routes L2→agentic. **Deps:** QUE-*, RES-1, RUN-1. **Est:** 4d.

### SW-2 · Delegation contracts
- **Evidence:** no delegations table; `delegation:start` never emitted; recursion unguarded; full-copy returns pollute parents.
- **Change:** `delegations(id,parent_run_id,child_run_id,depth,summary)`; central dispatcher enforces depth≤2 + visited-set cycle rejection; child result summarized (maxSubagentReturnTokens≈500) + artifact pointer; `delegation:start/completed` events consumed by UI timeline.
- **Accept:** cycle attempt rejected deterministically; parent context grows ≤ summary size (assert).
- **Rollback:** depth flag→∞ disables guard (dev). **Deps:** SW-1. **Est:** 1d.

### APR-1 · Approval engine
- **Evidence:** ASK hard-denied (`Guard.ts:143-150`); no approval events/table anywhere.
- **Change:** `Approvals/` domain: `approval_requests(run_id, tool, args_preview, risk_class, status, requested_by, decided_by, expires_at, scope reusable?)`; risky classes (install/network/destructive/git-push/db-write) → run pauses WAITING_FOR_APPROVAL, emits `approval.requested`; decision via socket/REST; TTL default-deny resumes-as-denied; reusable grants cached per (tool,scope-hash) with expiry; full audit trail; Guard returns tri-state again.
- **Accept:** e2e: risky bash → card → grant executes / deny → tool fails safely, run continues or cancels per policy; repeated grants don't re-ask within scope.
- **Rollback:** `APPROVALS_ENABLED=false` → ASK behaves as DENY (today). **Deps:** RUN-1 (pause states), SEC-1 (decided_by). **Est:** 2d.

### CTX-2 · Prompt/context integrity
- **Evidence:** anti-impersonation rule duplicated ×3 (~350 tok/run); untrusted content enters prompts undelimited; ZWSP escape cosmetic; second-order injection via reflection notes; InstructionStack `replace` wipes stack nondeterministically (`InstructionStackMiddleware.ts:48-59`).
- **Change:** untrusted spans wrapped `<untrusted source="…">…</untrusted>` (history, roster lines, memory hooks); reflection pipeline strips control/blocklike patterns + tags provenance; canonical SOURCE-INTEGRITY block referenced once; instruction patches: deterministic orderBy(id), scoped replace (target module id, not whole stack), expiry deletion sweep; precedence doc (constraints > instructions > persona) enforced by block order + asserted in test.
- **Accept:** injection-chain fixture (channel msg → note → next-run prompt) shows contained/escaped content; patch determinism test passes.
- **Rollback:** escaping flag off = legacy formatting. **Deps:** MEM-1. **Est:** 1.5d.

### RT-4 · Honest compression
- **Evidence:** pi-core compaction deletes turns claiming summarization (`compaction.ts:46-55`); HistoryCompression `findFirst` unordered picks stale row.
- **Change:** compaction summarizes dropped turns via cheap-model call (fallback: honest `[truncated N turns]` marker); ordered latest-summary read.
- **Accept:** post-compaction session retains facts probe answers > baseline truncation; correct summary row served.
- **Rollback:** truncation mode stays available. **Deps:** MODEL-1 (cheap tier). **Est:** 0.5d.

### TOOL-1 · Honest tools
- **Evidence:** `query_database` ignores SQL, returns canned agents (`toolRegistry.ts:296-301`); `system_scheduler` = setTimeout console.log (`:329-341`).
- **Change:** query_database → real read-only SQL over pooled connection (statement_timeout 5s, allowlist views, row cap) or removed if unwanted; system_scheduler → BullMQ delayed/repeatable jobs firing real mentions/events; remove-if-unwanted documented.
- **Accept:** scheduled task fires on time via queue; SQL tool returns true results capped.
- **Rollback:** tools unregistered rather than fake. **Deps:** QUE-2. **Est:** 1d.

### ART-1 · Artifact service
- **Evidence:** `artifacts` table never written; snapshots dir unused; edit diffs transient (`pi-core/edit.ts`).
- **Change:** `Artifacts/` domain writes `artifacts(run_id,type=file|diff|report|citations,path,before_hash,after_hash,patch,content_ref)`; producers: coding edits, research bundles, swarm reports; retention follows DB-3 policy.
- **Accept:** coding run yields diff artifact rows; UI/API can list per run.
- **Rollback:** n/a additive. **Deps:** DB-5. **Est:** 1d.

**Phase 5 exit criteria:** Goal §33 flows demonstrable: research-with-citations, supervised swarm with verification, approval interrupt; delegation observable end-to-end.

---

## 9. Phase 6 — UX upgrade (≈8d)

All items consume server capabilities from earlier phases; each ships with a Playwright journey (TST-4).

| ID | Item | Spec | Acceptance | Est |
|---|---|---|---|---|
| UX-1 | Cancel | Stop button on streaming bubble/header → emits existing `user:cancel`; renders CANCELLED state | long run stoppable; state shown; no orphan | 0.5d |
| UX-2 | Approval cards | Renders `approval.requested`; grant/deny/(grant-scope); consumes APR-1 | interrupt→decision→resume recorded | 1d |
| UX-3 | Diff review | Diff viewer from ART-1 (`diff.created`): side-by-side/patch view, apply/revert actions calling VFS | review-before-save flow completes | 1.5d |
| UX-4 | Edit/regenerate/retry | Message hover actions: edit-resend (new run, references original), regenerate, retry-failed-run (RES-1) | each action produces correct run lineage | 1.5d |
| UX-5 | Background continuity | Client emits `channel:join`, stores afterSeq cursor, replays gap on reconnect; reconnect digest ("while away: 2 runs finished"); Browser Notification on run completion; persistent mute map | close-tab mid-run → return → full timeline + notification | 1.5d |
| UX-6 | Delegation timeline + typed contracts | Client imports shared event payload types (EVT-2 outcome); fixes `agent:spawned` consumer; delegation tree/timeline from SW-2 events | spawn shows workers not garbage rows; chain renders live | 1.5d |
| UX-7 | Honesty pass | Per-reply runtime badge; delete fake telemetry (`length*1.5`, 42000 baseline) → real token_usage_log aggregates; seed/demo fallback behind `DEMO_FALLBACK` | panels match DB numbers; outage shows error not demo | 0.75d |
| UX-8 | Store decomposition + pagination UI | Extract socket layer + API client from 2,288-line store; typed payloads; virtualized paginated history (PERF-5); omni-search hits server endpoint (channel_index) | store <800 lines/core; search finds unloaded history | 1.5d |

Stretch (unscheduled): UX-9 fork/branch from message (needs run lineage UI) · UX-TERM node-pty streamed terminal panel.

**Phase 6 exit criteria:** Goal §22 benchmark spot-checks pass; payload-mismatch bug class eliminated by shared types (CI contract test).

---

## 10. Phase 7 — Scale & observability hardening (ongoing)

| ID | Item | Spec | Acceptance |
|---|---|---|---|
| SCL-1 | Load suite | k6/artillery: 100 concurrent sends; 10 concurrent swarms; soak 8h | error budgets held; no queue starvation; vault bounded |
| SCL-2 | Semantic memory | pgvector columns + embedding pipeline on notes (embedding profile tables finally used); hybrid lane scoring | recall@10 beats heuristic-only on eval set |
| SCL-3 | OTel + cost ledger | OTel SDK spans assemble/llm/tool/persist keyed runId; per-run cost rollup view from token_usage_log×cost_per_1k | trace reconstructs any run; dashboard matches ledger ±1% |
| TST-5 | Failure-mode automation | Goal §25 scenarios scripted (disconnect/restart/timeout/tool-crash/model-refusal/dup-request…) asserting detect/persist/inform/recover/idempotent | suite runs in CI nightly |

---

## 11. Cross-cutting tracks

### Testing track
| ID | Item | Notes |
|---|---|---|
| TST-1 | Un-ignore suites/configs | pairs with HYG-1 |
| TST-3 | Test DB isolation | fixtures/testcontainers; ban silent skips (`it.skip` or fail); cleanup after each file |
| TST-4 | Playwright journeys | chat, agentic tools, coding diff (UX-3), approval (UX-2), resume (UX-5), swarm timeline (UX-6) |
| TST-6 | Provider contract tests | recorded SSE fixtures per adapter incl. usage chunks + error paths |
| TST-7 | Perf budgets | assert assemble p95, tokens/run, queue lag thresholds in CI (warn level) |

### Docs track
| ID | Item |
|---|---|
| DOC-1 | README rewrite to reality (Redis/BullMQ claim becomes TRUE at Phase 4; Raven/Crow/Conspiracy/Murder marked roadmap-not-shipped until SW-1) |
| DOC-2 | Reconcile DEVELOPMENT_BOARD.md vs execution-plan checklist (single board; historical plans archived) |
| DOC-3 | Identifier_Index regeneration + Specs.md refresh post-Phase 5 |

---

## 12. Dependency graph & sequencing

```
P0(CI,OBS,EVT0,RUN0,HYG,TST2)
 └► P1(SEC1→SEC2→SEC3→[SEC4,5,6])
     └► P2(DB1→[RUN1,CAN1,DB2,DB5,MEM*]→CTX1,RT5,DB3)
         ├► P3(PERF1←CAN1; PERF2..9, MODEL1←DB1)
         └► P4(QUE1→QUE2→QUE3→RES1; CFG1)
             └► P5(RT1←ART1; SW1→SW2; APR1←RUN1; CTX2←MEM1; RT4←MODEL1; TOOL1←QUE2; ART1←DB5)
                 └► P6(UX1..8)
                     └► P7(SCL*)
Testing/docs tracks: continuous.
```

## 13. Flag registry

| Flag | Default | Purpose | Remove after |
|---|---|---|---|
| `AUTH_STRICT` | true in prod | SEC-1 default-deny | users-table phase |
| `QUEUE_MODE` | inline (dev) / bullmq (prod) | QUE-2 | +2 releases stable |
| `SWARM_V1` | false→true | SW-1 cutover | SW-legacy removal |
| `SWARM_LEGACY` | false | old SpawnManager escape hatch | Phase 5 end |
| `APPROVALS_ENABLED` | false→true | APR-1 | +1 release |
| `DELTA_INDEX` | true | PERF-4 | +1 release |
| `PER_ITERATION_BUDGET` | true | PERF-3 | +1 release |
| `DEMO_FALLBACK` | false | UX-7 seeded demo mode | decision point |
| `LEGACY_BOOTSTRAP` / `LEGACY_GUARD` | false | DB-1 / SEC-3 escape hatches | +1 release |
| existing: `PIPELINE_PARALLEL`, `STREAM_BATCH_MS`, `ORPHAN_AFTER_MS`, `ENABLE_DB_CONFIG_MUTATION`, `DURABLE_EVENTS` | — | kept, consolidated into CFG-1 | CFG-1 |

## 14. Validation strategy (per phase)

Each phase closes with: (a) full suite + new acceptance tests green in CI on clean containers; (b) manual failure drill from Goal §25 relevant rows; (c) metrics snapshot archived (before/after for perf phases); (d) rollback rehearsal for any flagged cutover (flip flag → verify legacy path).

**Definition of Done (whole program):** Goal §36 checklist flips to ✓ — durable, observable, cancellable, resumable, parallel, permission-aware, cost-aware, model-agnostic, runtime-agnostic, extensible, secure, fast, developer-friendly — evidenced by SCL suites and the two-audit convergence backlog at zero OPEN items.

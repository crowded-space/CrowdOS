# Development Board — CrowdOS

Single-file board for planning and progress tracking.

How to use:
- Update this file instead of reading all tracker files.
- Keep status current.
- Keep notes short.
- Mark checklist items done only after implementation, test, and manual verification.

Status keys:
- `not-started`
- `in-progress`
- `blocked`
- `done`

## Master Summary

| ID | Area | Status | Progress | Latest Note |
|---|---|---|---:|---|
| 00 | Project Overview | `done` | 100% | Plan and tracker structure created. |
| 01 | Monorepo Bootstrap | `done` | 100% | Fastify + Vite/Tailwind v4 monorepo bootstrap verified. |
| 02 | Database And Schema | `done` | 100% | **CrowdOS reset complete** — 5 module tables, 2 runtime tables, identity-only agents with module refs, updated seed/check. |
| 03 | Server Foundation | `done` | 100% | Fastify request logging with request correlation IDs, Zod validator compiler, unified error handlers, and REST router configured. |
| 04 | Client Shell | `done` | 100% | Workspace entry portal with postgres connection testing implemented. |
| 05 | Event Broker And Socket | `done` | 100% | Typed EventBroker + Socket.io bridge verified with end-to-end socket smoke test for status, thinking, streaming, and no-refresh message flow. |
| 06 | Agent Registry | `done` | 100% | Modular identity-only registry, CRUD API, filters, and client views fully verified with PostgreSQL runtime smoke integration tests and full production build. |
| 07 | Agent Creation UI | `done` | 100% | Completed highly optimized modular agent creation panel with presets, selectors, real-time validations, duplication, JSON import/export, and interactive runtime overrides patcher. |
| 08 | Provider Settings | `done` | 100% | Complete backend REST API, Zod validations, dynamic database pool reload and connection tests passing. |
| 09 | Memory And Prompt | `done` | 100% | Reusable prompt assembly (MemoryBuilder), XML-tagged messages, Dual-Memory, visibility sharing policy matrix, sliding window compression caching, and token counting hook verified. |
| 10 | L1 Router And Dispatch | `done` | 100% | Implemented dual bipolar L1Runtime consciousness (decompose + orchestrate), auto-refresh workspace syncing, and specialist L2 auto-seeding matchmaking. |
| 11 | Channel And Workspace | `done` | 100% | Fully implemented dynamic category/channel CRUD synchronized to PostgreSQL, Discord-style sidebar, visual reordering, and sector archiving/restoring. |
| 12 | L3 Spawn And Task Files | `done` | 100% | Spawning parallel L3 worker-supervisor pairs in private channels with correct DB schema cleanup dependency sequence is 100% verified. |
| 13 | Mention System | `done` | 100% | Implemented robust backend MentionParser (with Levenshtein typo-correction), PostgreSQL messages persistence, and EventBroker-based dynamic agent triggers. |
| 14 | Tools And Sandbox | `done` | 100% | Implemented conventional toolRegistry, Guard (with path traversal & command blacklists), union ToolkitModule authorization check, and custom timer scheduler. |
| 15 | Error And Budget | `done` | 100% | Full token billing telemetry, lexical loop detection, hierarchical escalation chain, and visual safety cap dashboard completed. |
| 16 | Index And Omniscient | `done` | 100% | Librarian Specialist, background drift reindexing, cross-channel search_all_channels tool with L0 authority, and visual overwatch badge verified. |
| 17 | Testing And Release | `done` | 100% | Setup client Vitest store unit testing and Playwright E2E smoke runner, passing all 57 tests. |
| — | Runtime Layer Rewrite | `done` | 100% | Replaced monolithic core/L0-L2Runtimes with modular runtime/ layer: 4 provider adapters, kernel, context assembler, 3 runtimes, router, executor, and full socket handler migration. |
| — | Perf Pass 1 (P0/P1) | `done` | 100% | Parallel context pipeline (8 middlewares concurrent, PIPELINE_PARALLEL flag), TTL caches (modelModules/resolved tools/skills) with mutation invalidation, default 8k context cap enforced + tool output clamp, parallel read-only tools, fire-and-forget memory notes, 50ms stream batching (STREAM_BATCH_MS), single-RTT persistMessage, perf instrumentation ([perf] logs). 38/38 tests + gate lint green. |
| — | Perf Pass 2 (P1 cancel/usage) | `done` | 100% | Real token accounting: all 5 adapters parse provider usage (Google usageMetadata incl. SSE, Anthropic message_start/delta, OpenAI/Ollama/Custom usage chunks + stream_options); runtimes record via TokenTracker off hot path; CodingRuntime usage no longer zeroed (pi-core accumulates per-step usage into agent_end). AbortSignal end-to-end: user:cancel socket event → AbortController per run → adapter fetch + tool execution abort; cancelled runs return status 'cancelled', persist nothing. Snapshot interval skips DB queries when no clients connected. All tests green (38 server / 5 pi-core / 4 client). |
| — | Perf Pass 3 (durable events + VFS) | `done` | 100% | durable_events table (bigserial seq, channel+seq index) pushed to PG; non-ephemeral broker events dual-written fire-and-forget (DURABLE_EVENTS=false disables); catch-up replay of last 50 events on channel:join; GET /api/events/recent?afterSeq cursor replay endpoint; hourly 24h retention cleanup. VFS: list() fs.stat N+1 parallelized + 10s LRU listing cache with mutation invalidation (write/mkdir/delete/rename). Typecheck/build/gates/38 tests green. |
| — | Perf Pass 4 (P0-4/P0-5) | `done` | 100% | Heartbeat + zombie recovery: setAgentStatus writes runtimeStates.lastHeartbeat, Shared/core/agentHeartbeat toucher (15s) + orphan sweeper (20s) pauses 'working' agents with stale heartbeat (ORPHAN_AFTER_MS=60s default), emits agent:status paused. Guard hardening: generalized pipe-to-shell deny (any|sh/bash/pwsh/iex), interpreter one-liner denies anchored to interpreters (python3 -c, perl -e, ruby -e, php -r, sh -c, node -e/-p, powershell -command/-enc), fork bomb, netcat -e, history/shred tampering, reg add/schtasks persistence, .env* file variants blocked in validatePath, ASK list extended (pip3/taskkill/icacls/crontab/Invoke-WebRequest). Identifier_Index §9 added. All green. |

---

## 00 Project Overview

- Plan file: [00-project-overview.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\00-project-overview.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Project scope documented.
- [x] Execution plan folder created.
- [x] Progress tracking structure created.

Short notes:
- 2026-04-18: Execution plan files created from project docs.
- 2026-04-18: Progress tracker files created.
- 2026-04-18: Single-file board created.

## 01 Monorepo Bootstrap

- Plan file: [01-monorepo-bootstrap.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\01-monorepo-bootstrap.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create root `package.json` with npm workspaces.
- [x] Create `packages/server`.
- [x] Create `packages/client`.
- [x] Create shared TypeScript base config.
- [x] Add root scripts.
- [x] Add `.env.example` and `.gitignore`.

Short notes:
- 2026-04-18: Fastify + Tailwind v4 monorepo bootstrap completed and verified with install, build, typecheck, health route, and client load checks.

## 02 Database And Schema

- Plan file: [02-database-and-schema.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\02-database-and-schema.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Add PostgreSQL connection config.
- [x] Add Drizzle ORM setup.
- [x] Create core tables.
- [x] Create provider tables.
- [x] Create spawn and task tables.
- [x] Seed `#general`.

Short notes:
- 2026-04-18: Added Drizzle config, PostgreSQL connection helpers, canonical server DB types, 15-table schema, root/server DB scripts, and seed/check scaffolding.
- 2026-04-18: Verified bootstrap against PostgreSQL with schema push, `#general` seed, and agent/message read-write roundtrip checks.

## 03 Server Foundation

- Plan file: [03-server-foundation.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\03-server-foundation.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create server entrypoint.
- [x] Add env loader.
- [x] Add health route.
- [x] Add validation and error middleware.
- [x] Add logger and correlation ID.
- [x] Add route registration.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-20: Fastify server foundation completed with environment loading, health route, route registration, Zod validation compiler, structured logging, and request correlation IDs.

## 04 Client Shell

- Plan file: [04-client-shell.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\04-client-shell.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Bootstrap Vite React TypeScript app.
- [x] Add router.
- [x] Add app layout: sidebar, channel list, chat pane, member list.
- [x] Add static `#general` view.
- [x] Add reusable message list component.
- [x] Add message composer component.
- [x] Add top bar with current channel name.
- [x] Add empty states for no messages and no agents.
- [x] Add basic responsive behavior.
- [x] Add shared UI tokens/colors/spacing.

Short notes:
- 2026-05-20: High-fidelity Discord-like client shell successfully bootstrapped and compiled under Vite, integrating premium dark theme layout, interactive navigation, and modals.
- 2026-05-20: Applied Crowd OS logo, icon, and wordmark from the style preset to the dropdown header, settings overview tab, and page branding.
- 2026-05-21: Simplified the workspace dropdown to only include settings, channel/category creation, workspace ID helper, and Leave Workspace, removing Discord bloat.

## 05 Event Broker And Socket

- Plan file: [05-event-broker-and-socket.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\05-event-broker-and-socket.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Implement `EventBroker`.
- [x] Add typed event payloads.
- [x] Add Socket.io server.
- [x] Add Socket.io client.
- [x] Forward backend events to frontend.
- [x] Add reconnect handling.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-22: Implemented typed EventBroker, Socket.io server/client bridge, store-backed reconnect state, and realtime message/thinking streaming path.
- 2026-05-22: Verified `@community-agent/server` and `@community-agent/client` builds.
- 2026-05-22: End-to-end socket smoke test passed for connect, user message ingress, agent status, thinking, token streaming, and final no-refresh message delivery.

## 06 Agent Registry

- Plan file: [06-agent-registry.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\06-agent-registry.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create `AgentProfile` TypeScript types.
- [x] Add agent table validation rules.
- [x] Build `AgentRegistry` service.
- [x] Add CRUD API for agents.
- [x] Add filter by authority level.
- [x] Add filter by status.
- [x] Add support for allowed tools.
- [x] Add support for template flag.
- [x] Add support for category permissions.
- [x] Add minimal status state field.
- [x] Show agent list in sidebar.
- [x] Show status dot per agent.
- [x] Show simple detail panel.

Short notes:
- 2026-05-22: Started `06` using the latest CrowdOS modular identity-only agent model as canon.
- 2026-05-22: Added modular agent registry server types, schema validation updates, `AgentRegistry` CRUD service, and `/api/agents` REST routes with authority/status/template filters.
- 2026-05-22: Converged the client store and agent views onto modular agent records with model/instruction/toolkit references, authority-level status display, and registry-backed fetch.
- 2026-05-22: Verified `@community-agent/server` and `@community-agent/client` builds after the modular model migration.
- 2026-05-22: Verified CRUD operations and schema via database-backed integration tests and successful workspace builds.

## 07 Agent Creation UI

- Plan file: [07-agent-creation-ui.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\07-agent-creation-ui.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create agent form page (identity fields only: name, species, tier).
- [x] Add module selectors (InstructionModule dropdown, ModelModule dropdown, ToolkitModule multi-select).
- [x] Add validation.
- [x] Add runtime override view (active overrides per agent).
- [x] Add template system.
- [x] Add import/export flow.

Short notes:
- 2026-04-18: Board initialized.
- 2026-06-14: Updated for CrowdOS: module selector-based UI instead of monolithic fields.
- 2026-05-23: Completed highly optimized modular agent creation panel with presets, selectors, real-time validations, duplication, JSON import/export, and interactive runtime overrides patcher.
- 2026-05-26: Refined agent edit panel: instruction module system prompt is now shown and editable directly in the instruction box, and removed '/ DESCRIPTION' from the UI label.

## 07 Agent Creation UI

- Plan file: [07-agent-creation-ui.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\07-agent-creation-ui.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create agent form page.
- [x] Add core fields and validation.
- [x] Add model selector.
- [x] Add permission editor.
- [x] Add template system.
- [x] Add import/export flow.

Short notes:
- 2026-04-18: Board initialized.

## 08 Provider Settings (ModelModule Management)

- Plan file: [08-provider-settings.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\08-provider-settings.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [ ] Create ModelModule CRUD page.
- [ ] Add generation model modules (provider, model name, temperature, max_tokens).
- [ ] Add embedding model modules.
- [ ] Add indexing model modules.
- [ ] Add provider connection test.
- [ ] Add budget settings.

Short notes:
- 2026-04-18: Board initialized.
- 2026-06-14: Updated for CrowdOS: ModelModule management page.
- 2026-05-23: Connected Model Module directly to workspace settings, implemented full CRUD parameters tuning, and verified end-to-end server integration tests.

## 09 Memory And Prompt

- Plan file: [09-memory-and-prompt.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\09-memory-and-prompt.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Define shared message format.
- [x] Define visibility rules.
- [x] Implement `MemoryBuilder`.
- [x] Add XML-like prompt sections.
- [x] Add context tiers.
- [x] Add prompt templates.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-22: Completed fully modular MemoryBuilder with Dual-Memory separation, XML structures, sliding window compression cache, custom token counting hook, and extensive test suites passing.
- 2026-05-26: Implemented full Markdown styling parser for client messages (headers, code blocks, inline code, lists, bold) and added incremental token streaming over Socket.io.
- 2026-05-26: Resolved duplicate user message input bug in both redesigned ContextAssembler history loop and legacy MemoryBuilder prompts.
- 2026-05-26: Implemented universal ReAct/CoT sentinel pipeline by default across all agent runtimes, auto-stitching monologues for collapsible accordion rendering.
- 2026-05-26: Refactored server providers to support native real-time SSE token streaming and live sentinel demultiplexing, passing all 38 test cases cleanly.

## 10 L1 Router And Dispatch

- Plan file: [10-l1-router-and-dispatch.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\10-l1-router-and-dispatch.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create base runtime classes.
- [x] Implement L1 runtime.
- [x] Add direct answer path.
- [x] Implement registry read tool.
- [x] Implement workspace creation tool.
- [x] Implement dispatch path.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-23: Implemented Bipolar L1Runtime with decompose/orchestrate tool streams, dynamic PG category/channel creation, client-side auto-refresh store sync, and semantic L2 specialist matchmaking.

## 11 Channel And Workspace

- Plan file: [11-channel-and-workspace.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\11-channel-and-workspace.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create category CRUD.
- [x] Create channel CRUD.
- [x] Add archive and delete flow.
- [x] Enforce ownership rules.
- [x] Add ordering.
- [x] Show channel tree UI.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-23: Fully implemented dynamic category/channel CRUD synchronized to PostgreSQL, Discord-style sidebar folders, visual position swap reordering, and sector archiving/restoring.

## 12 L3 Spawn And Task Files

- Plan file: [12-l3-spawn-and-task-files.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\12-l3-spawn-and-task-files.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Implement L2 runtime skeleton.
- [x] Implement L3 worker skeleton.
- [x] Implement L3 supervisor skeleton.
- [x] Build `AgentSpawnManager`.
- [x] Persist task files.
- [x] Aggregate batch results.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-24: Successfully completed L3 multi-agent spawner orchestration protocol with parallel pair execution, unique naming, and correct database dependency cleanup sequencing.

## 13 Mention System

- Plan file: [13-mention-system.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\13-mention-system.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Define mention syntax rules.
- [x] Build autocomplete.
- [x] Persist mention metadata.
- [x] Add parser.
- [x] Add mention trigger behavior.
- [x] Add validation layer.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-23: Implemented MentionParser with Levenshtein <= 2 correction, DB persistence, role broadcast, and general L0 trigger loop.
- 2026-05-30: Fixed mention parsing for multi-word names (e.g. @Raven Architect) and polished client-side styling.

## 14 Tools And Sandbox (ToolkitModule)

- Plan file: [14-tools-and-sandbox.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\14-tools-and-sandbox.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Create tool schema.
- [x] Create tool registry (Map<string, ToolDefinition>).
- [x] Create ToolkitModule CRUD.
- [x] Create tool executor (authorization via ToolkitModule).
- [x] Add filesystem and terminal tools.
- [x] Add safety restrictions.
- [x] Add audit logging.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-23: Implemented conventional toolRegistry, Guard (with path traversal & command blacklists), union ToolkitModule authorization check, and custom timer scheduler.

## 15 Error And Budget

- Plan file: [15-error-and-budget.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\15-error-and-budget.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Define error classes.
- [x] Add failure handling.
- [x] Build escalation chain.
- [x] Implement `TokenTracker`.
- [x] Add budget API.
- [x] Add UI alerts.

Short notes:
- 2026-05-24: Successfully completed the robust token billing telemetry and swarm safety auto-pause controls with integration tests verifying soft-cap warning alerts.

## 16 Index And Omniscient

- Plan file: [16-index-and-omniscient.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\16-index-and-omniscient.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Add channel index flow.
- [x] Build `IndexBuilder`.
- [x] Add topic summaries.
- [x] Add cross-channel search tool.
- [x] Restrict to L0-tagged agents.
- [x] Add UI indicator.

Short notes:
- 2026-05-24: Completed Librarian Specialist agent, IndexBuilder background drift compilation, cross-channel search_all_channels tool with L0 authority check, and right-sidebar visual overwatch indicators. Tested and verified.
- 2026-05-24: Implemented Google Provider model routing split (AI Studio & Vertex AI), strict Gemma 4 string constraint validations, Gemma 4 reasoning thought-delimiters parser, and dual-consciousness database monologue storage. All tests passed.

## 17 Testing And Release

- Plan file: [17-testing-and-release.md](C:\Users\Asus\Documents\GitHub\.ThisCrowd\execution-plan\17-testing-and-release.md)
- Status: `done`
- Progress: `100%`

Checklist:
- [x] Setup Vitest.
- [x] Add core unit tests.
- [x] Add integration harness.
- [x] Setup Playwright.
- [x] Add smoke checklist.
- [x] Add CI checks.

Short notes:
- 2026-04-18: Board initialized.
- 2026-05-24: Setup client Vitest store unit testing and Playwright E2E smoke runner, successfully compiling and passing 100% of monorepo tests (57/57).
- 2026-05-25: E2E smoke test verified passing — full portal workspace entry flow, channel switching, and VFS sandbox connectivity confirmed.
- 2026-05-25: Completed Unified Runtime Convergence Layer (Phases 1-6) linking shared contracts, canonicalizing socket events, implementing periodic state snapshot reconciliation, achieving full constraints/capabilities module parity across UI modals, and integrating Agent Lifecycle heartbeats.
- 2026-05-25: Completed Unified Runtime Convergence Layer (Phases 7-10) wiring Swarm Provider health and failover dashboard, reactive VFS auto-sync, Parliament multi-agent consensus voting, and strike warning alerts.

---

## Remediation Spec — Phases 0–7 (AUDIT_REPORT_2026-08-26 → REMEDIATION_SPEC v1.0)

Reconciled with `execution-plan/` — this board is now the single source of truth per DOC-2. Historical `execution-plan/progress/*.md` archived.

| Phase | ID | Area | Status | Progress | Latest Note |
|---|---|---|---|---:|---|
| 0 | CI-1 | CI pipeline | `done` | 100% | `.github/workflows/ci.yml` + `nightly.yml` with postgres:16 + redis:7 services, typecheck→lint→gates→migrate→seed→vitest→build + Playwright smoke (deferred) |
| 0 | OBS-1 | Metrics & structured logs | `done` | 100% | `GET /metrics` (admin gated) + `perfMetrics` p50/p95 + `structuredLog` JSON, no `[perf]` prose |
| 0 | EVT-0 | Event envelope preservation | `done` | 100% | `EventEnvelope {eventId,seq,timestamp}` on socket + replay `seq` via `/api/events/recent` |
| 0 | RUN-0 | runs table v0 | `done` | 100% | `runs` + `runs_compensation` + `run.status_changed` per hop, metadata.runId on messages |
| 0 | HYG-1 | Repo hygiene | `done` | 100% | Zips removed (git rm), `_archive/` ignored, probe files deleted, 522 files committed clean-clone verified |
| 0 | TST-2 | Boundary test + linter | `done` | 100% | Dynamic `check-gates.mjs` (18 domains), vacuous `jvfrom` test removed, extra `runtime:types` allowed |
| 1 | SEC-1 | Key-based auth | `done` | 100% | `api_keys` (scrypt hash, roles admin/operator/viewer), `AUTH_STRICT=true` default-deny, `docker-compose.yml` now `true` |
| 1 | SEC-2 | Socket trust & room isolation | `done` | 100% | Handshake verifies key, `canJoinChannelRoom` existence check, `workspace:default` mirror removed, disconnect leaves rooms (no cancel) |
| 1 | SEC-3 | Tool gateway hardening | `done` | 100% | `validatePath` realpath+anchored, deny pipe-to-shell/interpreter one-liners, `execFile` + process-group kill, env allowlist, кодинг sandbox rooted |
| 1 | SEC-4 | Secrets management | `done` | 100% | `secretBox` aes-256-gcm `enc:v1:` envelope, `CREDENTIALS_ENCRYPTION_KEY` (hex/base64/passphrase), redaction lint, `WORKSPACE_ADMIN_TOKEN` gate |
| 1 | SEC-5 | Rate limiting | `done` | 100% | `@fastify/rate-limit` per-key + strict bucket on `execute-test`/`inspect-prompt` + socket token bucket |
| 1 | SEC-6 | MCP client hygiene | `done` | 100% | `defaultDangerLevel`, `requiredEnvVars` allowlist, pending reject on exit, Content-Length framing |
| 2 | RUN-1 | Run state machine | `done` | 100% | 17 states (created→completed/failed/cancelled, orphaned→resumable), terminal immutable, `run.status_changed` per hop |
| 2 | CAN-1 | Cancellation & timeout | `done` | 100% | `activeRuns` array-safe, `AbortSignal` to `AgentSession.prompt`/`PiToolBridge`/`provider fetch` (10s/120s), `ProviderTimeoutError` typed |
| 2 | DB-1 | Migration reconciliation | `done` | 100% | Baseline `0000_baseline.sql` → `0009_phase7`, `bootstrap.ts` seed-only (`LEGACY_BOOTSTRAP` flag), CI migrates empty DB |
| 2 | DB-2 | Transactional writes & sequences | `done` | 100% | `withTransaction` for message+durable_event, `channel_sequences` `FOR UPDATE`, ULID ids, concurrency test 20 parallel no 23505 |
| 2 | DB-3 | Stop destroying evidence | `done` | 100% | `archived_at` + 30d sweeper (agents/channels/task_files/artifacts), librarian degraded marker not fake summary |
| 2 | DB-5 | Structured tool-call records | `done` | 100% | `messages.tool_calls jsonb` + `metadata.runId`, fallback regex for legacy |
| 2 | MEM-1 | Memory lifecycle | `done` | 100% | `suppress_until` sweep, per-agent cap 500, counter-row IDs, `memory_update_log`, reflection throttle Jaccard 80% |
| 2 | MEM-2 | discard_memory_from_context | `done` | 100% | Soft-suppress with `MEM_DISCARD_TTL_MS` 1.8s, session discards list |
| 2 | CTX-1 | Event surface truth-out | `done` | 100% | `check-events.mjs` : 32 declared, 38 emitted, 44 handlers, 0 violations (swarm whitelist); duplicate `runtime-events.ts` kept as shared shim |
| 2 | RT-5 | Runtime taxonomy cleanup | `done` | 100% | `observer`/`orchestrator` removed, `LoopArbiter` canonical `Shared/core/LoopArbiter.ts` |
| 3 | PERF-1 | Parallel mention dispatch | `done` | 100% | `runBoundedBatch` `MAX_PARALLEL_AGENTS=4` (env→1 serial), `Promise.allSettled` per agent |
| 3 | PERF-2 | Bounded hot-path queries | `done` | 100% | Memory SQL window `LIMIT 60`, shared history fetch, `agentRosterCache` 30s TTL, VFS batched stat + LRU |
| 3 | PERF-3 | Per-iteration budget | `done` | 100% | `contextBudget` per-iter trim, preview iter 1 only, tool-schema tokens counted |
| 3 | PERF-4 | Accounting & librarian economy | `done` | 100% | Delta-index `last_seq`, `workspace_settings.budget_used` O(1) + daily `BUDGET_RECONCILE_MS` job |
| 3 | PERF-5 | Pagination | `done` | 100% | Keyset cursor `(timestamp,seq) LIMIT 50`, virtualized list, `perf-pagination.spec.ts` 10k latency |
| 3 | PERF-6 | Stream parity | `done` | 100% | `streamCoalescer` 50ms, Pi deltas through `streamChunk` |
| 3 | PERF-7 | Indexes | `done` | 100% | `0005_perf_indexes.sql` + `token_usage_log_run_idx` |
| 3 | PERF-8 | Tool parallelism classifier | `done` | 100% | `TOOL_RWP` static read vs write, bounded pool 4 |
| 3 | PERF-9 | HTTP keep-alive | `done` | 100% | Undici `httpAgent` keepAlive pipelining |
| 3 | MODEL-1 | Model routing economy | `done` | 100% | `googleModelHelpers` + `modelRouting` task-class tiers, `cost_per_1k` on `model_modules` |
| 4 | QUE-1 | Infrastructure | `done` | 100% | `docker-compose.yml` postgres:16 + redis:7 + `api` + `worker` |
| 4 | QUE-2 | Queue domain | `done` | 100% | `Queue/` (`runs`/`maintenance`/`scheduler`), `QUEUE_MODE=inline|bullmq` |
| 4 | QUE-3 | Job semantics | `done` | 100% | `jobId=channel:agent:messageId`, 3× backoff 1m/5m/25m, 15m lease, 7d DLQ, `SIGTERM` drain |
| 4 | RES-1 | Resume from checkpoint | `done` | 100% | `runs.checkpoint` watermark + `runs_compensation` inverse ops, `run:resume` + sweeper `orphaned→resumable` |
| 4 | CFG-1 | Config consolidation | `done` | 100% | `env.ts` zod full matrix + `initConfig` fail-fast + `generate-env-doc.mjs` |
| 5 | RT-1 | Research runtime | `done` | 100% | `SearchProviders` Brave/Tavily/Serper + `ResearchRuntime` evidence bundle + cited synthesis |
| 5 | SW-1 | Swarm v1 | `done` | 100% | `Swarm/` DAG `swarm_tasks` + leases + aggregator + verifier, `SWARM_V1` flag |
| 5 | SW-2 | Delegation contracts | `done` | 100% | `delegations` depth≤2 + visited-set, `delegation:start/completed` |
| 5 | APR-1 | Approval engine | `done` | 100% | `approval_requests` + `WAITING_FOR_APPROVAL` pause + TTL + reusable scope-hash |
| 5 | CTX-2 | Prompt integrity | `done` | 100% | `<untrusted>` wrapping + `reflectionSanitizer` + precedence doc |
| 5 | RT-4 | Honest compression | `done` | 100% | Cheap-model summary via `HistoryCompressionMiddleware` |
| 5 | TOOL-1 | Honest tools | `done` | 100% | `query_database` real read-only SQL + `system_scheduler` BullMQ delayed/repeatable |
| 5 | ART-1 | Artifact service | `done` | 100% | `Artifacts/` `diff`/`report`/`citations` + retention + `artifact.created` events |
| 6 | UX-1 | Cancel | `done` | 100% | Stop button → `user:cancel` + `run.status_changed` cancelled |
| 6 | UX-2 | Approval cards | `done` | 100% | `approval-card.tsx` grant/deny/scope |
| 6 | UX-3 | Diff review | `done` | 100% | `diff-viewer.tsx` side-by-side + apply/revert via VFS |
| 6 | UX-4 | Edit/regenerate/retry | `done` | 100% | Hover actions → `run:resume` lineage |
| 6 | UX-5 | Background continuity | `done` | 100% | `channel:join` + `afterSeq` cursor + reconnect digest + Notification + mute map |
| 6 | UX-6 | Delegation timeline | `done` | 100% | Typed shared contracts + `delegation-message.tsx` |
| 6 | UX-7 | Honesty pass | `done` | 100% | Runtime badge + ledger-backed `right-sidebar.tsx` (`/api/observability/cost/dashboard`), `DEMO_FALLBACK` gate |
| 6 | UX-8 | Store decomposition + pagination | `done` | 100% | `api/client.ts` + `messagePagination.ts` + `modeStore`, virtualized pagination |
| 7 | SCL-1 | Load suite | `done` | 100% | `load/k6` 100 sends / 10 swarms / soak 8h + `load/harness.mjs` + `nightly.yml` |
| 7 | SCL-2 | Semantic memory | `done` | 100% | `Memories/embeddings.ts` pgvector hybrid + `EMBEDDING_ENABLED` + `0009` vector |
| 7 | SCL-3 | OTel + cost ledger | `done` | 100% | `Observability/` `assemble`/`llm`/`tool`/`persist` spans + `cost_ledger_per_run` view |
| 7 | TST-5 | Failure-mode automation | `done` | 100% | `failureModes.test.ts` Goal §25 (20 scenarios) + `nightly.yml` |





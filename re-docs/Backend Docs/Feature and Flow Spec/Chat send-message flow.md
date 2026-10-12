# Chat send-message flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
A user sends a chat message and gets an agent reply in the same channel without thinking about runs, queues, or runtimes. This flow exists so a socket message becomes one tracked run that assembles context, streams one LLM answer, persists it, and closes — with every handoff visible as an event.

## Architectural decision
The shape is one linked choice: transport never executes, Runtime never delivers `[Observed]` — sockets persist the user message and enqueue a run, Queue delivers it to a worker, and Runtime only opens, executes, and closes what it is handed (`register-socket-server.ts:874-898`, `run-worker.ts:13-87`, `runtime-executor.ts:111`) `[Observed]`. The run row is the correlation id across all three: created at send time, adopted (never duplicated) by the executor, and walked one guarded hop at a time so a second writer's move throws stale-state instead of double-executing `[Observed]`. The rejected alternative is inline execution in the socket handler — it would skip durability, heartbeats, and the orphan sweep, so the socket only enqueues and returns `[Inferred]`.

## How it works
1. Client emits `user:message` with advisory `authorName`/`authorTag`/`userPreference` (client user profile); the socket handler derives `authorId` from the verified identity (client claims never trusted), persists the user row via `messageGate.append` (tag in `metadata`, preference never persisted) and threads an `operatorContext` into the run request (`register-socket-server.ts:141-166`, `message-service.ts:387-406`).
2. The handler resolves the addressed agent and creates the run via `runsGate.create({ agentId, channelId, runtimeType })`, which inserts `status created` (`register-socket-server.ts:874-882`, `runs-repository.ts:73-90`).
3. The handler calls `queueGate.enqueueRun({ runId, channelId, agentId, ... })`; in bullmq mode this enqueues the `runs` job, in inline mode the caller invokes `runtimeGate.execute` directly (`register-socket-server.ts:882-898`, `routes/runs.ts:19`).
4. Queue's run worker picks the job up, resolves the agent, and hands `(runId, ...)` to `runtimeGate.execute` (`run-worker.ts:13-87`).
5. The executor adopts the row — fresh `created/queued/starting` rows walk `starting → running`, `resumeContext + queued/resumable` walks the resume chain, anything else throws stale-state — or opens a new row when none was handed one (`runtime-executor.ts:111`, `runtime-executor.ts:187-199`).
6. The assembler builds the `ContextPacket` (pipeline middlewares + policy overrides + fresh `requestId` + `runId`/`abortSignal` stamping) without writing state (`context-assembler.ts:49`, `runtime-executor.ts:141`).
7. The executor starts the 15s `touchRunHeartbeat` interval so the orphan sweep does not mistake a long LLM call for a dead run (`runtime-executor.ts:131-144`).
8. The conversational path (or routed flavor) runs one `callLLM`: the provider adapter streams chunks through the `STREAM_BATCH_MS` coalescer as `message:stream`, with ReAct fallback when no native tool calls exist (`runtime-kernel.ts:75`, `runtime-kernel.ts:257`, `conversational-runtime.ts:12`).
9. The kernel persists the final message via `messageGate.append` (sequence reserve + insert + `message:new`), then flips the agent working → idle via `agentGate.setStatus` (`runtime-kernel.ts:154-206`, `message-service.ts:387-406`, `agent-service.ts:250-273`).
10. `closeRun` walks `completing → verifying → completed` (or `cancelling → cancelled` / `failed`) fire-and-forget, and usage is handed to `TokenTracker` off the hot path (`runtime-executor.ts:206-229`, `runtime-executor.ts:174`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Runtime.md> | Owns run adopt/open, context assembly call, heartbeat, `callLLM` + streaming coalescer, and the close walk; persists via `messageGate.append` and flips status via `agentGate.setStatus` |
| <../Domain Spec/Runs.md> | Owns the run row, the guarded transition machine, and heartbeat/checkpoint writes Runtime calls into |
| <../Domain Spec/Messages.md> | Sole owner of the `messages` table: socket and Runtime writes both go through `messageGate.append`; also owns the read path that renders them |
| <../Domain Spec/Queue.md> | Owns delivery of the enqueued run to the worker and into `runtimeGate.execute`; never routes or executes |

Related: <./Runtime router and flavors.md> (which flavor runs the turn), <./Context assembly pipeline.md> (how the packet is built), <./Provider adapters and streaming.md> (how tokens reach clients), <./Durable runs and checkpoints.md> (run durability around this flow), <./Recovery and resume.md> (what happens when this flow crashes mid-run).

## Current state
Real in both modes: socket persist + `message:new`, `runsGate.create`, queue/worker handoff, executor adopt/open, assembly, heartbeat, coalesced streaming, transactional persist, guarded close. Nothing in this path is stub or flag-gated — the flavor pins (`RESEARCH_V1`, `SWARM_V1`) change which runtime answers, not how the message travels. Known roughness, real but unenforced: `closeRun` is fire-and-forget, so a client may read the run one hop before its terminal state.

## Alignment notes
2026-09-16 C1 (CrowdOS §10): multi-mention is serial — `runBoundedBatch` is a sequential for-await loop, `parallel:1` in `mention.dispatch` metric, `MAX_PARALLEL_AGENTS` ignored. B sees A's committed output via shared channel context; failure isolated per agent.
Channel pins (§6-8, server-persisted): unset/temporary mode falls back to channel `pinnedRuntime` before Auto; unmentioned messages resolve `activeAgentId` (pinned mention) → `defaultAgentId` (channel default) → category owner → L0 → default-assistant, Librarian excluded throughout. Pins live on `channel_settings` (+ local mirror) via `GET|PATCH /api/channels/:id/settings`, null clears. Client localStorage pins are now view-only; server is truth. Workspace-level default has no column (deferred); pin changes emit no cross-client event (deferred).
2026-09-16 D5 (CrowdOS §8/§14): Librarian/Owl hard-blocked from the default-routing fallback chain (category-owner → L0 → default-assistant) in both queue and inline paths — explicit `@Owl` mentions still route. Heartbeat indexing (10-min `reindexStaleChannels` + per-message counter) is the indexing path, not chat.
2026-09-16 D1: one honest DB-optional create policy (Portal local-create + store, no fake default URL); Portal wrapped in `ErrorBoundary` with `workspaceError` surfaced; `channel:leave`/`workspace:leave` protocol added, client leaves old rooms on switch/channel change/leave.
2026-09-16 C3 slice 2 (§17-18): chat works with `DATABASE_URL` unset — categories/channels/messages/sequences/agents read/write local JSON under `<registryDir>/localstore` behind the same gates (DB path untouched when configured); runs ledger returns null and the executor runs run-less; modules/skills/memories/RAG/threads/search degrade honestly (middlewares error-isolated, universal tools still injected). Proven by `local-chat-e2e.test.ts` (seed → user message → conversational reply → persisted history, agent idle). Remaining: PG-path removal needs a migrator; local instruction/skill catalogs await spec 05.
2026-09-17 dual-boot: Default mode dual-writes PG+local (reads DB-first, same seq both tiers); outage or Local-first serves files with outbox queue (`localstore/outbox.jsonl`) auto-drained on recovery; conflict quarantine refuses DB R/W while serving local. Socket dispatch stamps the owning workspace (single channel lookup, was hardcoded `default`). Dev entry `index.ts` is now a thin wrapper over `buildServer()` — one server factory (tenant hook, guards, drain timer apply to `npm run dev` too).
2026-10-07 tenant-scoping: bullmq worker runs execute inside the workspace ALS handle (`runWithDb(dbForWorkspace(workspaceId ?? "default"))` around `runtimeGate.execute`, unscoped fallback on NO_DATABASE/unknown workspace; SH-002, `run-worker.ts:100-120`), completing the XD-016 fix across socket dispatch, socket resume, and worker legs. Runtime writes (artifacts, run transitions) now resolve the workspace DB in split-DB deployments. Regression tests landed 2026-10-07 (impl-tenant-tests-6): TG-1 in `register-socket-server.test.ts` (no deps stub; executor spy asserts bare `getDb()` resolves the ws-a / default handle; resolver-null degrades unscoped) and TG-4 in `queue/run-worker.scope.test.ts` (same three cases for `processRunJob`); sockets+queue suites 49/49, tsc exit 0. TG-2 closed 2026-10-07 (s1s2-sweep-1): `config/database.test.ts` proves the ALS handle survives deferred continuations of a fire-and-forget (`void`) run and does not leak to sibling unscoped work, backing the resume-path claim above.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Durable run prerequisite stays: open or adopt exactly one run row before side-effecting work. Untracked execution is forbidden.
* User row plus run row share one atomic outcome: no orphan user message on run-create failure.
* Close-walk is observable: callers distinguish pinned fallback from genuine routing.
* Read-after-close has a defined consistency rule. Fire-and-forget close without a contract is forbidden.
* Authority: Runtime, Runs, Queue, Messages standards.
## Open gaps
- Agent resolution inside `user:message` (mention parse, multi-agent fan-out, offline-agent handling) was not traced end to end — which agent gets the run when several match is unverified.
- Whether the user row and the run row share a transaction (orphan user message when `runsGate.create` fails) was not confirmed.
- Read-after-close consistency (`closeRun` fire-and-forget vs client refetch timing) is unverified beyond the code comment.
- `COMPOSER_MODE_TO_RUNTIME` (`chat → conversational`) wiring into this socket path vs the executor default was not traced.

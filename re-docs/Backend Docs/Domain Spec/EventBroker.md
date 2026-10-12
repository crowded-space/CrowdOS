# EventBroker

## Purpose
In-process typed pub/sub bus over Node EventEmitter. It envelopes every event with id/type/channelId/timestamp, guards the emit path against oversized payloads, and offers channel-scoped plus wildcard subscriptions; durability (§29 local event log) lives in Events, room fan-out in Sockets.

## Feature Scope
In-scope:
- Enveloped emit (`eventId`, `type`, `channelId`, `payload`, `timestamp`).
- Channel-scoped `on`, wildcard `onAny`, id-based `off`.
- Oversized-payload drop guard (256KB) that never throws.
- Canonical event contract: `BrokerEventMap`, `BrokerEventType`, socket client/server event types, composer `Mode` + `isValidMode`.
Non-goals (other domains):
- Event persistence + replay cursor → Events (`events/events-gate.ts`, `events/<channelId>.jsonl`, `routes/events.ts`).
- Retention (none exists) → documented in Events; no sweeper owns it.
- Room-scoped socket fan-out,auth, rate limits → Sockets (`register-socket-server.ts:389-393`).
- Run lifecycle, checkpoints, resume → Runs (`runsGate`, `runtime-executor.ts:187-199`).
- Approval policy/decisions → Approvals; only the `approval.requested/decided` payload shapes live here.
- Message reads/writes → Messages (read) and Runtime/Sockets/Agents/Tools (writes); this domain only types `message:new`.

## Expect
- [Observed] `emit` never throws: payloads over 256KB are dropped with a console warning and returned without fan-out (`event-broker.ts:49-58`).
- [Observed] `off` with an unknown listener id is a silent no-op (`event-broker.ts:95-103`).
- [Observed] `on` with a `channelId` fires only on exact `event.channelId` match; pass `undefined` for global (`event-broker.ts:72-77`).
- [Observed] Every `emit` fans out twice: once on the concrete type, once on `"*"` (`event-broker.ts:60-61`).
- [Observed] Listener ids are random UUIDs; callers must retain the id to unsubscribe (`event-broker.ts:71`, `event-broker.ts:88`).
- [Observed] Live socket envelopes carry `seq: null` — the broker never sets `event.seq`, and the §29 log assigns seqs only on the append path; replayed rows carry their persisted `seq` from `GET /api/events/recent` (`event-broker.ts`, `events/event-log-service.ts`).
- [Observed] Fallback paths resolve the shared instance via `getSharedBroker()` and emit on it (`tool-executor.ts`, `routes/approvals.ts`, `runs-gate.ts`, `routes/runs.ts`, `artifacts-repository.ts`, `approval-sweeper.ts`).
- [Observed] When no shared instance is registered, emit fallbacks warn-and-skip (`console.warn`, no throw) instead of emitting on a fresh orphan `EventBroker` — the previous orphan-instance pattern is removed from all runtime paths.
- [Inferred] Separate `EventBroker` instances share nothing; a handler on one instance never sees another instance's emits.
- [Observed] `isValidMode` accepts exactly `auto | conversational | agentic | coding | research | chat` (`event-types.ts:147-149`).

## Flow
1. Construct: `new EventBroker()` raises the emitter ceiling to 100 listeners (`event-broker.ts:22-28`); boot sites construct per process and register the instance via `setSharedBroker` (`create-app.ts`, `index.ts`, `worker.ts` — worker-local); `registerSocketServer` re-registers the authoritative instance (`register-socket-server.ts:274`).
2. Emit: `emit(type, payload, { channelId })` builds `{ eventId: randomUUID, type, channelId, payload, timestamp }` (`event-broker.ts:36-47`); payloads over 256KB warn-and-drop with no fan-out (`event-broker.ts:50-58`); otherwise dual-emit on `type` and `"*"` (`event-broker.ts:60-61`).
3. Subscribe: `on(type, channelId, handler)` wraps the handler in a channel filter and returns a UUID (`event-broker.ts:66-85`); `onAny(handler)` taps `"*"` (`event-broker.ts:87-93`); `off(id)` detaches and deletes (`event-broker.ts:95-103`); past 500 tracked listeners a leak warning fires (`event-broker.ts:30-34`).
4. Subscribers: `create-app.ts` registers the single §29 log hook (`eventBroker.onAny((event) => eventsGate.recordDetached(event))`, `create-app.ts:344`); `registerSocketServer` stores the shared instance as `globalBroker`, attaches `onAny` for room fan-out, and `on("message:new")` for the index counter.
5. Fan-out (§30 room namespacing): rooms come from `shared/sockets/room-keys.ts` and are the ONE scheme used by every producer and consumer — workspace room `ws:<workspaceId>`, channel room `ws:<workspaceId>:channel:<channelId>`. Channel events resolve their scope from the payload `workspaceId` when tagged (`message:new` carries the message row's), else from the live channel rooms already carrying that channel id (`observedScopesForChannel`); a socket only ever joins rooms of its own workspace, so neither path can cross a workspace boundary. Workspace-only events go to `ws:<workspaceId>`; keyless events fan out to every live workspace room with a global `io.emit` fallback only when origins allow localhost; `message:stream` is ephemeral and never persisted (`event-classification.ts` — Events owns the §29 classification).
6. Replay: `channel:join` only joins the room — the server does not re-emit history (a replayed event would be indistinguishable from a live one to every subscriber). Recovery is pull-based: `GET /api/events/recent?channelId=&afterSeq=&limit=` serves the local log ordered by ascending `seq` (`routes/events.ts`, Events domain).
7. Retention: none. The retired hourly `durable_events` sweeper has no replacement; the local log grows unbounded (Events → Decisions/Gaps).
8. Runtime producers: kernel emits `message:new` after persist plus `agent:status`/`message:stream`/`agent:thinking` (`runtime-kernel.ts:209-320`); pi-bridge emits `message:stream`/`tool:start`/`tool:complete` (`pi-event-bridge.ts:50-119`); executor emits `run.status_changed` (`runtime-executor.ts:231-243`); tool-executor emits `approval.requested/decided` (`tool-executor.ts:434-438`); scheduler emits `message:new` + `scheduled:triggered` (`tool-registry.ts:115-141`).
9. Worker tap: bullmq `run-worker` attaches `onAny`, counts `tool:complete` into `job.updateProgress`, and detaches in `finally` (`run-worker.ts:40-49`, `run-worker.ts:107-112`).

## Current Implementation
- `event-broker/event-broker.ts` → the bus. `EventBroker` class with `emit/on/onAny/off`; `MAX_LISTENERS = 100`, `LISTENER_WARN_AT = 500`, `MAX_PAYLOAD_BYTES = 256KB` (`event-broker.ts:22-24`).
- `event-broker/event-types.ts` → the contract. 33 `BrokerEventMap` keys (count printed by `check-events.mjs`, the CI truth); `Mode` + `isValidMode`; `BrokerEvent`/`EventEnvelope`; `SocketServerToClientEvents` mapped over every broker key; `SocketClientToServerEvents` inbound set.
- `event-broker/event-broker-gate.ts` → re-export only. `EventBroker`, `isValidMode`, `getSharedBroker`/`setSharedBroker`/`resetSharedBrokerForTests`, plus 7 types; no `*Gate` object (`event-broker-gate.ts`).
- `event-broker/shared-broker.ts` → the shared-instance holder (`getSharedBroker`/`setSharedBroker`/`resetSharedBrokerForTests`); type-only dependency on `EventBroker`, no logic beyond get/set.
- `shared/sockets/room-keys.ts` → the §30 room-key scheme (Sockets-owned, no gate): `ROOM_PREFIX` (`ws:`), `workspaceRoom(id)`, `channelRoom(workspaceId, channelId)`, `isWorkspaceRoom`, `isChannelRoom`, `parseChannelRoom`. Every producer (`io.to`) and consumer (`socket.join`/`socket.leave`) and the global fan-out prefix scan use these helpers, so the wire format has exactly one definition.
- Types (from `event-types.ts:5-157`): `AgentStatusEventPayload`, `MessageStreamEventPayload`, `AgentThinkingEventPayload`, `AgentSpawnedEventPayload`, `AgentDespawnedEventPayload`, `AgentPausedEventPayload`, `IndexDegradedEventPayload`, `StrikeInitiatedEventPayload`, `RunStatusChangedEventPayload` (with `from/reason/errorCode`), `BudgetWarningEventPayload`, `BudgetExceededEventPayload`, `RunQueuedEventPayload`, `RunCompensationsEventPayload`, `ScheduledTriggeredEventPayload`, `ApprovalRequestedEventPayload`, `ApprovalDecidedEventPayload`, `DelegationStartEventPayload`, `DelegationCompletedEventPayload`, `UserMessageEventPayload`, `ComposerModePayload`.

## Ports
- `EventBroker` — in-process typed pub/sub bus class (`emit/on/onAny/off`).
- `getSharedBroker` — returns the registered shared instance, or `null` when none (`shared-broker.ts`).
- `setSharedBroker` — registers the shared instance (Sockets authoritative; boot/worker set process-local) (`shared-broker.ts`).
- `resetSharedBrokerForTests` — clears the shared instance (tests only) (`shared-broker.ts`).
- `isValidMode` — narrows `unknown` to the 6-value composer `Mode`.
- `Mode` — `auto | conversational | agentic | coding | research | chat` union type.
- `BrokerEventMap` — event-key → payload map type (33 keys).
- `BrokerEventType` — `keyof BrokerEventMap` union type.
- `BrokerEvent` — enveloped event type (`eventId/seq?/type/channelId?/payload/timestamp`).
- `EventEnvelope` — socket wire-format type (correlation fields top-level, payload nested).
- `SocketServerToClientEvents` — server→client socket event map type.
- `SocketClientToServerEvents` — client→server socket event map type (`user:message`, `user:cancel`, `run:resume`, `run:compensations:list`, `run:compensation:undo`, `approval:decide`, `approval:list`).

## Relations
Gates this domain calls:
- None at runtime. Type-only (no runtime dependency): `ChannelMessage`/`StructuredToolCall` (`message-gate.ts`), `RunStatus` (`runs-gate.ts`), `RuntimeStatus` (`types/runtime.types.ts`) (`event-types.ts:1-3`).
- Non-gate internals used: `node:crypto` (`randomUUID`), `node:events` (`EventEmitter`).
Known outside callers/constructors of `EventBroker`:
- Sockets: `register-socket-server.ts` (owns `globalBroker`, room fan-out, snapshot, heartbeat wiring).
- Boot: `create-app.ts`, `index.ts` (shared instance construction + registration); `worker.ts` (worker-local shared instance for the approval sweeper).
- Runs: `orphan-sweep.ts` (dynamic import for `run.status_changed` emits).
- Tools: `tool-registry.ts` (scheduler broker, shared-first), `tool-executor.ts` (shared-instance approval emits with warn-and-skip).
- Runtime: `runtime-kernel.ts`, `pi-event-bridge.ts`, `agentic-runtime.ts`, `runtime-executor.ts`, `coding-runtime.ts` (emit-only).
- Queue: `scheduler-worker.ts`, `run-worker.ts` (progress tap), `maintenance-worker.ts` (orphan-resume broker).
- Routes (emit-only via `globalBroker`): `modules.ts`, `channels.ts`, `categories.ts`, `agents.ts`, `skills.ts`, `studio.ts`, `mcp.ts` (`workspace:sync`, `agent:resumed`, `sandbox:updated`).
- Type-only: `workspace-manager.ts`, `token-tracker.ts`, `loop-arbiter.ts`, `index-builder.ts`, `librarian-runtime.ts`, swarm planner/dispatcher/verifier/delegation, runtime `types.ts`.
Tables shared with other domains (all owned elsewhere, referenced here as payload types only):
- None owned here. `durable_events` was dropped (D6) — the §29 local event log (Events) replaces it as a file, not a table. `messages` (Runtime/Sockets/Agents/Tools/Queue/Threads write; Messages reads) and `runs` (Runs owns; status surfaces in `run.status_changed`) appear only as payload types.

## Emits-Listens
- The class emits nothing on its own and subscribes to nothing; it transports these declared keys between producers and subscribers (all `transports`):
- `agent:status` (transports)
- `message:new` (transports)
- `message:stream` (transports, ephemeral — never persisted)
- `agent:thinking` (transports)
- `agent:spawned` (transports)
- `agent:despawned` (transports)
- `agent:paused` (transports)
- `agent:resumed` (transports)
- `strike:initiated` (transports)
- `runtime:snapshot` (transports)
- `sandbox:updated` (transports)
- `swarm:created` (transports)
- `swarm:updated` (transports)
- `swarm:terminated` (transports)
- `escalation:created` (transports)
- `budget:warning` (transports)
- `budget:exceeded` (transports)
- `workspace:sync` (transports)
- `tool:start` (transports)
- `tool:complete` (transports)
- `run.status_changed` (transports)
- `run.queued` (transports)
- `run.compensations` (transports)
- `index:degraded` (transports)
- `scheduled:triggered` (transports)
- `approval.requested` (transports)
- `approval.decided` (transports)
- `delegation:start` (transports)
- `delegation:completed` (transports)
- `artifact.created` (transports)
- `diff.created` (transports)
- `artifact.updated` (transports)
- `channel:mount-updated` (transports)
- `category:mount-updated` (transports)
- `workspace:mount-updated` (transports)

## Owns
- None — pure in-process fan-out; this domain writes no tables, files, or queues (the §29 log is written by Events, not here).

## Flags
- None — this domain reads no environment variables. `DURABLE_EVENTS` is retired (always off, kept only so old env files parse) and the §29 log is unconditional, so no flag gates persistence anywhere on this path.

## Decisions
- [Observed] Shared instance resolved via `getSharedBroker()` instead of fresh fallbacks — why: durability and fan-out attach only to the socket server's instance, so orphan emits reached nobody; the holder keeps the domain dependency-free (type-only) with no boot order, at the cost of warn-and-skip when unregistered.
- [Observed] Unregistered-emit fallback is warn-and-skip, never throw — why: emit paths sit inside execution hot paths and must not fail runs; the warning makes the drop observable (unlike the previous silent orphan loss).
- [Observed] Worker processes share one worker-local instance and never forward across processes — why: single-process design; cross-process delivery is out of scope and documented, not silently faked.
- [Observed] Dual emit on concrete type plus `"*"` — why: targeted handlers and global bridges (the §29 log hook, worker progress) coexist without re-emit chains (`event-broker.ts:60-61`).
- [Observed] Oversized payloads drop-with-warn and never throw — why: the emit path sits inside execution hot paths and must not fail runs (`event-broker.ts:49-58`).
- [Observed] Durability lives outside the broker as a Sockets `onAny` dual-write — why: the broker stays synchronous and dependency-free; replay/retention are transport concerns (`register-socket-server.ts:344-367`).
- [Observed] Room-scoped fan-out with the global `io.emit` fallback restricted to dev-localhost origins — why: channel events must only reach joined sockets (SEC-2, `register-socket-server.ts`).
- [Observed] §30 rooms are workspace-namespaced (`ws:<workspaceId>`, `ws:<workspaceId>:channel:<channelId>`) via the single `room-keys.ts` scheme — why: bare `channel:<id>` rooms collided across workspaces that share a channel id, which made the client-side `isForeignWorkspacePayload` filter the de-facto isolation defence; server-side room scoping is now the primary defence and the client filter is defence-in-depth only.
- [Observed] `channel:join` derives the room from the CHANNEL row's `workspaceId` (server truth) and denies `channel_forbidden` when a socket that declared a real workspace targets another workspace's channel; legacy channels with no `workspaceId` stay globally joinable and the `default` placeholder identity is treated as the unscoped single-user scope — why: the workspace boundary must be enforceable without breaking pre-0018 global channels or the loopback single-user flow.
- [Observed] `message:stream` excluded from the durable set — why: per-token volume would flood the event log (`register-socket-server.ts:341`).
- [Observed] Contract enforced in CI by `check-events.mjs` (declared vs emitted vs handled surface) alongside `check-gates.mjs` — why: 33 producers/consumers share one unversioned map, so drift must fail the build (`packages/server/scripts/check-events.mjs`, `packages/server/package.json` `lint:gates`).
- [Inferred] Channel filter is exact string match on `event.channelId` — why: producers must pass `channelId` in emit options or scoped handlers silently never fire (`event-broker.ts:72-77`).

## User Decision:

## Architectural Standard (Target)

> Status: Target — new work must satisfy this. Current code is still single-process with worker-local brokers; do not claim the target as implemented.

* Single-process limitation MUST be declared wherever BullMQ mode is offered until a durable transport exists: worker-produced events stay worker-local and never reach the socket bridge or durable replay.
* Worker-produced events that any consumer needs MUST publish via a durable cross-process transport (outbox table or shared bus), not via per-job fresh broker instances. Fresh orphan emits are forbidden.
* Live envelopes carry seq null until persisted; consumers MUST NOT assume ordering on the live path. Ordering guarantees apply only to persisted replay via afterSeq.
* Emit drop vs delivery MUST be caller-distinguishable (return code plus metric), not console.warn only.

## User Decision (Open — awaiting operator choice)

* Q1: Durable outbox transport vs formal single-process constraint — which is the production direction? (Recommended: outbox.)
* Q2: Should oversized payloads fail the caller instead of warn-and-drop for control-plane events?

## Failure + Resume
- Oversized payload: warned, dropped from fan-out, event object still returned — caller cannot distinguish drop from delivery except via logs (`event-broker.ts:50-58`).
- Unserializable payload: size check skipped, passed to emitter; persistence layer rejects later if needed (`event-broker.ts:56-58`).
- `off` unknown id: silent no-op, never throws (`event-broker.ts:95-103`); listener overgrowth only warns past 500 (`event-broker.ts:30-34`).
- Log-append failure: counted + warned per-event, live delivery and runs unaffected (`event-log-service.ts`).
- No in-domain retry, ordering, or persistence: the bus holds nothing; restart loses in-flight fan-out, and recovery is re-subscribe via `on`/`onAny` plus `afterSeq` replay of the §29 log (`routes/events.ts`, Events domain).
- Worker progress tap detaches in `finally`, so job heartbeats never leak listeners across jobs (`run-worker.ts:91-96`).

## Gaps
- `strike:initiated` is emitted `as any`, hinting the typed contract does not cover that call site (`agent-errors.ts:57`).
- `db/schema.ts:948` comment says ephemeral streams are "`message:stream`, typing" but `BrokerEventMap` has no `typing` key — comment/contract drift.
- Declared-key count is 33 (`check-events.mjs` output) vs 32 quoted in `Specs.md:52` and 35 in older doc text — spec drift, CI script is truth.
- No runtime caller of `isValidMode` observed outside tests — where composer modes are actually validated is unverified.
- Live path has no ordering or sequence (always `seq: null` until persisted); cross-instance ordering and multi-process delivery are unverified — single-process design assumed.
- `MAX_LISTENERS = 100` is per instance on the raw emitter while the tracked-listener warn sits at 500 — the relationship between the two ceilings under heavy room fan-out is unverified.

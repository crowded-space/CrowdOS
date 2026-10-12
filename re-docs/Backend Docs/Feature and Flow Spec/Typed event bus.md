# Typed event bus
> Type: Feature · Status: aligned · Updated: 2026-09-21

## Intent
Producers (runtime, tools, queue, routes) and consumers (socket fan-out, the §29 event log, worker progress) need a shared vocabulary for "something happened" without direct coupling. This feature is a typed in-process pub/sub bus: every event is enveloped, subscriptions are channel-scoped or wildcard, oversized payloads never break the emit path, and one canonical contract maps all keys — while durability lives in Events, and room fan-out in Sockets.

## Architectural decision
The domain exposes a shared-instance holder (`getSharedBroker`/`setSharedBroker`) while Sockets keeps owning the authoritative instance, so the domain stays dependency-free with no boot order and fallback sites emit on the shared instance instead of orphan ones [Observed]. Each emit fans out twice, on the concrete type plus `"*"`, so targeted handlers and global bridges (the §29 log hook, worker progress) coexist without re-emit chains [Observed]. Oversized payloads drop-with-warn and never throw because the emit path sits inside execution hot paths and must not fail runs [Observed]. Durability is an `onAny` subscriber (the Events domain, registered at boot) rather than a broker concern, keeping the broker synchronous and dependency-free [Observed]. The contract is enforced in CI by `check-events.mjs` (declared vs emitted vs handled surface) because 33 producers/consumers share one unversioned map, so drift must fail the build [Observed].

## How it works
`new EventBroker()` wraps a Node EventEmitter with the ceiling raised to 100 listeners (`event-broker.ts:22-28`); boot sites construct per process. `emit(type, payload, { channelId })` builds `{ eventId: randomUUID, type, channelId, payload, timestamp }`; payloads over 256KB warn-and-drop with no fan-out but still return the event object, while unserializable payloads skip the guard and pass through. Otherwise the event dual-emits on `type` and `"*"`. `on(type, channelId, handler)` wraps the handler in an exact-match channel filter (top-level `channelId` else `payload.channelId` fallback) plus a per-listener try/catch so one bad subscriber can never kill fan-out or the persistence hook, and returns a UUID the caller must retain; `onAny(handler)` taps `"*"` with the same isolation; `off(id)` detaches and deletes, silently no-op on unknown ids; past 500 tracked listeners a leak warning fires. `create-app.ts` registers the single §29 log hook on the app's own instance (`onAny` → `eventsGate.recordDetached`, `create-app.ts:344`), which appends every non-ephemeral channel event to `events/<channelId>.jsonl` with a per-channel seq. The Sockets bridge stores the shared instance as `globalBroker`, attaches its own `onAny` for room fan-out (channel events to the channel's workspace-namespaced room), and `on("message:new")` for the index counter. Replay is pull-based: `GET /api/events/recent?channelId=&afterSeq=&limit=` serves the ascending local log (`afterSeq` exclusive, `lastSeq` = returned tail or head), and `channel:join` only joins the room — the server never re-emits history onto the live bus. There is no retention sweeper. Runtime producers emit `message:new` after persist plus `agent:status`/`message:stream`/`agent:thinking`, the pi-bridge emits `message:stream`/`tool:start`/`tool:complete`, the executor emits `run.status_changed`, tool-executor emits `approval.requested/decided`, and the scheduler emits `message:new` plus `scheduled:triggered`; the bullmq `run-worker` taps `onAny` to count `tool:complete` into `job.updateProgress` (runId-filtered since 2026-09-25; runId-less emitters still count as before) and detaches in `finally`. `tool:start`/`tool:complete` carry optional `runId` for that correlation.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/EventBroker.md> | Owns the bus (`emit/on/onAny/off`), the 256KB guard, and the canonical contract (`BrokerEventMap`, socket maps, composer `Mode`) |
| <../Domain Spec/Runtime.md> | Main producer: kernel, pi-bridge, executor, and coding/agentic runtimes emit run, message, stream, tool, and thinking events (emit-only) |
| <../Domain Spec/Tools.md> | Emits `approval.requested/decided` from the executor path; scheduler emits `message:new` plus `scheduled:triggered` |
| <../Domain Spec/Events.md> | Owns the §29 event log and the `/api/events/recent` replay cursor — the durability consumer of this bus |
| <../Domain Spec/Queue.md> | Taps `onAny` for worker progress heartbeats; owns scheduling/repeatables that ride on broker events (room fan-out lives in Sockets code, which has no domain spec) |

## Current state
Real: enveloped emit with dual fan-out, channel-scoped plus wildcard subscriptions with id-based unsubscribe, never-throw size guard, 33-key canonical contract with socket maps, socket bridge with room fan-out, the §29 local event log with a cursor replay endpoint, CI contract check, shared-instance holder (`getSharedBroker`/`setSharedBroker`) registered by Sockets at boot with worker-local instances in worker processes. Nothing in this feature is stub or flag-gated (`DURABLE_EVENTS` is retired; the log is unconditional). Known rough edges that are real: emit fallbacks warn-and-skip when no shared instance is registered, live envelopes carry `seq: null` (the broker never sets `event.seq`, so the live path has no ordering and replay seqs come only from the log), and worker-produced events stay worker-local.

## Alignment notes
- 2026-09-21 §29: the local event log landed and `GET /api/events/recent` is real again — file-backed (`events/<channelId>.jsonl`), one `onAny` hook registered at boot, exclusive-`afterSeq` replay, no retention. Ownership moved to the new Events domain. This supersedes the 2026-09-16 D6 note below.
- 2026-09-16 D6: `durable_events` retired — no dual-write, no join replay, no retention timer, `GET /api/events/recent` returned empty (deprecated). Physical table DROP + `bootstrap.ts` DDL removal = later migration (coordinated with `workspace_nodes` drop).
- Orphan-instance emits (resolved): fallback paths previously constructed fresh `new EventBroker()` instances and emitted on them (`tool-executor.ts`, `routes/runs.ts`, `queue/maintenance-worker.ts`, `register-socket-server.ts`), reaching no subscriber since durability and fan-out attach only to the socket server's instance. All runtime fallbacks now resolve `getSharedBroker()` (registered by Sockets/boot, worker-local in workers) and warn-and-skip when unregistered — no fresh-instance emits remain outside tests and execution-context construction.
- `strike:initiated` typing: emitted `as any` (`agent-errors.ts:57`), hinting the typed contract does not cover that call site — flagged in both the Agents and EventBroker domain docs.
- Key-count drift: 33 declared keys per `check-events.mjs` (it prints the count every run) vs 32 quoted in `Specs.md:52` and 35 quoted in the older EventBroker doc text — the CI script is truth.
- Ephemeral-set drift: `db/schema.ts:948` comment names "`message:stream`, typing" as ephemeral, but `BrokerEventMap` has no `typing` key — comment/contract drift.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Single-process limitation is declared wherever BullMQ mode is offered until durable transport exists. Worker events stay worker-local.
* Needed worker events publish via durable cross-process transport, never per-job fresh brokers. Fresh orphan emits are forbidden.
* Live envelopes carry seq null until persisted. Ordering applies only to persisted replay via afterSeq.
* Emit drop versus delivery is caller-distinguishable with metric, not console-only. Declared-key count matches CI contract script. Authority: EventBroker standard.
## Open gaps
- Live path has no ordering or sequence (`seq: null` until persisted); cross-instance ordering and multi-process delivery are unverified — single-process design assumed (worker emits stay worker-local by design).
- No runtime caller of `isValidMode` observed outside tests — where composer modes are actually validated is unverified.
- `MAX_LISTENERS = 100` on the raw emitter vs the tracked-listener warn at 500 — the relationship between the two ceilings under heavy fan-out is unverified.
- Whether `run.queued` has any consumer beyond socket fan-out was not traced.

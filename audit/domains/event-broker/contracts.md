# event-broker - contracts (exact exports + callers)

## Facade exports (event-broker-gate.ts, verbatim)
- class EventBroker { emit(type, payload, {channelId?}): BrokerEvent; on(type, channelId, handler): string; onAny(handler): string; off(listenerId): void }
- getSharedBroker(): EventBroker | null; setSharedBroker(b | null): void; resetSharedBrokerForTests(): void
- isValidMode(mode: unknown): mode is Mode; type Mode
- types: BrokerEventMap, BrokerEventType, BrokerEvent, EventEnvelope, SocketServerToClientEvents, SocketClientToServerEvents

## BrokerEventMap keys (35, event-types.ts:151-186)
agent:status, message:new, message:stream, agent:thinking, agent:paused, agent:resumed, strike:initiated, runtime:snapshot, sandbox:updated, swarm:created/updated/terminated, escalation:created, budget:warning/exceeded, workspace:sync, tool:start/complete, run.status_changed, run.queued, run.compensations, index:degraded, scheduled:triggered, approval.requested/decided, delegation:start/completed, artifact.created, diff.created, artifact.updated, channel:mount-updated, category:mount-updated, workspace:mount-updated.

## Importers (all via gate - rg event-broker-gate)
- boot: worker.ts:46, create-app.ts:8, shared/sockets/register-socket-server.ts:7-8,34
- type-only (no runtime coupling): state/state-gate.ts:11, runs/runs-gate.ts:22, runs/orphan-sweep.ts:6, runtime/* (runtimes, bridges, kernel, executor), shared/core (token-tracker, loop-arbiter, librarian, index-builder, heartbeat), approvals/approval-sweeper.ts
- runtime getSharedBroker: tools/tool-registry.ts:91, tools/tool-executor.ts:118,431,473,524,664,698,724, artifacts/artifacts-repository.ts:119, runs/runs-service.ts:20, routes/runs.ts:39,87, routes/approvals.ts:51, queue/scheduler-worker.ts:31, queue/run-worker.ts:28, queue/maintenance-worker.ts:11,43,60,114, state/state-gate.ts:34
- tests as fixture: ~20 files (runtime-lifecycle, agentic/coding/research runtimes, delegation, register-socket-server, tool-registry.honest, approvals integration, token-tracker, swarm e2e).

## Downstream contracts owned elsewhere
- persistence: create-app.ts:365 onAny -> eventsGate.recordDetached (events/event-log-service.ts:118; never throws; skipped counter on ephemeral/no-channel).
- socket: register-socket-server.ts:414 onAny -> EventEnvelope {eventId, seq: event.seq ?? null, timestamp, type, payload} (live seq always null; replayed rows carry seq from JSONL).
- replay: routes/events.ts GET /api/events/recent -> eventsGate.listRecent; honest empty events:[] + lastSeq:0.
- approval wait: tool-executor.ts:137 subscribes approval.decided + DB poll fallback.

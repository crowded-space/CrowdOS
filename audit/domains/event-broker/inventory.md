# event-broker - inventory (READ-ONLY audit, phases 1-4)

## 1. Domain files (exact)
- packages/server/src/event-broker/event-broker-gate.ts - facade; re-exports only, no logic.
- packages/server/src/event-broker/event-broker.ts - EventBroker class (Node EventEmitter wrapper).
- packages/server/src/event-broker/event-types.ts - BrokerEventMap (35 keys), BrokerEvent, EventEnvelope, socket types, Mode + isValidMode.
- packages/server/src/event-broker/shared-broker.ts - process singleton get/set/reset.
- No packages/server/src/event-broker/*.test.ts - zero dedicated unit tests.

## 2. Execution map
producers emit -> EventBroker.emit(type, payload, {channelId?}) [event-broker.ts:34-63]
  eventId=randomUUID, timestamp=new Date, seq NOT assigned here.
  oversized (>256KB) -> warn + return un-emitted.
  fan-out: emitter.emit(type) + emitter.emit("*").
  on(type, channelId?, handler) filtered subs; onAny #1 [create-app.ts:365] -> eventsGate.recordDetached -> JSONL; onAny #2 [register-socket-server.ts:414] -> socket.io envelope, room-scoped; broker.on message:new [register-socket-server.ts:464] -> IndexBuilder.incrementMessageCount.
sinks: socket clients | local JSONL log | GET /api/events/recent [routes/events.ts].

## 3. Boot / singletons
- API: create-app.ts:354-365 new EventBroker + setSharedBroker + persistence onAny + registerSocketServer.
- Worker: worker.ts:46-48 worker-local new EventBroker + approval sweeper only. No socket server, no persistence hook.
- Two handles: sharedBroker (gate) and globalBroker (register-socket-server.ts:47). tool-executor prefers partialCtx.broker ?? globalBroker ?? getSharedBroker().

## 4. Gate discipline
- node scripts/check-gates.mjs (from packages/server): OK - 361 files / 23 domains, 0 violations. 46 TEST-ONLY cross-domain imports (non-fatal).
- All outside imports use event-broker-gate.js; no deep imports outside the domain.
- Gate is thin (re-export only). Scope note: Mode/isValidMode rides this gate, unrelated to brokering.

## 5. Related tests (no broker-owned file)
- events/events-log.test.ts, events-integration.test.ts, events-route.test.ts.
- shared/sockets/register-socket-server.test.ts.
- runtime, swarm/delegation.test.ts, tools/tool-registry.honest.test.ts, approvals/approval-flow.integration.test.ts use broker as fixture.

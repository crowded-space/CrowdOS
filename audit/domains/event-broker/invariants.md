# event-broker - invariants (observed, with file:line)

1. Gate is thin re-export only; no logic/fetch/branch in event-broker-gate.ts (whole file).
2. Nothing outside event-broker/ imports past the gate (check-gates.mjs: 0 violations, 361 files scanned).
3. In-process only: EventEmitter per instance; no cross-process forwarding. Worker-local broker documented (shared-broker.ts:7-9); worker emits never reach API subscribers.
4. emit() never throws on oversize: >256KB logs warn + returns un-emitted event (event-broker.ts:48-58). Unserializable payload falls through to persistence (event-broker.ts:59-61).
5. One bad subscriber never breaks fan-out: per-listener try/catch in on (event-broker.ts:76-82) and onAny (event-broker.ts:99-104).
6. Channel filter falls back to payload.channelId when top-level is absent (event-broker.ts:71).
7. Exactly one persistence subscriber per API process: create-app.ts:365 onAny -> recordDetached (fire-and-forget, event-log-service.ts:118-121).
8. Classification: message:stream never persisted; events without any channelId never persisted (event-classification.ts:21-25,61-68).
9. Seq is persistence-owned, not broker-owned: live envelope seq = event.seq ?? null = null always (register-socket-server.ts:424); replayed rows carry allocated seq from JSONL allocateEventSeq (event-local-store.ts).
10. Socket scoping: channel events to joined channel rooms only; payload.workspaceId authoritative (register-socket-server.ts:414-458); global events only to live workspace rooms (+localhost io.emit fallback).
11. Timestamp is Date at emit (event-broker.ts:46); ISO string only after JSONL round-trip.
12. Approval decided has single emit helper emitDecided with warn-and-skip on missing broker (approval-gate.ts:78-94).

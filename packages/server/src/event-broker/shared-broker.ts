// Shared-instance holder for the in-process typed pub/sub bus.
//
// Sockets owns the shared instance (`registerSocketServer` registers it here);
// fallback sites resolve it via `getSharedBroker()` instead of constructing
// orphan `new EventBroker()` instances whose emits reach no subscriber.
// Worker processes have no socket server: boot sets one worker-local instance
// (local-only, never forwarded across processes — single-process design).
import type { EventBroker } from "./event-broker.js";

let sharedBroker: EventBroker | null = null;

export function getSharedBroker(): EventBroker | null {
  return sharedBroker;
}

export function setSharedBroker(broker: EventBroker | null): void {
  sharedBroker = broker;
}

export function resetSharedBrokerForTests(): void {
  sharedBroker = null;
}

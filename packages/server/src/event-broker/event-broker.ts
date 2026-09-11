import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { BrokerEvent, BrokerEventMap, BrokerEventType } from "./event-types.js";

type BrokerHandler<TType extends BrokerEventType = BrokerEventType> = (
  event: BrokerEvent<TType>,
) => void;

interface ListenerRegistration {
  eventType?: BrokerEventType;
  channelId?: string;
  handler: BrokerHandler;
}

export class EventBroker {
  private readonly emitter = new EventEmitter();
  private readonly listeners = new Map<string, ListenerRegistration>();

  // SSE fan-out guard: raise the per-event ceiling past the Node default (10)
  // so normal room fan-out never trips MaxListeners warnings, ...
  private static readonly MAX_LISTENERS = 100;
  private static readonly LISTENER_WARN_AT = 500;
  private static readonly MAX_PAYLOAD_BYTES = 256 * 1024;

  constructor() {
    this.emitter.setMaxListeners(EventBroker.MAX_LISTENERS);
  }

  private warnIfCrowded(): void {
    if (this.listeners.size > EventBroker.LISTENER_WARN_AT) {
      console.warn(`[EventBroker] listener count ${this.listeners.size} exceeds ${EventBroker.LISTENER_WARN_AT} — possible leak`);
    }
  }

  emit<TType extends BrokerEventType>(
    type: TType,
    payload: BrokerEventMap[TType],
    options?: { channelId?: string },
  ): BrokerEvent<TType> {
    const event: BrokerEvent<TType> = {
      eventId: randomUUID(),
      type,
      channelId: options?.channelId,
      payload,
      timestamp: new Date(),
    };

    // Unbounded payload guard: skip fan-out for oversized events (never throw on emit path).
    try {
      const size = JSON.stringify(payload)?.length ?? 0;
      if (size > EventBroker.MAX_PAYLOAD_BYTES) {
        console.warn(`[EventBroker] dropped ${type}: payload ${size}B exceeds ${EventBroker.MAX_PAYLOAD_BYTES}B cap`);
        return event;
      }
    } catch {
      // Unserializable payload — let it through; persistence layer will reject if needed.
    }

    this.emitter.emit(type, event);
    this.emitter.emit("*", event);

    return event;
  }

  on<TType extends BrokerEventType>(
    type: TType,
    channelId: string | undefined,
    handler: BrokerHandler<TType>,
  ): string {
    const listenerId = randomUUID();
    const wrappedHandler: BrokerHandler = (event) => {
      if (channelId && event.channelId !== channelId) {
        return;
      }

      handler(event as BrokerEvent<TType>);
    };

    this.listeners.set(listenerId, { eventType: type, channelId, handler: wrappedHandler });
    this.emitter.on(type, wrappedHandler);
    this.warnIfCrowded();

    return listenerId;
  }

  onAny(handler: BrokerHandler): string {
    const listenerId = randomUUID();
    this.listeners.set(listenerId, { handler });
    this.emitter.on("*", handler);
    this.warnIfCrowded();
    return listenerId;
  }

  off(listenerId: string): void {
    const registration = this.listeners.get(listenerId);
    if (!registration) {
      return;
    }

    this.emitter.off(registration.eventType ?? "*", registration.handler);
    this.listeners.delete(listenerId);
  }
}

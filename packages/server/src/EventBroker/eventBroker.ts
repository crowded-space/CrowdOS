import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { BrokerEvent, BrokerEventMap, BrokerEventType } from "./eventTypes.js";

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

    return listenerId;
  }

  onAny(handler: BrokerHandler): string {
    const listenerId = randomUUID();
    this.listeners.set(listenerId, { handler });
    this.emitter.on("*", handler);
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

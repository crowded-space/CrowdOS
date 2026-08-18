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
  private readonly recentEventsByChannel = new Map<string, BrokerEvent[]>();

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

    if (event.channelId) {
      const recentEvents = this.recentEventsByChannel.get(event.channelId) ?? [];
      recentEvents.push(event);
      if (recentEvents.length > 50) {
        recentEvents.shift();
      }
      this.recentEventsByChannel.set(event.channelId, recentEvents);
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

  removeChannelListeners(channelId: string): void {
    for (const [listenerId, registration] of this.listeners.entries()) {
      if (registration.channelId === channelId) {
        this.off(listenerId);
      }
    }
  }

  getRecentEvents(channelId: string, limit = 20): BrokerEvent[] {
    const events = this.recentEventsByChannel.get(channelId) ?? [];
    return events.slice(-limit);
  }
}

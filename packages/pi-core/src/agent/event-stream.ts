import type { AgentEvent } from './types.js';

export class EventStream implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private resolvers: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private done = false;
  private listeners: Array<(event: AgentEvent) => void> = [];
  /** Terminal event (agent_end / error) retained for late subscribers. */
  private terminalEvent: AgentEvent | null = null;

  emit(event: AgentEvent): void {
    if (this.done) return;

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[EventStream] Listener error:', err);
      }
    }

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }

    if (event.type === 'agent_end' || event.type === 'error') {
      this.terminalEvent = event;
      this.close();
    }
  }

  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener);
    // Late-subscription safety: the loop can emit its terminal event (and
    // close) synchronously before a caller subscribes — e.g. an abort signal
    // that is already tripped when runAgentLoop starts throws at the first
    // loop checkpoint, before prompt() returns. Consumers that await
    // completion via on() must still observe that terminal event or they
    // would wait forever. Replay it once to each late subscriber.
    if (this.done && this.terminalEvent) {
      try {
        listener(this.terminalEvent);
      } catch (err) {
        console.error('[EventStream] Listener error:', err);
      }
    }
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  close(): void {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        if (this.queue.length > 0) {
          const event = this.queue.shift()!;
          return Promise.resolve({ value: event, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

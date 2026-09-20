import { describe, expect, it } from 'vitest';
import { EventStream } from './event-stream.js';

describe('EventStream late-subscription safety', () => {
  it('replays the terminal event to a subscriber that attaches after close', () => {
    const stream = new EventStream();
    stream.emit({ type: 'agent_start', timestamp: Date.now() });
    stream.emit({ type: 'error', timestamp: Date.now(), error: 'aborted early' });

    // Subscriber attaches after the stream already closed (the abort-before-
    // prompt-returns race). Without replay it would never settle.
    const seen: string[] = [];
    stream.on((event) => {
      seen.push(event.type);
    });

    expect(seen).toEqual(['error']);
  });

  it('replays agent_end to late subscribers and does not replay to earlier ones twice', () => {
    const stream = new EventStream();
    const early: string[] = [];
    stream.on((event) => {
      early.push(event.type);
    });

    stream.emit({ type: 'message_delta', timestamp: Date.now(), content: 'hi' });
    stream.emit({ type: 'agent_end', timestamp: Date.now(), content: 'hi' });

    const late: string[] = [];
    stream.on((event) => {
      late.push(event.type);
    });

    // Early subscriber saw both live events exactly once.
    expect(early).toEqual(['message_delta', 'agent_end']);
    // Late subscriber gets only the terminal replay.
    expect(late).toEqual(['agent_end']);
  });

  it('async iteration still drains queued events including the terminal one', async () => {
    const stream = new EventStream();
    stream.emit({ type: 'agent_start', timestamp: Date.now() });
    stream.emit({ type: 'agent_end', timestamp: Date.now(), content: 'done' });

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }

    expect(events).toEqual(['agent_start', 'agent_end']);
  });
});

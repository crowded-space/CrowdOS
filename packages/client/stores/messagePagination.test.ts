import { describe, it, expect } from "vitest";
import {
  encodeBeforeParam,
  parseMessagesEnvelope,
  prependOlderMessages,
  capMessagesMirror,
  MESSAGE_MIRROR_CAP_PER_CHANNEL
} from "./messagePagination";
import type { Message } from "../types/crowdOs";

function makeMessage(channelId: string, n: number): Message {
  return {
    id: `${channelId}-msg-${n}`,
    type: 'human',
    content: `m${n}`,
    authorId: 'u',
    authorName: 'U',
    channelId,
    timestamp: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString()
  };
}

describe("PERF-5 pagination helpers", () => {
  it("parses the newest-first envelope into chronological order plus cursor", () => {
    const payload = {
      messages: [
        { id: 'b', sequenceNumber: 2 },
        { id: 'a', sequenceNumber: 1 }
      ],
      cursor: { before: { timestamp: '2026-01-01T00:00:00.000Z', seq: 1 } }
    };
    const { chronological, cursor } = parseMessagesEnvelope(payload);
    expect(chronological.map(m => m.id)).toEqual(['a', 'b']);
    expect(cursor?.before.seq).toBe(1);
  });

  it("treats a bare legacy array as already-chronological with no cursor", () => {
    const { chronological, cursor } = parseMessagesEnvelope([{ id: 'x' }, { id: 'y' }]);
    expect(chronological.map(m => m.id)).toEqual(['x', 'y']);
    expect(cursor).toBeNull();
  });

  it("tolerates an empty/garbage payload", () => {
    const { chronological, cursor } = parseMessagesEnvelope(null);
    expect(chronological).toEqual([]);
    expect(cursor).toBeNull();
  });

  it("encodes the cursor as <ISO>;<seq>", () => {
    expect(encodeBeforeParam({ before: { timestamp: '2026-01-01T00:00:00.000Z', seq: 42 } }))
      .toBe('2026-01-01T00:00:00.000Z;42');
  });

  it("prepends older pages without duplicating ids and keeps chronological order", () => {
    const existing = [makeMessage('ch', 51), makeMessage('ch', 52)];
    const older = [makeMessage('ch', 49), makeMessage('ch', 50), makeMessage('ch', 51)];
    const merged = prependOlderMessages(existing, older);
    expect(merged.map(m => m.id)).toEqual([
      'ch-msg-49', 'ch-msg-50', 'ch-msg-51', 'ch-msg-52'
    ]);
  });

  it("caps the localStorage mirror at N=200 newest per channel", () => {
    const oneChannel = Array.from({ length: 250 }, (_, i) => makeMessage('ch-a', i + 1));
    const capped = capMessagesMirror(oneChannel);
    expect(capped).toHaveLength(MESSAGE_MIRROR_CAP_PER_CHANNEL);
    expect(capped[0].id).toBe('ch-a-msg-51');
    expect(capped[capped.length - 1].id).toBe('ch-a-msg-250');
  });

  it("applies the cap per channel independently and preserves under-cap channels", () => {
    const messages = [
      ...Array.from({ length: 220 }, (_, i) => makeMessage('ch-big', i + 1)),
      ...Array.from({ length: 30 }, (_, i) => makeMessage('ch-small', i + 1))
    ];
    const capped = capMessagesMirror(messages);
    const big = capped.filter(m => m.channelId === 'ch-big');
    const small = capped.filter(m => m.channelId === 'ch-small');
    expect(big).toHaveLength(200);
    expect(big[0].id).toBe('ch-big-msg-21');
    expect(small).toHaveLength(30);
    expect(small[0].id).toBe('ch-small-msg-1');
  });

  it("returns the input untouched when under the cap", () => {
    const messages = [makeMessage('ch', 1), makeMessage('ch', 2)];
    expect(capMessagesMirror(messages)).toBe(messages);
  });
});


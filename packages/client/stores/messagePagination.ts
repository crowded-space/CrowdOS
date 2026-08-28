import type { Message } from '../types/crowd-os';

export interface PageCursor {
  before: {
    timestamp: string;
    seq: number;
  };
}

export interface MessagesEnvelope {
  messages: any[];
  cursor: PageCursor | null;
}

export const MESSAGE_MIRROR_CAP_PER_CHANNEL = 200;

export function encodeBeforeParam(cursor: PageCursor): string {
  return `${cursor.before.timestamp};${cursor.before.seq}`;
}

export function parseMessagesEnvelope(payload: unknown): { chronological: any[]; cursor: PageCursor | null } {
  if (Array.isArray(payload)) {
    return { chronological: payload as any[], cursor: null };
  }
  const envelope = (payload || {}) as MessagesEnvelope;
  const newestFirst = Array.isArray(envelope.messages) ? envelope.messages : [];
  return { chronological: [...newestFirst].reverse(), cursor: envelope.cursor ?? null };
}

export function prependOlderMessages(existing: Message[], olderChronological: Message[]): Message[] {
  const existingIds = new Set(existing.map(m => m.id));
  const fresh = olderChronological.filter(m => !existingIds.has(m.id));
  return [...fresh, ...existing];
}

export function capMessagesMirror(messages: Message[], cap: number = MESSAGE_MIRROR_CAP_PER_CHANNEL): Message[] {
  if (messages.length <= cap) return messages;
  const byChannel = new Map<string, Message[]>();
  for (const msg of messages) {
    const bucket = byChannel.get(msg.channelId);
    if (bucket) bucket.push(msg);
    else byChannel.set(msg.channelId, [msg]);
  }
  const capped: Message[] = [];
  for (const [, bucket] of byChannel) {
    if (bucket.length <= cap) {
      capped.push(...bucket);
      continue;
    }
    const sorted = [...bucket].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    capped.push(...sorted.slice(sorted.length - cap));
  }
  return capped;
}

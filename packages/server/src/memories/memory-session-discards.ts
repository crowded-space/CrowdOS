import { numEnv } from "./memory-env.js";

const DEFAULT_DISCARD_TTL_MS = 30 * 60 * 1000;

type SessionKey = string;

function keyOf(agentId: string, channelId: string): SessionKey {
  return `${agentId}:${channelId}`;
}

/**
 * Session-scoped memory suppressions (MEM-2). Notes discarded via
 * discard_memory_from_context are hidden from retrieval/previews for this
 * agent+channel until the TTL lapses or the process restarts.
 */
class MemorySessionDiscards {
  private entries = new Map<SessionKey, Map<string, number>>();

  discard(agentId: string, channelId: string, noteIds: string[], ttlMs?: number): void {
    if (!agentId || noteIds.length === 0) return;
    const ttl = ttlMs ?? numEnv("MEM_DISCARD_TTL_MS", DEFAULT_DISCARD_TTL_MS);
    const expiresAt = Date.now() + ttl;
    const key = keyOf(agentId, channelId);
    const bucket = this.entries.get(key) ?? new Map<string, number>();
    for (const id of noteIds) bucket.set(id, expiresAt);
    this.entries.set(key, bucket);
  }

  listDiscarded(agentId: string, channelId: string, now: number = Date.now()): string[] {
    const bucket = this.entries.get(keyOf(agentId, channelId));
    if (!bucket) return [];
    const live: string[] = [];
    for (const [noteId, expiresAt] of bucket) {
      if (expiresAt > now) live.push(noteId);
      else bucket.delete(noteId);
    }
    return live;
  }

  clearAll(): void {
    this.entries.clear();
  }
}

export const memorySessionDiscards = new MemorySessionDiscards();

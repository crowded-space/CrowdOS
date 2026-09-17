// ─── Message Local Store (C3 local-first) ─────────────────────────────
// File truth for channel messages when no DATABASE_URL is configured.
// messages/<channelId>.jsonl (one row per line) + sequences.json counters.
// ponytail: O(n) scans per read; single-user local mode only. Counter is
// bumped BEFORE the message lands so a crash leaves a gap, never a dup.

import { appendJsonl, mutateJsonObject, readJsonl } from "../shared/core/local-file.js";

export interface LocalMessageRow {
  id: string;
  channelId: string;
  threadId: string | null;
  workspaceId: string | null;
  authorId: string;
  authorName: string;
  authorLevel: string;
  authorType: string;
  content: string;
  mentions: unknown[];
  metadata: Record<string, unknown> | null;
  toolCalls: unknown[] | null;
  isInternalMonologue: boolean;
  sequenceNumber: number;
  timestamp: string;
}

const SEQUENCES_FILE = "sequences.json";

function revive(row: LocalMessageRow): any {
  return {
    ...row,
    mentions: row.mentions ?? [],
    timestamp: new Date(row.timestamp),
  };
}

/**
 * Bump-first sequence counter for a channel or thread key. Returns the LAST
 * reserved value (allocateSequence parity). Thread batches (count > 1) take
 * the START value instead (allocateThreadSequence parity) — pass start=true.
 */
export async function localAllocateSequence(key: string, count = 1, start = false): Promise<number> {
  let next = count;
  await mutateJsonObject<number>(SEQUENCES_FILE, (obj) => {
    const current = typeof obj[key] === "number" ? (obj[key] as number) : 0;
    next = current + count;
    obj[key] = next;
  });
  return start ? next - count + 1 : next;
}

export async function localAppendMessage(row: LocalMessageRow): Promise<any> {
  await appendJsonl(row.channelId, row as unknown as Record<string, unknown>);
  return revive(row);
}

/** Raw rows newest-first (timestamp desc, seq desc), with optional keyset page. */
export async function localListRawMessages(
  channelId: string,
  opts: { limit?: number; before?: { timestamp: Date; seq: number } } = {},
): Promise<any[]> {
  const limit = opts.limit ?? 51;
  const rows = await readJsonl(channelId);
  const inChannel = rows.filter((r) => (r as unknown as LocalMessageRow).channelId === channelId);
  const filtered = opts.before
    ? inChannel.filter((r) => {
        const m = r as unknown as LocalMessageRow;
        const ts = new Date(m.timestamp).getTime();
        const beforeTs = opts.before!.timestamp.getTime();
        return ts < beforeTs || (ts === beforeTs && m.sequenceNumber < opts.before!.seq);
      })
    : inChannel;
  filtered.sort((a, b) => {
    const ma = a as unknown as unknown as LocalMessageRow;
    const mb = b as unknown as unknown as LocalMessageRow;
    const tsDiff = new Date(mb.timestamp).getTime() - new Date(ma.timestamp).getTime();
    if (tsDiff !== 0) return tsDiff;
    return mb.sequenceNumber - ma.sequenceNumber;
  });
  return filtered.slice(0, limit).map((r) => revive(r as unknown as LocalMessageRow));
}

/** Raw rows newest-first for context middlewares (no paging). */
export async function localRecentMessages(channelId: string, limit: number): Promise<any[]> {
  return localListRawMessages(channelId, { limit });
}

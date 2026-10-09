// ─── Message Local Store (C3 local-first) ─────────────────────────────
// File truth for channel messages when no DATABASE_URL is configured.
//
// Canon (mock-structure-polished): messages live inside their workspace:
//
//   <workspaceFolder>/vfs/.crowdos/messages/<channelId>.jsonl
//   <workspaceFolder>/vfs/.crowdos/sequences.json
//
// A channel belongs to exactly one workspace, so the workspace id scopes both
// the log and its counter. ponytail: O(n) scans per read; single-user local mode
// only. The counter is bumped BEFORE the message lands so a crash leaves a gap,
// never a dup.

import { appendJsonlIfAbsentByIdWithFactory, isTestStoreDir, mutateJsonlRows, mutateJsonObject, readJsonl } from "../shared/core/local-file.js";

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
export async function localAllocateSequence(
  key: string,
  count = 1,
  start = false,
  workspaceId?: string | null,
): Promise<number> {
  let next = count;
  await mutateJsonObject<number>(SEQUENCES_FILE, (obj) => {
    const current = typeof obj[key] === "number" ? (obj[key] as number) : 0;
    next = current + count;
    obj[key] = next;
  }, workspaceId);
  return start ? next - count + 1 : next;
}

/**
 * Raise a counter to at least the given floor (never lowers it). §17 migration
 * path: when the local log for a channel is empty but the PG replica already
 * holds history, the local counter must not restart at 1 — a reissued seq would
 * make the replica leg collide and silently drop the row. Returns the effective
 * value after flooring.
 */
export async function localFloorSequence(
  key: string,
  floor: number,
  workspaceId?: string | null,
): Promise<number> {
  if (!Number.isFinite(floor) || floor <= 0) {
    return localAllocateSequence(key, 0, false, workspaceId);
  }
  let effective = floor;
  await mutateJsonObject<number>(SEQUENCES_FILE, (obj) => {
    const current = typeof obj[key] === "number" ? (obj[key] as number) : 0;
    effective = Math.max(current, floor);
    obj[key] = effective;
  }, workspaceId);
  return effective;
}

export async function localAppendMessage(
  createRow: (sequenceNumber: number) => Promise<LocalMessageRow>,
  messageId: string,
  channelId: string,
  reserveSequence: () => Promise<number>,
  workspaceId?: string | null,
): Promise<{ row: any; appended: boolean }> {
  const result = await appendJsonlIfAbsentByIdWithFactory(
    channelId,
    messageId,
    async () => {
      const sequenceNumber = await reserveSequence();
      const row = await createRow(sequenceNumber);
      return row as unknown as Record<string, unknown> & { id: string };
    },
    workspaceId,
  );
  return { row: revive(result.row as unknown as LocalMessageRow), appended: result.appended };
}

/** Raw rows newest-first (timestamp desc, seq desc), with optional keyset page. */
export async function localListRawMessages(
  channelId: string,
  opts: { limit?: number; before?: { timestamp: Date; seq: number }; workspaceId?: string | null; threadId?: string } = {},
): Promise<any[]> {
  const limit = opts.limit ?? 51;
  const rows = await readJsonl(channelId, opts.workspaceId);
  const inChannel = rows.filter((r) => {
    const message = r as unknown as LocalMessageRow;
    return message.channelId === channelId && (opts.threadId === undefined || message.threadId === opts.threadId);
  });
  const filtered = opts.before
    ? inChannel.filter((r) => {
        const m = r as unknown as LocalMessageRow;
        const ts = new Date(m.timestamp).getTime();
        const beforeTs = opts.before!.timestamp.getTime();
        return ts < beforeTs || (ts === beforeTs && m.sequenceNumber < opts.before!.seq);
      })
    : inChannel;
  filtered.sort((a, b) => {
    const ma = a as unknown as LocalMessageRow;
    const mb = b as unknown as LocalMessageRow;
    const tsDiff = new Date(mb.timestamp).getTime() - new Date(ma.timestamp).getTime();
    if (tsDiff !== 0) return tsDiff;
    return mb.sequenceNumber - ma.sequenceNumber;
  });
  return filtered.slice(0, limit).map((r) => revive(r as unknown as LocalMessageRow));
}

/** Raw rows newest-first for context middlewares (no paging). */
export async function localRecentMessages(
  channelId: string,
  limit: number,
  workspaceId?: string | null,
): Promise<any[]> {
  return localListRawMessages(channelId, { limit, workspaceId });
}

/** Exact raw-message lookup within one channel log and workspace folder. */
export async function localMessageExists(
  messageId: string,
  channelId: string,
  workspaceId?: string | null,
): Promise<boolean> {
  const scope = workspaceId ?? "default";
  const sharedOverride = !isTestStoreDir() && Boolean(process.env.CROWDOS_LOCALSTORE_DIR?.trim());
  const rows = await readJsonl(channelId, workspaceId);
  return rows.some((row) => {
    const message = row as unknown as LocalMessageRow;
    const rowWorkspaceId = message.workspaceId;
    const rowMatchesScope = rowWorkspaceId == null
      ? !sharedOverride || scope === "default"
      : (rowWorkspaceId === "default" ? "default" : rowWorkspaceId) === scope;
    return message.id === messageId &&
      message.channelId === channelId &&
      rowMatchesScope;
  });
}

/** Detach replies from a deleted thread without racing message appends. */
export async function localDetachThreadReplies(
  channelId: string,
  threadId: string,
  workspaceId?: string | null,
): Promise<number> {
  return mutateJsonlRows(
    channelId,
    workspaceId,
    (row) => row.channelId === channelId && row.threadId === threadId,
    (row) => ({ ...row, threadId: null }),
  );
}

/**
 * MSG-004: the single row immediately older/newer than a reference tuple —
 * merge context for page boundaries. The page path already carries one
 * older-context row (the limit+1 probe); this helper supplies the NEWER side
 * for pages fetched with a `before` cursor, so a trailing monologue on an
 * older page can pair with its final on the newer page instead of surfacing
 * as a misplaced synthetic row.
 */
export async function localAdjacentMessage(
  channelId: string,
  ref: { timestamp: Date | string; seq: number },
  direction: "older" | "newer",
  workspaceId?: string | null,
): Promise<any | null> {
  const rows = await readJsonl(channelId, workspaceId);
  const refTs = new Date(ref.timestamp).getTime();
  const candidates = rows.filter((r) => {
    const m = r as unknown as LocalMessageRow;
    if (m.channelId !== channelId) return false;
    const ts = new Date(m.timestamp).getTime();
    if (direction === "older") return ts < refTs || (ts === refTs && m.sequenceNumber < ref.seq);
    return ts > refTs || (ts === refTs && m.sequenceNumber > ref.seq);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ma = a as unknown as LocalMessageRow;
    const mb = b as unknown as LocalMessageRow;
    const tsDiff = new Date(ma.timestamp).getTime() - new Date(mb.timestamp).getTime();
    if (tsDiff !== 0) return tsDiff;
    return ma.sequenceNumber - mb.sequenceNumber;
  });
  // Sorted oldest-first: the nearest older row is last, the nearest newer is first.
  const pick = direction === "older" ? candidates[candidates.length - 1] : candidates[0];
  return revive(pick as unknown as LocalMessageRow);
}

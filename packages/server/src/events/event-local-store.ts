// ─── Local Event Log store (CrowdOS §29 channel history persistence) ───
// Append-only, workspace-scoped event history for one channel.
//
// Canon (mock-structure-polished): the log lives INSIDE the workspace that owns
// the channel:
//
//   <workspaceFolder>/vfs/.crowdos/events/<channelId>.jsonl   one JSON record per line
//   <workspaceFolder>/vfs/.crowdos/event-sequences.json       "<channelId>" counter
//
// §30 isolation: a channel belongs to exactly one workspace, so two workspaces
// never share a log file. Every record also carries its owning workspaceId, so a
// reader can assert the tenant boundary instead of trusting the path alone.
//
// SEQ SEMANTICS (read this before using afterSeq): the event seq is its OWN
// monotonic per-channel space. It is deliberately NOT the message
// sequenceNumber space (messages/<channelId>.jsonl + sequences.json): messages
// already own that counter and a second writer sharing it would make message
// seqs sparse. The client keeps ONE channelSeq high-water mark per channel
// across both spaces; because a channel emits several events per message, the
// event space advances at least as fast as the message space, so a
// message-derived cursor always trails the event head — replay errs toward
// re-delivery (deduped client-side by message id), never toward skipping
// unseen messages. See the domain spec for the full contract and its limits.
//
// Retention: NONE. The log grows for the lifetime of the workspace (the message
// log is also never pruned). Bounding it is a follow-up decision, documented in
// the domain spec rather than silently implemented here.
//
// ponytail: O(n) scans per read; the shared local-file mutex is single-process,
// so multi-process writers (api + worker) would need a real store. Local mode
// is single-process by design.

import {
  appendEventJsonl,
  mutateJsonObject,
  readEventJsonl,
  withStoreLock,
} from "../shared/core/local-file.js";
import type { EventLogRecord, ListRecentEventsOptions, RecentEventsResult } from "./event-log-types.js";

/** Counter file for the event log (distinct from the message sequences.json). */
export const EVENT_SEQUENCES_FILE = "event-sequences.json";

/** Default page size when the caller does not pass a limit. */
export const DEFAULT_EVENT_PAGE_LIMIT = 100;

/** Hard ceiling — mirrors the route's zod cap so both agree on one number. */
export const MAX_EVENT_PAGE_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_EVENT_PAGE_LIMIT;
  return Math.min(MAX_EVENT_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Raw rows in file order. Torn / partial / non-object lines are skipped by the
 * shared JSONL reader, so a crash mid-append can never make a read throw.
 */
export async function readEventRows(
  channelId: string,
  workspaceId?: string | null,
): Promise<EventLogRecord[]> {
  const rows = await readEventJsonl(channelId, workspaceId);
  return rows as unknown as EventLogRecord[];
}

/** Highest seq present in the log (0 when absent/empty). */
export async function eventHeadSeq(channelId: string, workspaceId?: string | null): Promise<number> {
  const rows = await readEventRows(channelId, workspaceId);
  let head = 0;
  for (const row of rows) {
    const seq = Number(row?.seq);
    if (Number.isFinite(seq) && seq > head) head = seq;
  }
  return head;
}

// §17-style migration bridge, event-log flavour: a counter file can be lost or
// restored independently of the log it counts (backup restore, manual copy, a
// fresh workspace over an existing events/ dir). Flooring to the file head once
// per channel per process keeps "seq is monotonic per channel" true — a reset
// counter would otherwise re-issue seqs already in the log, and afterSeq would
// silently start skipping. Bounded: one entry per workspace+channel, process-local.
const flooredChannels = new Set<string>();

function floorKey(workspaceId: string | null | undefined, channelId: string): string {
  return (workspaceId ?? "default") + ":" + channelId;
}

/**
 * Reserve the next seq for a channel.
 *
 * Bump-first (like the message counter): the counter advances BEFORE the line
 * is appended, so a crash between the two leaves a gap, never a duplicate.
 */
export async function allocateEventSeq(channelId: string, workspaceId?: string | null): Promise<number> {
  const key = floorKey(workspaceId, channelId);
  if (!flooredChannels.has(key)) {
    const head = await eventHeadSeq(channelId, workspaceId).catch(() => 0);
    if (head > 0) {
      await mutateJsonObject<number>(EVENT_SEQUENCES_FILE, (obj) => {
        const current = typeof obj[channelId] === "number" ? (obj[channelId] as number) : 0;
        obj[channelId] = Math.max(current, head);
      }, workspaceId);
    }
    flooredChannels.add(key);
  }
  let next = 0;
  await mutateJsonObject<number>(EVENT_SEQUENCES_FILE, (obj) => {
    const current = typeof obj[channelId] === "number" ? (obj[channelId] as number) : 0;
    next = current + 1;
    obj[channelId] = next;
  }, workspaceId);
  return next;
}

/** Test-only: forget the per-process floor memo (mirrors resetSharedBrokerForTests). */
export function resetEventSeqFloorForTests(): void {
  flooredChannels.clear();
}

/**
 * Append one record to the channel's event log.
 *
 * The caller owns the seq (see allocateEventSeq) so a single append can be
 * retried or reordered by its owner without re-deriving history. Returns the
 * persisted record so the emit path can fan it out with the same seq.
 */
export async function appendEventRecord(
  record: EventLogRecord,
  workspaceId?: string | null,
): Promise<EventLogRecord> {
  await appendEventJsonl(
    record.channelId,
    record as unknown as Record<string, unknown>,
    workspaceId ?? record.workspaceId ?? null,
  );
  return record;
}

/**
 * Serialized allocate+append for one channel: holds the per-channel event lock
 * across both steps so file order matches seq order (one writer per channel at
 * a time). Failures propagate to the caller, which decides how to report them.
 */
export async function appendNextEvent(
  channelId: string,
  build: (seq: number) => EventLogRecord,
  workspaceId?: string | null,
): Promise<EventLogRecord> {
  return withStoreLock("eventlog:" + (workspaceId ?? "default") + ":" + channelId, async () => {
    const seq = await allocateEventSeq(channelId, workspaceId);
    return appendEventRecord(build(seq), workspaceId);
  });
}

/**
 * Ascending tail of the log after an exclusive cursor.
 *
 * lastSeq is the highest seq RETURNED, or the current head when the tail is
 * empty — a client that polled with afterSeq = head gets events: [] plus
 * lastSeq = head and knows it is caught up instead of re-requesting forever.
 * Rows are sorted by seq rather than trusted in file order, so an out-of-order
 * line (only reachable if the mutex contract were broken) cannot corrupt a page.
 */
export async function listEventTail(
  channelId: string,
  opts: ListRecentEventsOptions = {},
  workspaceId?: string | null,
): Promise<RecentEventsResult> {
  const rows = await readEventRows(channelId, workspaceId);
  const afterSeq =
    typeof opts.afterSeq === "number" && Number.isFinite(opts.afterSeq) ? opts.afterSeq : undefined;
  const limit = clampLimit(opts.limit);

  let headSeq = 0;
  const tail: EventLogRecord[] = [];
  for (const row of rows) {
    const seq = Number(row?.seq);
    if (!Number.isFinite(seq)) continue;
    if (seq > headSeq) headSeq = seq;
    if (afterSeq !== undefined && seq <= afterSeq) continue;
    tail.push(row);
  }
  tail.sort((a, b) => Number(a.seq) - Number(b.seq));

  const events = tail.slice(0, limit);
  const lastSeq = events.length > 0 ? Number(events[events.length - 1].seq) : headSeq;
  return { events, lastSeq, headSeq };
}

/** Raw rows newest-first, for diagnostics and retention-style scans. */
export async function listEventRowsNewestFirst(
  channelId: string,
  workspaceId?: string | null,
): Promise<EventLogRecord[]> {
  const rows = await readEventRows(channelId, workspaceId);
  return rows.slice().sort((a, b) => Number(b.seq) - Number(a.seq));
}

// ─── Local Event Log types (CrowdOS §29 channel history persistence) ───
// Shape of one line in events/<channelId>.jsonl. Every field is JSON-safe:
// `createdAt` is an ISO string (not a Date) so a line round-trips through the
// append-only file unchanged, and `ts` keeps the epoch-ms form cheap to sort
// and compare without re-parsing dates.

import type { BrokerEventType } from "../event-broker/event-broker-gate.js";

export interface EventLogRecord {
  /** Monotonic per channel; allocated from the local counter, never reused. */
  seq: number;
  /** Broker eventId — the correlation id of the emit that produced this line. */
  eventId: string;
  type: BrokerEventType;
  payload: unknown;
  /** ISO-8601 emit timestamp. */
  createdAt: string;
  /** Epoch ms of `createdAt` (sort/torn-line friendly). */
  ts: number;
  channelId: string;
  /** Owning workspace when known (§30 scoping audit); null when unresolvable. */
  workspaceId: string | null;
  /** Payload agentId when the event carries one; null otherwise. */
  agentId: string | null;
}

export interface ListRecentEventsOptions {
  /** Exclusive cursor: only records with `seq > afterSeq` are returned. */
  afterSeq?: number;
  limit?: number;
}

export interface RecentEventsResult {
  /** Ascending by seq, capped at the requested limit. */
  events: EventLogRecord[];
  /** Highest seq returned, or the current head when nothing is after afterSeq. */
  lastSeq: number;
  /** Highest seq in the whole log (0 when the log is absent or empty). */
  headSeq: number;
}

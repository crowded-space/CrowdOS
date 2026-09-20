// ─── Event Log service (§29 local event log + /api/events/recent) ──────
// Two responsibilities, both thin over the local store:
//
//   1. recordBrokerEvent — the ONE append hook. Registered as a broker `onAny`
//      subscriber at boot, so no producer call site ever appends by hand. The
//      old durable_events design was the same shape (a single `onAny` fan-out
//      that classified and persisted); this is that intent minus PG.
//
//   2. listRecentEvents — the read behind GET /api/events/recent.
//
// Appends are best-effort: a failing log must never break live delivery or a
// run, exactly like the retired fire-and-forget dual-write. The difference is
// that the failure is now VISIBLE (console.warn + a counter) instead of being
// swallowed by a `.catch(console.error)` deep in the socket bridge.

import type { BrokerEvent } from "../event-broker/event-broker-gate.js";
import { appendNextEvent, listEventTail } from "./event-local-store.js";
import {
  resolveEventAgentId,
  resolveEventChannelId,
  resolveEventWorkspaceId,
  shouldLogEvent,
} from "./event-classification.js";
import type { EventLogRecord, ListRecentEventsOptions, RecentEventsResult } from "./event-log-types.js";

/** Process-lifetime counters so dropped/failed appends are observable, not silent. */
export const eventLogStats = {
  appended: 0,
  skipped: 0,
  failed: 0,
};

/** Test-only: zero the counters. */
export function resetEventLogStatsForTests(): void {
  eventLogStats.appended = 0;
  eventLogStats.skipped = 0;
  eventLogStats.failed = 0;
}

/**
 * Append one broker event to its channel's log. Resolves to the persisted
 * record, or null when the event was classified as not-logged (ephemeral, or no
 * channelId). Never throws: callers are hot emit paths.
 *
 * The payload is stored as-is. Oversized payloads never reach here — the broker
 * drops them before fan-out — and the log is local-disk-only, so there is no
 * wire-size constraint to enforce a second time.
 */
export async function recordBrokerEvent(
  event: Pick<BrokerEvent, "eventId" | "type" | "channelId" | "payload" | "timestamp">,
): Promise<EventLogRecord | null> {
  if (!shouldLogEvent(event)) {
    eventLogStats.skipped += 1;
    return null;
  }
  const channelId = resolveEventChannelId(event)!;
  const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date();
  try {
    const record = await appendNextEvent(channelId, (seq) => ({
      seq,
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
      createdAt: timestamp.toISOString(),
      ts: timestamp.getTime(),
      channelId,
      workspaceId: resolveEventWorkspaceId(event.payload),
      agentId: resolveEventAgentId(event.payload),
    }));
    eventLogStats.appended += 1;
    return record;
  } catch (err) {
    eventLogStats.failed += 1;
    // Never throws on the emit path: local log lag is a warning, not a failure.
    console.warn(
      `[event-log] failed to append ${event.type} for channel ${channelId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/**
 * Fire-and-forget wrapper for the broker subscriber. The broker's `onAny`
 * handler is synchronous, so the append is detached here and its rejection is
 * already handled inside `recordBrokerEvent`.
 */
export function recordBrokerEventDetached(
  event: Pick<BrokerEvent, "eventId" | "type" | "channelId" | "payload" | "timestamp">,
): void {
  void recordBrokerEvent(event);
}

/**
 * Read the ascending event tail for a channel.
 *
 * Honest empty: an absent log answers `events: []` with `lastSeq: 0` — never a
 * fabricated event, never an echoed request cursor pretending to be history.
 */
export async function listRecentEvents(
  channelId: string,
  opts: ListRecentEventsOptions = {},
): Promise<RecentEventsResult> {
  return listEventTail(channelId, opts);
}

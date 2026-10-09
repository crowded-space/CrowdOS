// Depends-on: EventBroker (types only)
import {
  listRecentEvents,
  recordBrokerEvent,
  recordBrokerEventDetached,
  eventLogStats,
  invalidateChannelWorkspace,
  resetEventLogStatsForTests,
} from "./event-log-service.js";
import {
  EPHEMERAL_EVENT_TYPES,
  isEphemeralEventType,
  resolveEventChannelId,
  shouldLogEvent,
} from "./event-classification.js";
import {
  DEFAULT_EVENT_PAGE_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  allocateEventSeq,
  appendEventRecord,
  eventHeadSeq,
  listEventRowsNewestFirst,
  resetEventSeqFloorForTests,
} from "./event-local-store.js";
import type { EventLogRecord, ListRecentEventsOptions, RecentEventsResult } from "./event-log-types.js";

export type { EventLogRecord, ListRecentEventsOptions, RecentEventsResult };
export {
  listRecentEvents,
  recordBrokerEvent,
  recordBrokerEventDetached,
  eventLogStats,
  invalidateChannelWorkspace,
  resetEventLogStatsForTests,
  EPHEMERAL_EVENT_TYPES,
  isEphemeralEventType,
  resolveEventChannelId,
  shouldLogEvent,
  DEFAULT_EVENT_PAGE_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  allocateEventSeq,
  appendEventRecord,
  eventHeadSeq,
  listEventRowsNewestFirst,
  resetEventSeqFloorForTests,
};

/** Domain facade: the only surface other domains may import. */
export const eventsGate = {
  record: recordBrokerEvent,
  recordDetached: recordBrokerEventDetached,
  listRecent: listRecentEvents,
  headSeq: eventHeadSeq,
  isEphemeral: isEphemeralEventType,
  stats: eventLogStats,
  // EVT-04: channel owner changed — drop the memoized workspace.
  invalidateChannelWorkspace,
};

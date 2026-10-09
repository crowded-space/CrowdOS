import type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor, ThreadMessagesPage } from "./message-types.js";
import { getMessagesParamsSchema, getMessagesQuerySchema } from "./message-validators.js";
import type { GetMessagesParams, GetMessagesQuery } from "./message-validators.js";
import {
  getChannelMessagesPage,
  getThreadMessagesPage,
  messageExistsInChannel,
  detachThreadReplies,
  listRecentMessages,
  parseBeforeCursor,
  MalformedCursorError,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  appendMessage,
} from "./message-service.js";
import type { AppendMessageInput, AppendMessageOpts } from "./message-service.js";

export type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor, ThreadMessagesPage };
export { getMessagesParamsSchema, getMessagesQuerySchema };
export type { GetMessagesParams, GetMessagesQuery };
// MSG-013: MAX_PAGE_LIMIT re-exported so validators and callers share one ceiling.
export { getChannelMessagesPage, getThreadMessagesPage, messageExistsInChannel, detachThreadReplies, listRecentMessages, parseBeforeCursor, MalformedCursorError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, appendMessage };
export type { AppendMessageInput, AppendMessageOpts };

export const messageGate = {
  getChannelMessagesPage,
  // THR-015: thread-scoped RAW page owned by Messages; the Threads domain
  // reads thread replies through this port instead of message-local-store.
  getThreadPage: getThreadMessagesPage,
  existsInChannel: messageExistsInChannel,
  detachThreadReplies,
  listRecent: listRecentMessages,
  parseBeforeCursor,
  append: appendMessage
};

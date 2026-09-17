import type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor } from "./message-types.js";
import { getMessagesParamsSchema, getMessagesQuerySchema } from "./message-validators.js";
import type { GetMessagesParams, GetMessagesQuery } from "./message-validators.js";
import {
  getChannelMessagesPage,
  listRecentMessages,
  parseBeforeCursor,
  MalformedCursorError,
  DEFAULT_PAGE_LIMIT,
  appendMessage,
} from "./message-service.js";
import type { AppendMessageInput, AppendMessageOpts } from "./message-service.js";

export type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor };
export { getMessagesParamsSchema, getMessagesQuerySchema };
export type { GetMessagesParams, GetMessagesQuery };
export { getChannelMessagesPage, listRecentMessages, parseBeforeCursor, MalformedCursorError, DEFAULT_PAGE_LIMIT, appendMessage };
export type { AppendMessageInput, AppendMessageOpts };

export const messageGate = {
  getChannelMessagesPage,
  listRecent: listRecentMessages,
  parseBeforeCursor,
  append: appendMessage
};

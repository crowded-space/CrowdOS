import type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor } from "./message-types.js";
import { getMessagesParamsSchema, getMessagesQuerySchema } from "./message-validators.js";
import type { GetMessagesParams, GetMessagesQuery } from "./message-validators.js";
import {
  getChannelMessages,
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError,
  DEFAULT_PAGE_LIMIT,
} from "./message-service.js";

export type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor };
export { getMessagesParamsSchema, getMessagesQuerySchema };
export type { GetMessagesParams, GetMessagesQuery };
export { getChannelMessages, getChannelMessagesPage, parseBeforeCursor, MalformedCursorError, DEFAULT_PAGE_LIMIT };

export const messageGate = {
  getChannelMessages,
  getChannelMessagesPage,
  parseBeforeCursor
};

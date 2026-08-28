import type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor } from "./messageTypes.js";
import { getMessagesParamsSchema, getMessagesQuerySchema } from "./messageValidators.js";
import type { GetMessagesParams, GetMessagesQuery } from "./messageValidators.js";
import {
  getChannelMessages,
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError,
  DEFAULT_PAGE_LIMIT,
} from "./messageService.js";

export type { ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor };
export { getMessagesParamsSchema, getMessagesQuerySchema };
export type { GetMessagesParams, GetMessagesQuery };
export { getChannelMessages, getChannelMessagesPage, parseBeforeCursor, MalformedCursorError, DEFAULT_PAGE_LIMIT };

export const messageGate = {
  getChannelMessages,
  getChannelMessagesPage,
  parseBeforeCursor
};

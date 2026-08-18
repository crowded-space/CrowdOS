import type { ChannelMessage } from "./messageTypes.js";
import { getMessagesParamsSchema, getMessagesQuerySchema } from "./messageValidators.js";
import type { GetMessagesParams, GetMessagesQuery } from "./messageValidators.js";
import { getChannelMessages } from "./messageService.js";

export type { ChannelMessage };
export { getMessagesParamsSchema, getMessagesQuerySchema };
export type { GetMessagesParams, GetMessagesQuery };
export { getChannelMessages };

export const messageGate = {
  getChannelMessages
};

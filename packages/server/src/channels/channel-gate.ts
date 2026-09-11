import type {
  Category,
  ChannelType,
  Channel,
  ChannelIndex,
  CompressedSummary
} from "./channel-types.js";
import {
  channelTypeSchema,
  createChannelSchema,
  updateChannelSchema,
  paramIdSchema
} from "./channel-validators.js";
import type {
  CreateChannelBody,
  UpdateChannelBody,
  ChannelParams
} from "./channel-validators.js";
import {
  categoryExists,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel
} from "./channel-service.js";

export type { Category, ChannelType, Channel, ChannelIndex, CompressedSummary };
export { channelTypeSchema, createChannelSchema, updateChannelSchema, paramIdSchema };
export type { CreateChannelBody, UpdateChannelBody, ChannelParams };
export {
  categoryExists,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel
};

export const channelGate = {
  categoryExists,
  list: listChannels,
  get: getChannel,
  create: createChannel,
  update: updateChannel,
  remove: deleteChannel
};

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
  getCategoryById,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelSettings,
  updateChannelSettings
} from "./channel-service.js";
import type { ChannelSettingsPatch } from "./channel-service.js";

export type { Category, ChannelType, Channel, ChannelIndex, CompressedSummary, ChannelSettingsPatch };
export { channelTypeSchema, createChannelSchema, updateChannelSchema, paramIdSchema };
export type { CreateChannelBody, UpdateChannelBody, ChannelParams };
export {
  categoryExists,
  getCategoryById,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelSettings,
  updateChannelSettings
};

export const channelGate = {
  categoryExists,
  getCategory: getCategoryById,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  list: listChannels,
  get: getChannel,
  create: createChannel,
  update: updateChannel,
  remove: deleteChannel,
  getSettings: getChannelSettings,
  updateSettings: updateChannelSettings
};

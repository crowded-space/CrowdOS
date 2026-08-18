import { z } from "zod";

export const channelTypeSchema = z.enum(["standard", "pair_private", "archived"]);

export const createChannelSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().min(1),
  type: channelTypeSchema.default("standard"),
  createdBy: z.string().min(1),
  position: z.number().int().default(0),
});

export const updateChannelSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().optional(),
  type: channelTypeSchema.optional(),
  position: z.number().int().optional(),
});

export const paramIdSchema = z.object({
  id: z.string().min(1)
});

export type CreateChannelBody = z.infer<typeof createChannelSchema>;
export type UpdateChannelBody = z.infer<typeof updateChannelSchema>;
export type ChannelParams = z.infer<typeof paramIdSchema>;

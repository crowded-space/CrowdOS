import { z } from "zod";

export const channelTypeSchema = z.enum(["standard", "pair_private", "archived"]);

/**
 * Canon virtual mount descriptor (mock-structure-polished).
 *
 * Mounts are declared in VIRTUAL paths — what the agent sees — not host paths:
 * `source` is where content is read from, `target` is where it appears.
 * `mode` is "inherit" (follow the parent level) or "override" (use this list);
 * the workspace level uses "default". Host mounts keep their own jail and live
 * in a separate field (`folderPath`).
 */
export const fsMountSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1).default("local"),
  readOnly: z.boolean().default(false),
});

export const fsMountsSchema = z.object({
  scope: z.enum(["workspace", "category", "channel"]),
  mode: z.enum(["default", "inherit", "override"]),
  mounts: z.array(fsMountSchema).default([]),
});

export type FsMountBody = z.infer<typeof fsMountSchema>;
export type FsMountsBody = z.infer<typeof fsMountsSchema>;

export const createChannelSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().min(1),
  type: channelTypeSchema.default("standard"),
  createdBy: z.string().min(1),
  position: z.number().int().default(0),
  /** Canon virtual mounts; omit to inherit from the parent level. */
  fsMounts: fsMountsSchema.optional(),
});

export const updateChannelSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().optional(),
  type: channelTypeSchema.optional(),
  position: z.number().int().optional(),
  /** Canon virtual mounts: an override list, or inherit/empty to follow the parent. */
  fsMounts: fsMountsSchema.optional(),
});

export const paramIdSchema = z.object({
  id: z.string().min(1)
});

export type CreateChannelBody = z.infer<typeof createChannelSchema>;
export type UpdateChannelBody = z.infer<typeof updateChannelSchema>;
export type ChannelParams = z.infer<typeof paramIdSchema>;

import { z } from "zod";

export const getMessagesParamsSchema = z.object({
  channelId: z.string().min(1),
});

export const getMessagesQuerySchema = z.object({
  includeMonologue: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().min(1).optional(),
});

export type GetMessagesParams = z.infer<typeof getMessagesParamsSchema>;
export type GetMessagesQuery = z.infer<typeof getMessagesQuerySchema>;

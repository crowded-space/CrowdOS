import { z } from "zod";

export const getMessagesParamsSchema = z.object({
  channelId: z.string().min(1),
});

export const getMessagesQuerySchema = z.object({
  includeMonologue: z.coerce.boolean().optional().default(false),
});

export type GetMessagesParams = z.infer<typeof getMessagesParamsSchema>;
export type GetMessagesQuery = z.infer<typeof getMessagesQuerySchema>;

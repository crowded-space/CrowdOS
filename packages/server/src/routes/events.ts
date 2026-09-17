import type { FastifyInstance } from "fastify";
import { z } from "zod";

const recentEventsQuerySchema = z.object({
  channelId: z.string().min(1),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * D6: durable_events retired. Catch-up is message refetch
 * (GET /api/channels/:id/messages). This endpoint stays as a no-op
 * contract so old clients don't crash: always empty, lastSeq echoed.
 */
export async function eventRoutes(app: FastifyInstance) {
  app.get(
    "/api/events/recent",
    {
      schema: {
        querystring: recentEventsQuerySchema,
      },
    },
    async (request) => {
      const { channelId, afterSeq } = request.query as {
        channelId: string;
        afterSeq?: number;
        limit?: number;
      };
      return { channelId, events: [], lastSeq: afterSeq ?? 0, deprecated: true };
    }
  );
}

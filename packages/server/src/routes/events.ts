import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../Shared/config/database.js";
import { durableEvents } from "../db/schema.js";

const recentEventsQuerySchema = z.object({
  channelId: z.string().min(1),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * Durable event replay (HM3).
 * GET /api/events/recent?channelId=...&afterSeq=N&limit=100
 * Ordered ascending by seq — clients resume with afterSeq = last seen seq.
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
      const { channelId, afterSeq, limit = 100 } = request.query as {
        channelId: string;
        afterSeq?: number;
        limit?: number;
      };
      const db = getDb();

      const where =
        afterSeq !== undefined
          ? and(eq(durableEvents.channelId, channelId), gt(durableEvents.seq, afterSeq))
          : eq(durableEvents.channelId, channelId);

      const rows = await db.query.durableEvents.findMany({
        where,
        orderBy: [asc(durableEvents.seq)],
        limit,
      });

      return {
        channelId,
        events: rows.map((row) => ({
          seq: row.seq,
          eventId: row.eventId,
          type: row.type,
          agentId: row.agentId,
          payload: row.payload,
          createdAt: row.createdAt.toISOString(),
        })),
        lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : (afterSeq ?? 0),
      };
    }
  );
}

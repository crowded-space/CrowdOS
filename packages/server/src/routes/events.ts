import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../Shared/config/database.js";
import { durableEvents } from "../db/schema.js";
import { channelGate } from "../Channels/channelGate.js";
import { workspaceGate } from "../Workspace/workspaceGate.js";

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
    async (request, reply) => {
      const { channelId, afterSeq, limit = 100 } = request.query as {
        channelId: string;
        afterSeq?: number;
        limit?: number;
      };
      const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
      const channel = await channelGate.get(channelId);
      if (!channel || (channel as { workspaceId?: string | null }).workspaceId !== workspaceId) {
        return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
      }
      const db = getDb();

      const scope = eq(durableEvents.workspaceId, workspaceId);
      const where =
        afterSeq !== undefined
          ? and(eq(durableEvents.channelId, channelId), scope, gt(durableEvents.seq, afterSeq))
          : and(eq(durableEvents.channelId, channelId), scope);

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
          workspaceId: (row as { workspaceId?: string | null }).workspaceId ?? null,
          payload: row.payload,
          createdAt: row.createdAt.toISOString(),
        })),
        lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : (afterSeq ?? 0),
      };
    }
  );
}

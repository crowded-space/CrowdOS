import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eventsGate } from "../events/events-gate.js";

const recentEventsQuerySchema = z.object({
  channelId: z.string().min(1),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * §29 local event replay (HM3/UX-5).
 * GET /api/events/recent?channelId=...&afterSeq=N&limit=100
 *
 * Serves the append-only local event log (events/<channelId>.jsonl) ordered
 * ascending by seq, so a client can resume with afterSeq = last seen seq.
 * `afterSeq` is exclusive; `lastSeq` is the highest seq returned, or the
 * current head when nothing is after the cursor (an empty/absent log is
 * honestly `events: []` + `lastSeq: 0`).
 *
 * Ephemeral events (`message:stream`) are never in this log — see the Events
 * domain spec for the classification and for what replay does and does not
 * guarantee.
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
      const { channelId, afterSeq, limit } = request.query as {
        channelId: string;
        afterSeq?: number;
        limit?: number;
      };
      // XD-014: tenant check mirroring the messages read rule. A bare
      // channelId must not serve another workspace's event log.
      const callerWs = (request as any).workspaceId ?? null;
      if (callerWs) {
        const { channelGate } = await import("../channels/channel-gate.js");
        const ch = await channelGate.get(channelId, (request as any).db).catch(() => null);
        const ownerWs = (ch as unknown as Record<string, unknown> | null)?.workspaceId as string | null ?? null;
        if (ch && ownerWs && ownerWs !== callerWs) {
          return reply.status(403).send({ error: "Forbidden", message: "Channel belongs to another workspace" });
        }
      }
      const { events, lastSeq } = await eventsGate.listRecent(channelId, { afterSeq, limit });
      return {
        channelId,
        events: events.map((row) => ({
          seq: row.seq,
          eventId: row.eventId,
          type: row.type,
          agentId: row.agentId ?? undefined,
          payload: row.payload,
          createdAt: row.createdAt,
        })),
        lastSeq,
      };
    }
  );
}

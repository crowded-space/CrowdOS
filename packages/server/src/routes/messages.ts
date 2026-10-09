import type { FastifyInstance } from "fastify";
import {
  getMessagesParamsSchema,
  getMessagesQuerySchema,
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError
} from "../messages/message-gate.js";
import type { GetMessagesParams, GetMessagesQuery } from "../messages/message-gate.js";

export async function messageRoutes(app: FastifyInstance) {
  // GET /api/channels/:channelId/messages
  // PERF-5 keyset pagination: cursor = (timestamp, seq) pair, transparent format `before=<ISO>;<seq>`.
  // Returns newest page first (ORDER BY timestamp DESC, seq DESC) + cursor for the next-older page.
  app.get<{ Params: GetMessagesParams; Querystring: GetMessagesQuery }>(
    "/api/channels/:channelId/messages",
    {
      schema: {
        params: getMessagesParamsSchema,
        querystring: getMessagesQuerySchema,
      },
    },
    async (request, reply) => {
      const { channelId } = request.params;
      const { before, limit } = request.query;
      try {
        // MSG-007: tenant check mirroring the socket rule. The page query
        // runs on the caller workspace handle, but without the header the
        // service resolves the channel's own workspace — verify the caller
        // workspace owns the channel before serving history.
        const callerWs = (request as any).workspaceId ?? null;
        if (callerWs) {
          const { channelGate } = await import("../channels/channel-gate.js");
          const ch = await channelGate.get(channelId, (request as any).db).catch(() => null);
          const ownerWs = (ch as unknown as Record<string, unknown> | null)?.workspaceId as string | null ?? null;
          if (ch && ownerWs && ownerWs !== callerWs) {
            return reply.status(403).send({ error: "Forbidden", message: "Channel belongs to another workspace" });
          }
        }
        return await getChannelMessagesPage(channelId, {
          limit,
          before: parseBeforeCursor(before),
          db: (request as any).db,
        });
      } catch (err) {
        if (err instanceof MalformedCursorError) {
          return reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: err.message
          });
        }
        throw err;
      }
    }
  );
}

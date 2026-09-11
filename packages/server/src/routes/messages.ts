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
  // Legacy rollback: absent params return the latest 50; ?limit=N is honored (clamped 1..200).
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
      const { includeMonologue, before, limit } = request.query;
      try {
        return await getChannelMessagesPage(channelId, includeMonologue ?? false, {
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

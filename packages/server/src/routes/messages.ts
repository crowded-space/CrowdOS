import type { FastifyInstance } from "fastify";
import {
  getMessagesParamsSchema,
  getMessagesQuerySchema,
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError
} from "../Messages/messageGate.js";
import type { GetMessagesParams, GetMessagesQuery } from "../Messages/messageGate.js";
import { channelGate } from "../Channels/channelGate.js";
import { workspaceGate } from "../Workspace/workspaceGate.js";

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
      const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
      const channel = await channelGate.get(channelId);
      if (!channel || (channel as { workspaceId?: string | null }).workspaceId !== workspaceId) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Channel not found",
        });
      }
      try {
        return await getChannelMessagesPage(channelId, includeMonologue ?? false, {
          limit,
          before: parseBeforeCursor(before),
          workspaceId,
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

import type { FastifyInstance } from "fastify";
import {
  getMessagesParamsSchema,
  getMessagesQuerySchema,
  getChannelMessages
} from "../Messages/messageGate.js";
import type { GetMessagesParams, GetMessagesQuery } from "../Messages/messageGate.js";

export async function messageRoutes(app: FastifyInstance) {
  // GET /api/channels/:channelId/messages - Retrieve message logs for a channel
  app.get<{ Params: GetMessagesParams; Querystring: GetMessagesQuery }>(
    "/api/channels/:channelId/messages",
    {
      schema: {
        params: getMessagesParamsSchema,
        querystring: getMessagesQuerySchema,
      },
    },
    async (request) => {
      const { channelId } = request.params;
      const includeMonologue = request.query.includeMonologue ?? false;
      return getChannelMessages(channelId, includeMonologue);
    }
  );
}

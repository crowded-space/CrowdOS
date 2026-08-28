import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ilike, or, desc } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { channels, messages } from "../db/schema.js";

const searchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function searchRoutes(app: FastifyInstance) {
  // GET /api/search?q=query&limit=20
  // Omni-search endpoint searching channels and messages using SQL ilike / pattern matching
  app.get<{ Querystring: z.infer<typeof searchQuerySchema> }>(
    "/api/search",
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request) => {
      const { q, limit } = request.query;
      const searchPattern = `%${q.trim()}%`;
      const db = getDb();

      const [matchedChannels, matchedMessages] = await Promise.all([
        db
          .select({
            id: channels.id,
            name: channels.name,
            categoryId: channels.categoryId,
            type: channels.type,
            position: channels.position,
            createdAt: channels.createdAt,
            archivedAt: channels.archivedAt,
          })
          .from(channels)
          .where(ilike(channels.name, searchPattern))
          .limit(limit),
        db
          .select({
            id: messages.id,
            channelId: messages.channelId,
            authorId: messages.authorId,
            authorName: messages.authorName,
            authorLevel: messages.authorLevel,
            authorType: messages.authorType,
            content: messages.content,
            isInternalMonologue: messages.isInternalMonologue,
            sequenceNumber: messages.sequenceNumber,
            timestamp: messages.timestamp,
          })
          .from(messages)
          .where(
            or(
              ilike(messages.content, searchPattern),
              ilike(messages.authorName, searchPattern)
            )
          )
          .orderBy(desc(messages.timestamp))
          .limit(limit),
      ]);

      return {
        query: q,
        channels: matchedChannels,
        messages: matchedMessages,
      };
    }
  );
}

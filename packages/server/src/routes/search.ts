import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ilike, or, desc, sql } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
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
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { q, limit } = request.query;
      const trimmed = q.trim();
      const searchPattern = `%${trimmed}%`;
      const db = getDb();

      // pg_trgm similarity ranking: when extension is available, order by similarity descending
      // to surface best matches first while still using the gin_trgm_ops index (ILIKE %pat% already hits it).
      // Fallback is plain ILIKE without similarity if pg_trgm not installed — both paths are fast with the new indexes.
      const trySimilarity = async () => {
        try {
          const [matchedChannels, matchedMessages] = await Promise.all([
            db.execute(sql`SELECT id, name, category_id AS "categoryId", type, position, created_at AS "createdAt", archived_at AS "archivedAt", similarity(name, ${trimmed}) AS sim FROM channels WHERE name ILIKE ${searchPattern} ORDER BY sim DESC, position ASC LIMIT ${limit}`),
            db.execute(sql`SELECT id, channel_id AS "channelId", author_id AS "authorId", author_name AS "authorName", author_level AS "authorLevel", author_type AS "authorType", LEFT(content, 280) AS content, is_internal_monologue AS "isInternalMonologue", sequence_number AS "sequenceNumber", timestamp, similarity(content, ${trimmed}) AS sim FROM messages WHERE content ILIKE ${searchPattern} OR author_name ILIKE ${searchPattern} ORDER BY sim DESC, timestamp DESC LIMIT ${limit}`),
          ]);
          // drizzle execute returns { rows } on postgres-js
          const chanRows = (matchedChannels as unknown as { rows?: unknown[] }).rows ?? (matchedChannels as unknown as unknown[]);
          const msgRows = (matchedMessages as unknown as { rows?: unknown[] }).rows ?? (matchedMessages as unknown as unknown[]);
          // Strip sim before returning
          const stripSim = (r: Record<string, unknown>) => { const { sim, ...rest } = r; return rest; };
          return {
            channels: (Array.isArray(chanRows) ? chanRows : []).map((r) => stripSim(r as Record<string, unknown>)),
            messages: (Array.isArray(msgRows) ? msgRows : []).map((r) => stripSim(r as Record<string, unknown>)),
          };
        } catch {
          return null;
        }
      };

      const ranked = await trySimilarity();
      if (ranked) {
        return { query: q, channels: ranked.channels, messages: ranked.messages };
      }

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
            content: sql<string>`LEFT(${messages.content}, 280)`,
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

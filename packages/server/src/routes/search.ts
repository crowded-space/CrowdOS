import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ilike, or, and, desc, eq, sql } from "drizzle-orm";
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
      // XD-001: caller workspace handle + filter. Unscoped search leaked
      // cross-workspace channels/messages.
      const db = (request as any).db ?? getDb();
      const callerWs = (request as any).workspaceId ?? null;

      // pg_trgm similarity ranking: when extension is available, order by similarity descending
      // to surface best matches first while still using the gin_trgm_ops index (ILIKE %pat% already hits it).
      // Fallback is plain ILIKE without similarity if pg_trgm not installed — both paths are fast with the new indexes.
      const trySimilarity = async () => {
        try {
          const [matchedChannels, matchedMessages] = await Promise.all([
            db.execute(sql`SELECT id, name, category_id AS "categoryId", type, position, created_at AS "createdAt", archived_at AS "archivedAt", workspace_id AS "workspace_id", similarity(name, ${trimmed}) AS sim FROM channels WHERE name ILIKE ${searchPattern} ORDER BY sim DESC, position ASC LIMIT ${limit}`),
            db.execute(sql`SELECT id, channel_id AS "channelId", author_id AS "authorId", author_name AS "authorName", author_level AS "authorLevel", author_type AS "authorType", LEFT(content, 280) AS content, is_internal_monologue AS "isInternalMonologue", sequence_number AS "sequenceNumber", timestamp, workspace_id AS "workspace_id", similarity(content, ${trimmed}) AS sim FROM messages WHERE content ILIKE ${searchPattern} OR author_name ILIKE ${searchPattern} ORDER BY sim DESC, timestamp DESC LIMIT ${limit}`),
          ]);
          // drizzle execute returns { rows } on postgres-js
          const chanRows = (matchedChannels as unknown as { rows?: unknown[] }).rows ?? (matchedChannels as unknown as unknown[]);
          const msgRows = (matchedMessages as unknown as { rows?: unknown[] }).rows ?? (matchedMessages as unknown as unknown[]);
          // XD-001: raw rows carry workspace_id; filter here, strip sim +
          // workspace_id before returning.
          const inWs = (r: Record<string, unknown>) =>
            !callerWs || r.workspaceId === callerWs || r.workspace_id === callerWs;
          const stripSim = (r: Record<string, unknown>) => { const { sim, workspaceId, workspace_id, ...rest } = r; return rest; };
          const chanArr = (Array.isArray(chanRows) ? chanRows : []).filter((r) => inWs(r as Record<string, unknown>));
          const msgArr = (Array.isArray(msgRows) ? msgRows : []).filter((r) => inWs(r as Record<string, unknown>));
          return {
            channels: chanArr.map((r) => stripSim(r as Record<string, unknown>)),
            messages: msgArr.map((r) => stripSim(r as Record<string, unknown>)),
          };
        } catch {
          return null;
        }
      };

      const ranked = await trySimilarity();
      if (ranked) {
        // XD-001: the raw-SQL similarity path cannot easily bind the
        // workspace predicate across pg_trgm variants; filter in JS. The
        // drizzle fallback below filters in SQL.
        const inWs = (r: unknown) =>
          !callerWs || (r as Record<string, unknown>).workspaceId === callerWs || (r as Record<string, unknown>).workspace_id === callerWs;
        return {
          query: q,
          channels: (ranked.channels as unknown[]).filter(inWs),
          messages: (ranked.messages as unknown[]).filter(inWs),
        };
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
          .where(callerWs ? and(ilike(channels.name, searchPattern), eq(channels.workspaceId, callerWs)) : ilike(channels.name, searchPattern))
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
            callerWs
              ? and(
                  or(ilike(messages.content, searchPattern), ilike(messages.authorName, searchPattern)),
                  eq(messages.workspaceId, callerWs)
                )
              : or(ilike(messages.content, searchPattern), ilike(messages.authorName, searchPattern))
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

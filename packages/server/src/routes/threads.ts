import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { threadGate } from "../threads/thread-gate.js";
import { getDb } from "../shared/config/database.js";
import { messages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { allocateThreadSequence } from "../shared/core/thread-sequence.js";
import { monotonicUlid } from "../shared/core/ulid.js";
import { withTransaction } from "../shared/config/database.js";
import { MentionParser } from "../shared/core/mention-parser.js";

const createThreadSchema = z.object({
  parentMessageId: z.string().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  createdBy: z.string().min(1).default("local-user"),
  isEphemeral: z.boolean().default(true),
  ttlHours: z.number().int().min(1).max(720).default(24),
});

const updateThreadSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  status: z.enum(["active", "archived", "expired"]).optional(),
});

const mentionParser = new MentionParser();

const listThreadsQuerySchema = z.object({
  includeArchived: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const threadMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional(),
});

export async function threadRoutes(app: FastifyInstance) {
  // GET /api/channels/:channelId/threads
  app.get<{ Params: { channelId: string }; Querystring: z.infer<typeof listThreadsQuerySchema> }>("/api/channels/:channelId/threads", { schema: { querystring: listThreadsQuerySchema } }, async (request, reply) => {
    const { channelId } = request.params;
    const includeArchived = request.query.includeArchived === "true";
    const limit = request.query.limit;
    const cursor = request.query.cursor ?? null;
    const rows = await threadGate.list(channelId, { includeArchived, limit, cursor });
    return { threads: rows };
  });

  // POST /api/channels/:channelId/threads
  app.post<{ Params: { channelId: string }; Body: z.infer<typeof createThreadSchema> }>("/api/channels/:channelId/threads", { schema: { body: createThreadSchema } }, async (request, reply) => {
    const { channelId } = request.params;
    const result = await threadGate.create({ channelId, ...request.body });
    if ((result as any).error) return reply.status(404).send({ error: "Not Found", message: (result as any).error });
    return reply.status(201).send((result as any).thread);
  });

  // GET /api/threads/:threadId
  app.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    const t = await threadGate.get(request.params.threadId);
    if (!t) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    return t;
  });

  // PATCH /api/threads/:threadId
  app.patch<{ Params: { threadId: string }; Body: z.infer<typeof updateThreadSchema> }>("/api/threads/:threadId", { schema: { body: updateThreadSchema } }, async (request, reply) => {
    const result = await threadGate.update(request.params.threadId, request.body);
    if ((result as any).notFound) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    return (result as any).thread;
  });

  // DELETE /api/threads/:threadId
  app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    const result = await threadGate.delete(request.params.threadId);
    if ((result as any).notFound) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    return { success: true };
  });

  // GET /api/threads/:threadId/messages
  app.get<{ Params: { threadId: string }; Querystring: z.infer<typeof threadMessagesQuerySchema> }>("/api/threads/:threadId/messages", { schema: { querystring: threadMessagesQuerySchema } }, async (request, reply) => {
    const limit = request.query.limit;
    const before = request.query.before ?? null;
    const result = await threadGate.getMessages(request.params.threadId, { limit, before });
    if ((result as any).error) return reply.status(404).send({ error: "Not Found", message: (result as any).error });
    return result;
  });

  // POST /api/threads/:threadId/messages  — temporary sub-session main Session channel stays main, thread inherits channel mount
  app.post<{ Params: { threadId: string }; Body: { content: string; authorId?: string; authorName?: string } }>("/api/threads/:threadId/messages", async (request, reply) => {
    const thread = await threadGate.get(request.params.threadId);
    if (!thread) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    const content = request.body.content?.trim();
    if (!content) return reply.status(400).send({ error: "Bad Request", message: "content required" });
    const mentions = await mentionParser.parseMentions(content);
    const authorId = request.body.authorId ?? "local-user";
    const authorName = request.body.authorName ?? "User";
    const msg = await withTransaction(async (tx) => {
      const seq = await allocateThreadSequence(thread.id, 1, tx);
      const row = {
        id: monotonicUlid(),
        channelId: thread.channelId,
        threadId: thread.id,
        authorId,
        authorName,
        authorLevel: "stakeholder",
        authorType: "user" as const,
        content,
        mentions,
        isInternalMonologue: false,
        sequenceNumber: seq,
        timestamp: new Date(),
      };
      await tx.insert(messages).values({ ...row, authorLevel: String(row.authorLevel) });
      return row;
    });
    await threadGate.incrementCount(thread.id);
    // Emit via global broker (lazy import to avoid cycle)
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      const broker: any = globalBroker;
      if (broker) broker.emit("message:new", msg as any, { channelId: thread.channelId });
    } catch {}
    return reply.status(201).send(msg);
  });

  // POST /api/threads/sweep  (cron)
  app.post("/api/threads/sweep", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (_request, reply) => {
    const count = await threadGate.archiveExpired();
    return { archived: count };
  });
}

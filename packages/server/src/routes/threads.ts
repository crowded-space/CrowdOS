import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { threadGate, type threadCallContext } from "../threads/thread-gate.js";
import { messageGate } from "../messages/message-gate.js";
import { authGate } from "../shared/auth/auth-gate.js";
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

function threadContext(request: unknown): threadCallContext | undefined {
  const rawWorkspaceId = (request as { workspaceId?: unknown } | null)?.workspaceId;
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
  return workspaceId ? { workspaceId } : undefined;
}

export async function threadRoutes(app: FastifyInstance) {
  // THR-008: the sweep is a cron surface that flips mass state, not a UI
  // action. Mirrors routes/tools.ts + routes/observability.ts: strict admin
  // auth is enforced whenever admin auth is configured (WORKSPACE_ADMIN_TOKEN),
  // while tokenless single-user setups keep the loopback trust model. The
  // internal worker calls threadGate.archiveExpired directly and never needs
  // this route.
  const sweepPreHandler = process.env.WORKSPACE_ADMIN_TOKEN ? authGate.requireAdmin : undefined;

  // GET /api/channels/:channelId/threads
  app.get<{ Params: { channelId: string }; Querystring: z.infer<typeof listThreadsQuerySchema> }>("/api/channels/:channelId/threads", { schema: { querystring: listThreadsQuerySchema } }, async (request, reply) => {
    const { channelId } = request.params;
    const includeArchived = request.query.includeArchived === "true";
    const limit = request.query.limit;
    const cursor = request.query.cursor ?? null;
    const rows = await threadGate.list(channelId, { includeArchived, limit, cursor }, threadContext(request));
    return { threads: rows };
  });

  // POST /api/channels/:channelId/threads
  app.post<{ Params: { channelId: string }; Body: z.infer<typeof createThreadSchema> }>("/api/channels/:channelId/threads", { schema: { body: createThreadSchema } }, async (request, reply) => {
    const { channelId } = request.params;
    const result = await threadGate.create({ channelId, ...request.body }, threadContext(request));
    if ((result as any).error) return reply.status(404).send({ error: "Not Found", message: (result as any).error });
    return reply.status(201).send((result as any).thread);
  });

  // GET /api/threads/:threadId
  app.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    const t = await threadGate.get(request.params.threadId, threadContext(request));
    if (!t) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    return t;
  });

  // PATCH /api/threads/:threadId
  app.patch<{ Params: { threadId: string }; Body: z.infer<typeof updateThreadSchema> }>("/api/threads/:threadId", { schema: { body: updateThreadSchema } }, async (request, reply) => {
    const result = await threadGate.update(request.params.threadId, request.body, threadContext(request));
    if ((result as any).notFound) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    // THR-006: guarded lifecycle — illegal moves are 409, not silent writes.
    if ((result as any).error === "illegal_transition") {
      return reply.status(409).send({ error: "Conflict", message: `Illegal thread transition ${(result as any).from} -> ${(result as any).to}` });
    }
    return (result as any).thread;
  });

  // DELETE /api/threads/:threadId
  app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    const result = await threadGate.delete(request.params.threadId, threadContext(request));
    if ((result as any).notFound) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    return { success: true };
  });

  // GET /api/threads/:threadId/messages
  app.get<{ Params: { threadId: string }; Querystring: z.infer<typeof threadMessagesQuerySchema> }>("/api/threads/:threadId/messages", { schema: { querystring: threadMessagesQuerySchema } }, async (request, reply) => {
    const limit = request.query.limit;
    const before = request.query.before ?? null;
    const result = await threadGate.getMessages(request.params.threadId, { limit, before }, threadContext(request));
    if ((result as any).error) return reply.status(404).send({ error: "Not Found", message: (result as any).error });
    return result;
  });

  // POST /api/threads/:threadId/messages  — temporary sub-session main Session channel stays main, thread inherits channel mount
  app.post<{ Params: { threadId: string }; Body: { content: string; authorId?: string; authorName?: string } }>("/api/threads/:threadId/messages", async (request, reply) => {
    const context = threadContext(request);
    const thread = await threadGate.get(request.params.threadId, context);
    if (!thread) return reply.status(404).send({ error: "Not Found", message: "Thread not found" });
    // State machine: only an ACTIVE thread accepts new messages. Posting into
    // an archived/expired thread used to resurrect it silently (bumping
    // lastActivityAt on a dead thread).
    if (thread.status !== "active") {
      return reply.status(409).send({ error: "Conflict", message: `Thread is ${thread.status}; new messages are not accepted` });
    }
    const content = request.body.content?.trim();
    if (!content) return reply.status(400).send({ error: "Bad Request", message: "content required" });
    const mentions = await mentionParser.parseMentions(content);
    const authorId = request.body.authorId ?? "local-user";
    const authorName = request.body.authorName ?? "User";
    // XD-008: single-emit ownership. The broker goes INTO append so the
    // domain emits exactly once; the old manual route emit is deleted (it
    // would double-deliver the moment append ever gained a broker).
    let broker: any = null;
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      broker = globalBroker ?? null;
    } catch {}
    // Messages owns the table (thread sequence when threadId is set).
    const msg = await messageGate.append(
      {
        channelId: thread.channelId,
        threadId: thread.id,
        authorId,
        authorName,
        authorLevel: "stakeholder",
        authorType: "user",
        content,
        mentions,
      },
      broker ? { broker } : undefined
    );
    await threadGate.incrementCount(thread.id, context);
    return reply.status(201).send(msg);
  });

  // POST /api/threads/sweep  (cron)
  app.post("/api/threads/sweep", { preHandler: sweepPreHandler, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (_request, reply) => {
    const count = await threadGate.archiveExpired(threadContext(_request));
    return { archived: count };
  });
}

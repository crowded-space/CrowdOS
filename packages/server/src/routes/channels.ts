import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createChannelSchema,
  updateChannelSchema,
  paramIdSchema,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel
} from "../channels/channel-gate.js";
import type {
  CreateChannelBody,
  UpdateChannelBody,
  ChannelParams
} from "../channels/channel-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

const listChannelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  offset: z.string().optional(),
});

export async function channelRoutes(app: FastifyInstance) {
  // GET /api/channels - List channels with limit+cursor compat (default capped 200)
  app.get<{ Querystring: z.infer<typeof listChannelsQuerySchema> }>(
    "/api/channels",
    { schema: { querystring: listChannelsQuerySchema } },
    async (req: any) => {
      const limit = req.query?.limit as number | undefined;
      const cursor = req.query?.cursor ?? req.query?.offset ?? null;
      return listChannels({ limit, cursor: cursor != null ? String(cursor) : null, db: (req as any).db });
    });

  // POST /api/channels - Create a channel under a category
  app.post<{ Body: CreateChannelBody }>(
    "/api/channels",
    { schema: { body: createChannelSchema } },
    async (request, reply) => {
      const result = await createChannel(request.body, (request as any).db);
      if ("error" in result) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Category not found: ${result.categoryId}`,
        });
      }
      emitWorkspaceSync();
      return reply.status(201).send(result.channel);
    }
  );

  async function updateChannelHandler(
    request: FastifyRequest<{ Params: ChannelParams; Body: UpdateChannelBody }>,
    reply: FastifyReply,
  ) {
    const result = await updateChannel(request.params.id, request.body, (request as any).db);
    if ("notFound" in result) {
      return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
    }
    if ("error" in result) {
      return reply.status(400).send({
        error: "Bad Request",
        message: `Category not found: ${result.categoryId}`,
      });
    }

    emitWorkspaceSync();
    return result.channel;
  }

  // PATCH /api/channels/:id - Update channel parameters (archive, rename, position, category)
  app.patch<{ Params: ChannelParams; Body: UpdateChannelBody }>(
    "/api/channels/:id",
    { schema: { params: paramIdSchema, body: updateChannelSchema } },
    updateChannelHandler,
  );

  // PUT alias keeps the route aligned with the project API table.
  app.put<{ Params: ChannelParams; Body: UpdateChannelBody }>(
    "/api/channels/:id",
    { schema: { params: paramIdSchema, body: updateChannelSchema } },
    updateChannelHandler,
  );

  // DELETE /api/channels/:id - Delete a channel
  app.delete<{ Params: ChannelParams }>(
    "/api/channels/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const result = await deleteChannel(request.params.id, (request as any).db);
      if ("notFound" in result) {
        return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
      }
      if ("conflictGeneral" in result) {
        return reply.status(409).send({
          error: "Conflict",
          message: "The top-level #general channel cannot be deleted.",
        });
      }

      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

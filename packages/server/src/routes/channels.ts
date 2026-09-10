import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createChannelSchema,
  updateChannelSchema,
  paramIdSchema,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel
} from "../Channels/channelGate.js";
import type {
  CreateChannelBody,
  UpdateChannelBody,
  ChannelParams
} from "../Channels/channelGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";
import { workspaceGate } from "../Workspace/workspaceGate.js";

function emitWorkspaceSync(workspaceId: string): void {
  globalBroker?.emit("workspace:sync", {}, { workspaceId });
}

export async function channelRoutes(app: FastifyInstance) {
  // GET /api/channels - List channels with limit+cursor compat (default capped 200)
  app.get("/api/channels", async (req: any) => {
    const limit = req.query?.limit != null ? Number(req.query.limit) : undefined;
    const cursor = req.query?.cursor ?? req.query?.offset ?? null;
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(req);
    return listChannels({ limit, cursor: cursor != null ? String(cursor) : null, workspaceId });
  });

  // POST /api/channels - Create a channel under a category
  app.post<{ Body: CreateChannelBody }>(
    "/api/channels",
    { schema: { body: createChannelSchema } },
    async (request, reply) => {
      try {
        await workspaceGate.assertExists(request.body.workspaceId);
      } catch {
        return reply.status(400).send({ error: "Bad Request", message: `Unknown workspace: ${request.body.workspaceId}` });
      }
      const result = await createChannel(request.body);
      if ("error" in result) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Category not found: ${result.categoryId}`,
        });
      }
      emitWorkspaceSync(request.body.workspaceId);
      return reply.status(201).send(result.channel);
    }
  );

  async function updateChannelHandler(
    request: FastifyRequest<{ Params: ChannelParams; Body: UpdateChannelBody }>,
    reply: FastifyReply,
  ) {
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const result = await updateChannel(request.params.id, request.body, { workspaceId });
    if ("notFound" in result) {
      return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
    }
    if ("forbidden" in result) {
      return reply.status(403).send({ error: "Forbidden", message: "Channel does not belong to this workspace" });
    }
    if ("error" in result) {
      return reply.status(400).send({
        error: "Bad Request",
        message: `Category not found: ${result.categoryId}`,
      });
    }

    emitWorkspaceSync(workspaceId);
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
      const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
      const result = await deleteChannel(request.params.id, { workspaceId });
      if ("notFound" in result) {
        return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
      }
      if ("forbidden" in result) {
        return reply.status(403).send({ error: "Forbidden", message: "Channel does not belong to this workspace" });
      }
      if ("conflictGeneral" in result) {
        return reply.status(409).send({
          error: "Conflict",
          message: "The top-level #general channel cannot be deleted.",
        });
      }

      emitWorkspaceSync(workspaceId);
      return reply.status(204).send();
    }
  );
}

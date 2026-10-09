import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createChannelSchema,
  updateChannelSchema,
  paramIdSchema,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelSettings,
  updateChannelSettings
} from "../channels/channel-gate.js";
import { agentGate } from "../agents/agent-gate.js";
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

// §6-8 per-channel composer state. Null clears a pin.
const channelSettingsSchema = z.object({
  pinnedRuntime: z.enum(["conversational", "agentic", "swarm", "coding", "research"]).nullish(),
  activeAgentId: z.string().min(1).max(200).nullish(),
  defaultAgentId: z.string().min(1).max(200).nullish(),
});

export async function channelRoutes(app: FastifyInstance) {
  // GET /api/channels - List channels with limit+cursor compat (default capped 200)
  app.get<{ Querystring: z.infer<typeof listChannelsQuerySchema> }>(
    "/api/channels",
    { schema: { querystring: listChannelsQuerySchema } },
    async (req: any, reply: FastifyReply) => {
      const limit = req.query?.limit as number | undefined;
      const cursor = req.query?.cursor ?? req.query?.offset ?? null;
      // §30: thread the tenant scope so local-tier workspaces do not serve the
      // default folder's channels to every workspace.
      try {
        return await listChannels({
          limit,
          cursor: cursor != null ? String(cursor) : null,
          workspaceId: (req as any).workspaceId ?? null,
          db: (req as any).db,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "ChannelOffsetLimitError") {
          return reply.status(400).send({ error: "Bad Request", message: error.message });
        }
        throw error;
      }
    });

  // POST /api/channels - Create a channel under a category
  app.post<{ Body: CreateChannelBody }>(
    "/api/channels",
    { schema: { body: createChannelSchema } },
    async (request, reply) => {
      const result = await createChannel(request.body, (request as any).db, (request as any).workspaceId ?? null);
      if ("error" in result) {
        // CHN-004: duplicate_name and category are distinct failures.
        // Conflating them into "Category not found: undefined" misleads callers.
        if ((result as any).error === "duplicate_name") {
          return reply.status(409).send({
            error: "Conflict",
            message: `Channel name already exists: ${(result as any).name}`,
          });
        }
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
      // CHN-004 (update path): duplicate_name is 409, category stays 400.
      if ((result as any).error === "duplicate_name") {
        return reply.status(409).send({
          error: "Conflict",
          message: `Channel name already exists: ${(result as any).name}`,
        });
      }
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

  // GET /api/channels/:id/settings - Per-channel pins (§6-8)
  app.get<{ Params: ChannelParams }>(
    "/api/channels/:id/settings",
    { schema: { params: paramIdSchema } },
    async (request) => {
      // §30: settings are workspace-scoped; the tenant hook resolved the
      // workspace from the x-workspace-id header.
      return (await getChannelSettings(
        request.params.id,
        (request as any).db,
        (request as any).workspaceId,
      )) ?? {
        channelId: request.params.id,
        pinnedRuntime: null,
        activeAgentId: null,
        defaultAgentId: null,
      };
    }
  );

  // PATCH /api/channels/:id/settings - Set or clear pins (null clears)
  app.patch<{ Params: ChannelParams; Body: z.infer<typeof channelSettingsSchema> }>(
    "/api/channels/:id/settings",
    { schema: { params: paramIdSchema, body: channelSettingsSchema } },
    async (request, reply) => {
      for (const key of ["activeAgentId", "defaultAgentId"] as const) {
        const agentId = request.body[key];
        // XD-004: scope the lookup to the caller workspace. An unscoped
        // getById lets a foreign-workspace agent id pin and dispatch here.
        if (typeof agentId === "string" && !(await agentGate.getById(agentId, (request as any).db, (request as any).workspaceId ?? null))) {
          return reply.status(400).send({ error: "Bad Request", message: `Agent not found: ${agentId}` });
        }
      }
      // CHN-012: refuse orphan pin writes at the transport boundary. The
      // gate stays permissive for fixture/test callers; HTTP callers must
      // name a real channel.
      const { channelGate } = await import("../channels/channel-gate.js");
      const target = await channelGate.get(request.params.id, (request as any).db).catch(() => null);
      if (!target) {
        return reply.status(404).send({ error: "Not Found", message: "Channel not found" });
      }
      const result = await updateChannelSettings(
        request.params.id,
        request.body,
        (request as any).db,
        (request as any).workspaceId,
      );
      if ("error" in result) {
        return reply.status(400).send({ error: "Bad Request", message: `Invalid pinnedRuntime: ${result.pinnedRuntime}` });
      }
      return result.settings;
    }
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

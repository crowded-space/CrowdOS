import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
} from "../channels/channel-gate.js";
import { maybeSend304 } from "../shared/core/http-cache.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";

const createCategorySchema = z.object({
  name: z.string().min(1),
  ownedByAgentId: z.string().nullable().optional(),
  embeddingProfileId: z.string().nullable().optional(),
  createdBy: z.string().min(1),
  position: z.number().int().default(0),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  ownedByAgentId: z.string().nullable().optional(),
  embeddingProfileId: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

const paramIdSchema = z.object({
  id: z.string().min(1),
});

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

export async function categoryRoutes(app: FastifyInstance) {
  // GET /api/categories - List categories with nested channels, limit+cursor compat (capped 200)
  app.get("/api/categories", async (req: any, reply: any) => {
    const limitRaw = req.query?.limit != null ? Number(req.query.limit) : 200;
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));
    const cursorRaw = req.query?.cursor ?? req.query?.offset;
    let offset = 0;
    if (cursorRaw != null) {
      const parsed = Number(cursorRaw);
      if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
    }
    const list = await listCategories({
      limit,
      offset,
      workspaceId: (req as any).workspaceId ?? null,
      db: (req as any).db,
    });
    if (maybeSend304(req, reply, list)) return;
    return list;
  });

  // POST /api/categories - Create a category
  app.post<{ Body: z.infer<typeof createCategorySchema> }>(
    "/api/categories",
    { schema: { body: createCategorySchema } },
    async (request, reply) => {
      const res = await createCategory(
        {
          name: request.body.name,
          workspaceId: (request as any).workspaceId ?? null,
          ownedByAgentId: request.body.ownedByAgentId ?? null,
          embeddingProfileId: request.body.embeddingProfileId ?? null,
          createdBy: request.body.createdBy,
          position: request.body.position,
        },
        (request as any).db,
      );
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  async function updateCategoryHandler(
    request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>,
    reply: FastifyReply,
  ) {
    const updated = await updateCategory(
      request.params.id,
      {
        name: request.body.name,
        ownedByAgentId: request.body.ownedByAgentId,
        embeddingProfileId: request.body.embeddingProfileId,
        position: request.body.position,
      },
      (request as any).db,
    );

    if (!updated) {
      return reply.status(404).send({ error: "Not Found", message: "Category not found" });
    }

    emitWorkspaceSync();
    return updated;
  }

  app.put<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema, body: updateCategorySchema } },
    updateCategoryHandler,
  );

  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema, body: updateCategorySchema } },
    updateCategoryHandler,
  );

  // DELETE /api/categories/:id - Delete a category (channels cascade with it)
  app.delete<{ Params: { id: string } }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const removed = await removeCategory(request.params.id, (request as any).db);
      if (!removed) {
        return reply.status(404).send({ error: "Not Found", message: "Category not found" });
      }
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

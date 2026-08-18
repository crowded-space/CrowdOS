import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../Shared/config/database.js";
import { categories, channels } from "../db/schema.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";

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
  // GET /api/categories - List all categories with nested channels
  app.get("/api/categories", async () => {
    const db = getDb();
    const list = await db.query.categories.findMany({
      with: {
        channels: {
          orderBy: (table, { asc }) => [asc(table.position)],
        },
      },
      orderBy: (table, { asc }) => [asc(table.position)],
    });
    return list;
  });

  // POST /api/categories - Create a category
  app.post<{ Body: z.infer<typeof createCategorySchema> }>(
    "/api/categories",
    { schema: { body: createCategorySchema } },
    async (request, reply) => {
      const db = getDb();
      const id = randomUUID();
      const [res] = await db
        .insert(categories)
        .values({
          id,
          name: request.body.name,
          ownedByAgentId: request.body.ownedByAgentId ?? null,
          embeddingProfileId: request.body.embeddingProfileId ?? null,
          createdBy: request.body.createdBy,
          position: request.body.position,
        })
        .returning();
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  async function updateCategory(
    request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>,
    reply: FastifyReply,
  ) {
    const db = getDb();
    const updateData: Partial<typeof categories.$inferInsert> = {};

    if (request.body.name !== undefined) updateData.name = request.body.name;
    if (request.body.ownedByAgentId !== undefined) updateData.ownedByAgentId = request.body.ownedByAgentId;
    if (request.body.embeddingProfileId !== undefined) updateData.embeddingProfileId = request.body.embeddingProfileId;
    if (request.body.position !== undefined) updateData.position = request.body.position;

    const [updated] = await db
      .update(categories)
      .set(updateData)
      .where(eq(categories.id, request.params.id))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: "Not Found", message: "Category not found" });
    }

    emitWorkspaceSync();
    return updated;
  }

  app.put<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema, body: updateCategorySchema } },
    updateCategory,
  );

  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateCategorySchema> }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema, body: updateCategorySchema } },
    updateCategory,
  );

  // DELETE /api/categories/:id - Delete a category
  app.delete<{ Params: { id: string } }>(
    "/api/categories/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const db = getDb();
      const existing = await db.query.categories.findFirst({
        where: eq(categories.id, request.params.id),
      });

      if (!existing) {
        return reply.status(404).send({ error: "Not Found", message: "Category not found" });
      }

      await db.delete(channels).where(eq(channels.categoryId, request.params.id));
      const deleted = await db
        .delete(categories)
        .where(eq(categories.id, request.params.id))
        .returning();
      if (deleted.length === 0) {
        return reply.status(404).send({ error: "Not Found", message: "Category not found" });
      }
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

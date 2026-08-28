import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../Shared/config/database.js";
import {
  embeddingModelProfiles,
  indexingModelProfiles,
  generationModelProfiles
} from "../db/schema.js";
import { testConnectionHelper } from "../Modules/moduleGate.js";
import { redactSecrets } from "../Shared/core/redact.js";
import { encrypt, decrypt } from "../Shared/core/secretBox.js";

const providerEngineSchema = z.enum(["google", "openai", "anthropic", "ollama", "custom"]);

const generationProfileSchema = z.object({
  label: z.string().min(1),
  provider: providerEngineSchema,
  modelName: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional(),
  temperature: z.number(),
  topP: z.number(),
  maxOutputTokens: z.number().int(),
  stopSequences: z.array(z.string()).optional(),
  maxRecentMessages: z.number().int(),
  enableCompression: z.boolean().optional(),
  compressionThreshold: z.number().int()
});

const updateGenerationProfileSchema = generationProfileSchema.partial();

const embeddingProfileSchema = z.object({
  label: z.string().min(1),
  provider: providerEngineSchema,
  modelName: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional(),
  dimensions: z.number().int()
});

const updateEmbeddingProfileSchema = embeddingProfileSchema.partial();

const indexingProfileSchema = z.object({
  label: z.string().min(1),
  provider: providerEngineSchema,
  modelName: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional()
});

const updateIndexingProfileSchema = indexingProfileSchema.partial();

const paramIdSchema = z.object({
  id: z.string().min(1)
});

export async function providerRoutes(app: FastifyInstance) {
  // GET /api/providers - Return all profiles aggregated — redact secrets (P0-2)
  app.get("/api/providers", async () => {
    const db = getDb();
    const [genList, embList, idxList] = await Promise.all([
      db.select().from(generationModelProfiles),
      db.select().from(embeddingModelProfiles),
      db.select().from(indexingModelProfiles)
    ]);

    return {
      generationModelProfiles: genList.map((r) => redactSecrets(r as unknown as Record<string, unknown>)),
      embeddingModelProfiles: embList.map((r) => redactSecrets(r as unknown as Record<string, unknown>)),
      indexingModelProfiles: idxList.map((r) => redactSecrets(r as unknown as Record<string, unknown>)),
    };
  });

  // --- Generation Model Profiles ---
  app.get("/api/providers/generation", async (request, reply) => {
    reply.header("deprecation", "true");
    reply.header("x-deprecation-warning", "Deprecated generation profile endpoint. Use ModelModule routes (/api/modules/model) instead.");
    const list = await getDb().select().from(generationModelProfiles);
    return list.map((r) => redactSecrets(r as unknown as Record<string, unknown>));
  });

  app.get<{ Params: { id: string } }>(
    "/api/providers/generation/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      reply.header("deprecation", "true");
      reply.header("x-deprecation-warning", "Deprecated generation profile endpoint. Use ModelModule routes (/api/modules/model) instead.");
      const [res] = await getDb().select().from(generationModelProfiles).where(eq(generationModelProfiles.id, request.params.id)).limit(1);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "GenerationModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.post<{ Body: z.infer<typeof generationProfileSchema> }>(
    "/api/providers/generation",
    { schema: { body: generationProfileSchema } },
    async (request, reply) => {
      reply.header("deprecation", "true");
      reply.header("x-deprecation-warning", "Deprecated generation profile endpoint. Use ModelModule routes (/api/modules/model) instead.");
      const id = randomUUID();
      const [res] = await getDb().insert(generationModelProfiles).values({
        id,
        ...request.body,
        apiKey: request.body.apiKey == null ? null : encrypt(request.body.apiKey),
        endpointUrl: request.body.endpointUrl ?? null,
        stopSequences: request.body.stopSequences ?? [],
        enableCompression: request.body.enableCompression ?? true
      }).returning();
      return reply.status(201).send(redactSecrets(res as unknown as Record<string, unknown>));
    }
  );

  app.put<{ Params: { id: string }; Body: z.infer<typeof updateGenerationProfileSchema> }>(
    "/api/providers/generation/:id",
    { schema: { params: paramIdSchema, body: updateGenerationProfileSchema } },
    async (request, reply) => {
      reply.header("deprecation", "true");
      reply.header("x-deprecation-warning", "Deprecated generation profile endpoint. Use ModelModule routes (/api/modules/model) instead.");
      const updates = { ...request.body };
      if (updates.apiKey !== undefined) updates.apiKey = updates.apiKey == null ? null : encrypt(updates.apiKey);
      const [res] = await getDb()
        .update(generationModelProfiles)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(eq(generationModelProfiles.id, request.params.id))
        .returning();
      if (!res) return reply.status(404).send({ error: "Not Found", message: "GenerationModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/providers/generation/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      reply.header("deprecation", "true");
      reply.header("x-deprecation-warning", "Deprecated generation profile endpoint. Use ModelModule routes (/api/modules/model) instead.");
      const deleted = await getDb().delete(generationModelProfiles).where(eq(generationModelProfiles.id, request.params.id)).returning();
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "GenerationModelProfile not found" });
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/providers/generation/:id/test",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const [profile] = await getDb().select().from(generationModelProfiles).where(eq(generationModelProfiles.id, request.params.id)).limit(1);
      if (!profile) return reply.status(404).send({ error: "Not Found", message: "GenerationModelProfile not found" });

      const result = await testConnectionHelper(profile.provider, profile.modelName, profile.apiKey ? decrypt(profile.apiKey) : profile.apiKey, profile.endpointUrl);
      return result;
    }
  );

  // --- Embedding Model Profiles ---
  app.get("/api/providers/embedding", async () => {
    const list = await getDb().select().from(embeddingModelProfiles);
    return list.map((r) => redactSecrets(r as unknown as Record<string, unknown>));
  });

  app.get<{ Params: { id: string } }>(
    "/api/providers/embedding/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const [res] = await getDb().select().from(embeddingModelProfiles).where(eq(embeddingModelProfiles.id, request.params.id)).limit(1);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "EmbeddingModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.post<{ Body: z.infer<typeof embeddingProfileSchema> }>(
    "/api/providers/embedding",
    { schema: { body: embeddingProfileSchema } },
    async (request, reply) => {
      const id = randomUUID();
      const [res] = await getDb().insert(embeddingModelProfiles).values({
        id,
        ...request.body,
        apiKey: request.body.apiKey == null ? null : encrypt(request.body.apiKey),
        endpointUrl: request.body.endpointUrl ?? null
      }).returning();
      return reply.status(201).send(redactSecrets(res as unknown as Record<string, unknown>));
    }
  );

  app.put<{ Params: { id: string }; Body: z.infer<typeof updateEmbeddingProfileSchema> }>(
    "/api/providers/embedding/:id",
    { schema: { params: paramIdSchema, body: updateEmbeddingProfileSchema } },
    async (request, reply) => {
      const updates = { ...request.body };
      if (updates.apiKey !== undefined) updates.apiKey = updates.apiKey == null ? null : encrypt(updates.apiKey);
      const [res] = await getDb()
        .update(embeddingModelProfiles)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(eq(embeddingModelProfiles.id, request.params.id))
        .returning();
      if (!res) return reply.status(404).send({ error: "Not Found", message: "EmbeddingModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/providers/embedding/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const deleted = await getDb().delete(embeddingModelProfiles).where(eq(embeddingModelProfiles.id, request.params.id)).returning();
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "EmbeddingModelProfile not found" });
      return reply.status(204).send();
    }
  );

  // --- Indexing Model Profiles ---
  app.get("/api/providers/indexing", async () => {
    const list = await getDb().select().from(indexingModelProfiles);
    return list.map((r) => redactSecrets(r as unknown as Record<string, unknown>));
  });

  app.get<{ Params: { id: string } }>(
    "/api/providers/indexing/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const [res] = await getDb().select().from(indexingModelProfiles).where(eq(indexingModelProfiles.id, request.params.id)).limit(1);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "IndexingModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.post<{ Body: z.infer<typeof indexingProfileSchema> }>(
    "/api/providers/indexing",
    { schema: { body: indexingProfileSchema } },
    async (request, reply) => {
      const id = randomUUID();
      const [res] = await getDb().insert(indexingModelProfiles).values({
        id,
        ...request.body,
        apiKey: request.body.apiKey == null ? null : encrypt(request.body.apiKey),
        endpointUrl: request.body.endpointUrl ?? null
      }).returning();
      return reply.status(201).send(redactSecrets(res as unknown as Record<string, unknown>));
    }
  );

  app.put<{ Params: { id: string }; Body: z.infer<typeof updateIndexingProfileSchema> }>(
    "/api/providers/indexing/:id",
    { schema: { params: paramIdSchema, body: updateIndexingProfileSchema } },
    async (request, reply) => {
      const updates = { ...request.body };
      if (updates.apiKey !== undefined) updates.apiKey = updates.apiKey == null ? null : encrypt(updates.apiKey);
      const [res] = await getDb()
        .update(indexingModelProfiles)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(eq(indexingModelProfiles.id, request.params.id))
        .returning();
      if (!res) return reply.status(404).send({ error: "Not Found", message: "IndexingModelProfile not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/providers/indexing/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const deleted = await getDb().delete(indexingModelProfiles).where(eq(indexingModelProfiles.id, request.params.id)).returning();
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "IndexingModelProfile not found" });
      return reply.status(204).send();
    }
  );
}

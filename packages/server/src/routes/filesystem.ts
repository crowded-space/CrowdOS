import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LocalFilesystem } from "../Filesystem/filesystem-gate.js";
import { getWorkspaceRecord } from "../workspace/workspace-gate.js";
import * as path from "node:path";
import process from "node:process";

import { getDb } from "../shared/config/database.js";
import { workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { TtlCache } from "../shared/core/ttl-cache.js";

// ponytail: workspace row cached 30s — every filesystem op hit the workspaces table.
const wsRowCache = new TtlCache<{ id: string; rootPath: string; ownerId: string | null }>(30_000, 200);

async function getDynamicFilesystem(workspaceId: string, actorId?: string, requestDb?: any): Promise<LocalFilesystem | null> {
  const cached = wsRowCache.get(workspaceId);
  if (cached) {
    const resolvedActor = actorId || cached.ownerId || process.env.SYSTEM_ACTOR_ID || "system";
    return new LocalFilesystem({
      workspaceId: cached.id,
      workspaceRoot: cached.rootPath,
      actorId: resolvedActor,
    });
  }

  // 1. Check local registry first (Zero-DB boot compliant)
  try {
    const regRecord = await getWorkspaceRecord(workspaceId);
    if (regRecord) {
      wsRowCache.set(workspaceId, { id: regRecord.id, rootPath: regRecord.rootPath, ownerId: "system" });
      const resolvedActor = actorId || process.env.SYSTEM_ACTOR_ID || "system";
      return new LocalFilesystem({
        workspaceId: regRecord.id,
        workspaceRoot: regRecord.rootPath,
        actorId: resolvedActor,
      });
    }
  } catch {}

  // 2. Check DB if available
  try {
    const db = requestDb || getDb();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (ws) {
      wsRowCache.set(workspaceId, { id: ws.id, rootPath: ws.rootPath, ownerId: ws.ownerId ?? null });
      const resolvedActor = actorId || ws.ownerId || process.env.SYSTEM_ACTOR_ID || "system";
      return new LocalFilesystem({
        workspaceId: ws.id,
        workspaceRoot: ws.rootPath,
        actorId: resolvedActor,
      });
    }
  } catch {}

  // 3. Fallback for default workspace
  if (workspaceId === "default") {
    const defaultRoot = path.join(process.cwd(), "sandbox", "default");
    const resolvedActor = actorId || process.env.SYSTEM_ACTOR_ID || "system";
    return new LocalFilesystem({
      workspaceId: "default",
      workspaceRoot: defaultRoot,
      actorId: resolvedActor,
    });
  }

  return null;
}

const pathQuerySchema = z.object({
  path: z.string().default("/"),
  workspaceId: z.string().default("default"),
});

const writeBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  workspaceId: z.string().default("default"),
});

export async function filesystemRoutes(app: FastifyInstance) {
  // Initialization of all workspaces is handled in server bootstrap (index.ts)

  // GET /api/workspace/files - List directory contents
  app.get<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/files",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      const actorId = (request.headers["x-user-id"] as string) || (request.headers["x-actor-id"] as string);
      const filesystem = await getDynamicFilesystem(request.query.workspaceId, actorId, (request as any).db);
      if (!filesystem) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        const nodes = await filesystem.list(request.query.path);
        return nodes;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return [];
        }
        return reply.status(500).send({ error: "Internal Server Error", message: error.message });
      }
    }
  );

  // GET /api/workspace/files/content - Read file content
  app.get<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/files/content",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      if (!request.query.path || request.query.path === "/") {
        return reply.status(400).send({ error: "Bad Request", message: "Path is required" });
      }
      
      const actorId = (request.headers["x-user-id"] as string) || (request.headers["x-actor-id"] as string);
      const filesystem = await getDynamicFilesystem(request.query.workspaceId, actorId, (request as any).db);
      if (!filesystem) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        const content = await filesystem.read(request.query.path);
        return { content };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.status(404).send({ error: "Not Found", message: "File not found" });
        }
        return reply.status(500).send({ error: "Internal Server Error", message: error.message });
      }
    }
  );

  // POST /api/workspace/files/content - Write file content
  app.post<{ Body: z.infer<typeof writeBodySchema> }>(
    "/api/workspace/files/content",
    { schema: { body: writeBodySchema } },
    async (request, reply) => {
      const actorId = (request.headers["x-user-id"] as string) || (request.headers["x-actor-id"] as string);
      const filesystem = await getDynamicFilesystem(request.body.workspaceId, actorId, (request as any).db);
      if (!filesystem) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        await filesystem.write(request.body.path, request.body.content);
        return { success: true };
      } catch (error: any) {
        return reply.status(500).send({ error: "Internal Server Error", message: error.message });
      }
    }
  );

  // DELETE /api/workspace/files - Delete file or directory
  app.delete<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/files",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      if (!request.query.path || request.query.path === "/") {
        return reply.status(400).send({ error: "Bad Request", message: "Path is required" });
      }

      const actorId = (request.headers["x-user-id"] as string) || (request.headers["x-actor-id"] as string);
      const filesystem = await getDynamicFilesystem(request.query.workspaceId, actorId, (request as any).db);
      if (!filesystem) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        await filesystem.delete(request.query.path);
        return { success: true };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.status(404).send({ error: "Not Found", message: "File not found" });
        }
        return reply.status(500).send({ error: "Internal Server Error", message: error.message });
      }
    }
  );
}

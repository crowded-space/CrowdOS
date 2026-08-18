import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LocalVFS } from "../vfs/local-vfs.js";
import * as path from "node:path";
import process from "node:process";

import { getDb } from "../Shared/config/database.js";
import { workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";

async function getDynamicVFS(workspaceId: string): Promise<LocalVFS | null> {
  const db = getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) return null;
  
  return new LocalVFS({
    workspaceId: ws.id,
    workspaceRoot: ws.rootPath,
    actorId: "human_operator",
  });
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

export async function vfsRoutes(app: FastifyInstance) {
  // Initialization of all workspaces is handled in server bootstrap (index.ts)

  // GET /api/workspace/files - List directory contents
  app.get<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/files",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      const vfs = await getDynamicVFS(request.query.workspaceId);
      if (!vfs) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        const nodes = await vfs.list(request.query.path);
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
      
      const vfs = await getDynamicVFS(request.query.workspaceId);
      if (!vfs) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        const content = await vfs.read(request.query.path);
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
      const vfs = await getDynamicVFS(request.body.workspaceId);
      if (!vfs) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        await vfs.write(request.body.path, request.body.content);
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

      const vfs = await getDynamicVFS(request.query.workspaceId);
      if (!vfs) return reply.status(404).send({ error: "Not Found", message: "Workspace not found" });

      try {
        await vfs.delete(request.query.path);
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

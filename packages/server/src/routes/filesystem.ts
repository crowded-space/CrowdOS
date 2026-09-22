import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { basename } from "node:path";
import { LocalFilesystem } from "../Filesystem/filesystem-gate.js";
import { channelMountGate } from "../channel-mounts/channel-mount-gate.js";
import type { MountScope } from "../channel-mounts/channel-mount-gate.js";
import process from "node:process";

// ─── Root resolution ─────────────────────────────────────────────────
// The Repo panel and the agent file tools must answer "which directory" the
// same way, so both go through the ChannelMounts resolver. This route used to
// read the workspace row's `rootPath` directly (Zone A) while the tools read the
// mount (Zone B), so mounting a repository showed the panel one tree and gave
// the agents another. No cache here: a mount change must be visible on the very
// next request, and the resolver's own registry/realpath caches bound the cost.

async function resolveScope(workspaceId: string, channelId?: string): Promise<MountScope> {
  return channelMountGate.scope({ workspaceId, channelId: channelId ?? null });
}

function filesystemFor(rootPath: string, workspaceId: string, actorId?: string): LocalFilesystem {
  return new LocalFilesystem({
    workspaceId,
    workspaceRoot: rootPath,
    actorId: actorId || process.env.SYSTEM_ACTOR_ID || "system",
  });
}

// `root` selects WHICH of the two roots the caller wants. `effective` is the
// mounted repository when there is one (Zone B), otherwise the workspace's own
// sandbox (Zone A) — the same answer the agent file tools get. `workspace-local`
// pins Zone A on purpose, so the panel can show the workspace sandbox as its own
// labelled root next to a mounted repository instead of hiding it. Both roots are
// jailed by the same LocalFilesystem path guard; this is a selector, not a bypass.
const mountRootSchema = z.enum(["effective", "workspace-local"]).default("effective");

const pathQuerySchema = z.object({
  path: z.string().default("/"),
  workspaceId: z.string().default("default"),
  channelId: z.string().optional(),
  root: mountRootSchema,
});

const writeBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  workspaceId: z.string().default("default"),
  channelId: z.string().optional(),
  root: mountRootSchema,
});

type mountRoot = z.infer<typeof mountRootSchema>;

/**
 * Re-point a scope at the root the caller asked for. For `effective` this is the
 * scope as-is; for `workspace-local` the panel gets Zone A described in its own
 * terms (`zone`/`source`/`displayName`) so it can label the section honestly
 * instead of inheriting the mounted repo's identity.
 */
function scopeForRoot(scope: MountScope, root: mountRoot): MountScope {
  if (root === "effective") return scope;
  return {
    ...scope,
    path: scope.workspaceRoot,
    zone: "workspace-local",
    source: "workspace-local",
    reason: null,
    displayName: basename(scope.workspaceRoot) || scope.workspaceRoot,
  };
}

export async function filesystemRoutes(app: FastifyInstance) {
  // Initialization of all workspaces is handled in server bootstrap (index.ts)

  // GET /api/workspace/mount - Which root the panel is showing, and why.
  // Distinct from `/api/channels/:id/mount` (which reports the raw mount chain):
  // this answers "what will the tree below me actually list".
  app.get<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/mount",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      try {
        return await resolveScope(request.query.workspaceId, request.query.channelId);
      } catch (error: any) {
        return reply.status(500).send({ error: "Internal Server Error", message: error.message });
      }
    }
  );

  // GET /api/workspace/files - List directory contents
  app.get<{ Querystring: z.infer<typeof pathQuerySchema> }>(
    "/api/workspace/files",
    { schema: { querystring: pathQuerySchema } },
    async (request, reply) => {
      const actorId = (request.headers["x-user-id"] as string) || (request.headers["x-actor-id"] as string);

      try {
        const scope = await resolveScope(request.query.workspaceId, request.query.channelId);
        const target = scopeForRoot(scope, request.query.root);
        const filesystem = filesystemFor(target.path, request.query.workspaceId, actorId);
        const nodes = await filesystem.list(request.query.path);
        // Root listings carry the scope so the panel header can name the real
        // folder and say where it came from. Nested listings stay a bare array.
        if (request.query.path === "/" || request.query.path === "." || request.query.path === "") {
          return { ...target, root: request.query.root, nodes };
        }
        return nodes;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // An empty array here reads as "empty repository" in the panel, which
          // is the one thing it must never claim. Report the missing root and
          // let the caller render the honest state.
          const scope = await resolveScope(request.query.workspaceId, request.query.channelId).catch(() => null);
          const rootPath = scope ? scopeForRoot(scope, request.query.root).path : null;
          return reply.status(404).send({
            error: "Not Found",
            message: rootPath ? `Root does not exist: ${rootPath}` : "Root does not exist",
            root: request.query.root,
            path: rootPath,
          });
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

      try {
        const scope = await resolveScope(request.query.workspaceId, request.query.channelId);
        const filesystem = filesystemFor(scopeForRoot(scope, request.query.root).path, request.query.workspaceId, actorId);
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

      try {
        const scope = await resolveScope(request.body.workspaceId, request.body.channelId);
        const filesystem = filesystemFor(scopeForRoot(scope, request.body.root).path, request.body.workspaceId, actorId);
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

      try {
        const scope = await resolveScope(request.query.workspaceId, request.query.channelId);
        const filesystem = filesystemFor(scopeForRoot(scope, request.query.root).path, request.query.workspaceId, actorId);
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

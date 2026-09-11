import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { channelMountGate } from "../channel-mounts/channel-mount-gate.js";

const mountSchema = z.object({ folderPath: z.string().nullable() });
const browseQuery = z.object({ path: z.string().optional() });
const pickFolderSchema = z.object({ initialPath: z.string().nullable().optional() }).optional();

// DEPRECATED (desktop): server-spawned GUI — use Electron main dialog.showOpenDialog → validate/attach.

export async function channelMountRoutes(app: FastifyInstance) {
  // GET /api/fs/browse
  app.get<{ Querystring: z.infer<typeof browseQuery> }>("/api/fs/browse", { schema: { querystring: browseQuery } }, async (request, reply) => {
    try {
      const res = await channelMountGate.browse(request.query.path);
      return { ...res, allowedRoots: channelMountGate.allowedRoots() };
    } catch (e: any) {
      return reply.status(400).send({ error: "Browse failed", message: e?.message });
    }
  });

  // GET /api/fs/allowed-roots
  app.get("/api/fs/allowed-roots", async () => {
    return { roots: channelMountGate.allowedRoots() };
  });

  // DEPRECATED (desktop): server-spawned GUI — use Electron main dialog.showOpenDialog → validate/attach.
  // POST /api/fs/pick-folder — opens native Windows Explorer / macOS Finder / Linux file dialog and returns selected path
  app.post<{ Body?: z.infer<typeof pickFolderSchema> }>("/api/fs/pick-folder", async (_request, reply) => {
    return reply.status(410).send({ error: "Gone", message: "POST /api/fs/pick-folder is deprecated. Use desktop dialog via desktopGate." });
  });

  // GET /api/channels/:id/mount
  app.get<{ Params: { id: string } }>("/api/channels/:id/mount", async (request, reply) => {
    const info = await channelMountGate.resolve(request.params.id);
    return info;
  });

  // PUT /api/channels/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/channels/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    const result = await channelMountGate.attachChannel(request.params.id, request.body.folderPath);
    if (!result.ok) return reply.status(400).send({ error: "Bad Request", message: result.error });
    const info = await channelMountGate.resolve(request.params.id);
    // notify via global broker
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      (globalBroker as any)?.emit("channel:mount-updated", { channelId: request.params.id, ...info } as any, { channelId: request.params.id } as any);
    } catch {}
    return info;
  });

  // GET /api/categories/:id/mount
  app.get<{ Params: { id: string } }>("/api/categories/:id/mount", async (request, reply) => {
    const info = await channelMountGate.resolveCategory(request.params.id);
    return info;
  });

  // PUT /api/categories/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/categories/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    const result = await channelMountGate.attachCategory(request.params.id, request.body.folderPath);
    if (!result.ok) return reply.status(400).send({ error: "Bad Request", message: result.error });
    const info = await channelMountGate.resolveCategory(request.params.id);
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      (globalBroker as any)?.emit("category:mount-updated", { categoryId: request.params.id, ...info } as any);
    } catch {}
    return info;
  });

  // GET /api/workspaces/:id/mount
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/mount", async (request, reply) => {
    const info = await channelMountGate.resolveWorkspace(request.params.id);
    return info;
  });

  // PUT /api/workspaces/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/workspaces/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    const result = await channelMountGate.attachWorkspace(request.params.id, request.body.folderPath);
    if (!result.ok) return reply.status(400).send({ error: "Bad Request", message: result.error });
    const info = await channelMountGate.resolveWorkspace(request.params.id);
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      (globalBroker as any)?.emit("workspace:mount-updated", { ...info, workspaceId: request.params.id } as any);
    } catch {}
    return info;
  });
}

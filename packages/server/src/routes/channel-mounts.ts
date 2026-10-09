import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { channelMountGate } from "../channel-mounts/channel-mount-gate.js";

const mountSchema = z.object({ folderPath: z.string().nullable() });
// workspaceId scopes the mount jail to that workspace's registry record — the
// jail is per-workspace policy, so browsing without it falls back to the
// default policy rather than the workspace's own `allowedMountRoots`.
const browseQuery = z.object({
  path: z.string().optional(),
  workspaceId: z.string().optional(),
});
const pickFolderSchema = z.object({ initialPath: z.string().nullable().optional() }).optional();

// DEPRECATED (desktop): server-spawned GUI — use Electron main dialog.showOpenDialog → validate/attach.

export async function channelMountRoutes(app: FastifyInstance) {
  // CM-003: ownership guard. Mount paths are host paths — without a check
  // any id in the URL can read/rewrite another workspace's mount columns.
  // The decision lives behind the gate (`channelMountGate.owns`); this is
  // only the request adapter. True when the caller owns the target, or when
  // there is no caller scope to compare (keyless loopback desktop).
  async function ownsMountTarget(
    kind: "channel" | "category" | "workspace",
    id: string,
    request: any,
  ): Promise<boolean> {
    return channelMountGate.owns(kind, id, request?.workspaceId ?? null, request?.db ?? null);
  }

  // CM-003: browse/allowed-roots take the workspace id as a QUERY param, so
  // they get the same caller-vs-target check as the :id mount routes.
  function queryWorkspaceMismatch(request: any): boolean {
    const callerWs = request?.workspaceId ?? null;
    const queryWs = request?.query?.workspaceId ?? null;
    return Boolean(callerWs && queryWs && queryWs !== callerWs);
  }
  // GET /api/fs/browse
  app.get<{ Querystring: z.infer<typeof browseQuery> }>("/api/fs/browse", { schema: { querystring: browseQuery } }, async (request, reply) => {
    if (queryWorkspaceMismatch(request)) {
      return reply.status(403).send({ error: "Forbidden", message: "Workspace mismatch" });
    }
    try {
      // `browse` already returns the jail it enforced; awaiting it is what makes
      // the response a JSON object instead of a Promise serialized to `{}`.
      // A scoped caller with no explicit id browses its OWN jail, never the
      // default policy's (sandbox + home).
      const targetWs = request.query.workspaceId ?? (request as any).workspaceId ?? null;
      return await channelMountGate.browse(request.query.path, targetWs);
    } catch (e: any) {
      return reply.status(400).send({ error: "Browse failed", message: e?.message });
    }
  });

  // GET /api/fs/allowed-roots
  app.get<{ Querystring: { workspaceId?: string } }>("/api/fs/allowed-roots", async (request, reply) => {
    if (queryWorkspaceMismatch(request)) {
      return reply.status(403).send({ error: "Forbidden", message: "Workspace mismatch" });
    }
    const targetWs = request.query.workspaceId ?? (request as any).workspaceId ?? null;
    return { roots: await channelMountGate.allowedRoots(targetWs) };
  });

  // DEPRECATED (desktop): server-spawned GUI — use Electron main dialog.showOpenDialog → validate/attach.
  // POST /api/fs/pick-folder — opens native Windows Explorer / macOS Finder / Linux file dialog and returns selected path
  app.post<{ Body?: z.infer<typeof pickFolderSchema> }>("/api/fs/pick-folder", async (_request, reply) => {
    return reply.status(410).send({ error: "Gone", message: "POST /api/fs/pick-folder is deprecated. Use desktop dialog via desktopGate." });
  });

  // GET /api/channels/:id/mount
  app.get<{ Params: { id: string } }>("/api/channels/:id/mount", async (request, reply) => {
    if (!(await ownsMountTarget("channel", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Channel belongs to another workspace" });
    }
    const info = await channelMountGate.resolve(request.params.id);
    return info;
  });

  // PUT /api/channels/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/channels/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    if (!(await ownsMountTarget("channel", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Channel belongs to another workspace" });
    }
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
    if (!(await ownsMountTarget("category", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Category belongs to another workspace" });
    }
    const info = await channelMountGate.resolveCategory(request.params.id);
    return info;
  });

  // PUT /api/categories/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/categories/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    if (!(await ownsMountTarget("category", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Category belongs to another workspace" });
    }
    const result = await channelMountGate.attachCategory(request.params.id, request.body.folderPath);
    if (!result.ok) return reply.status(400).send({ error: "Bad Request", message: result.error });
    const info = await channelMountGate.resolveCategory(request.params.id);
    // CM-017/019: scope the event to the owning workspace. Without a
    // workspaceId the socket fan-out treats it as global and leaks host
    // paths to every live workspace room. Resolve degrades to workspace
    // scope only; a missing workspace still emits unscoped (legacy).
    try {
      const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
      const { channelGate } = await import("../channels/channel-gate.js");
      let workspaceId: string | null = null;
      try {
        const cat = await (channelGate as any).getCategory?.(request.params.id);
        workspaceId = (cat as any)?.workspaceId ?? null;
      } catch {}
      (globalBroker as any)?.emit(
        "category:mount-updated",
        { categoryId: request.params.id, ...(workspaceId ? { workspaceId } : {}), ...info } as any
      );
    } catch {}
    return info;
  });

  // GET /api/workspaces/:id/mount
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/mount", async (request, reply) => {
    if (!(await ownsMountTarget("workspace", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Workspace mismatch" });
    }
    const info = await channelMountGate.resolveWorkspace(request.params.id);
    return info;
  });

  // PUT /api/workspaces/:id/mount
  app.put<{ Params: { id: string }; Body: z.infer<typeof mountSchema> }>("/api/workspaces/:id/mount", { schema: { body: mountSchema } }, async (request, reply) => {
    if (!(await ownsMountTarget("workspace", request.params.id, request))) {
      return reply.status(403).send({ error: "Forbidden", message: "Workspace mismatch" });
    }
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

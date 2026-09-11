import type { FastifyInstance } from "fastify";
import { toolsGate } from "../tools/tools-gate.js";
import { authGate } from "../shared/auth/auth-gate.js";
import { maybeSend304 } from "../shared/core/http-cache.js";

export async function toolRoutes(app: FastifyInstance) {
  // GET /api/tools — list omits parameters blobs (use GET /:name for full schema)
  app.get<{ Querystring: { category?: string; authLevel?: number; limit?: number } }>(
    "/api/tools",
    async (request, reply) => {
      const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 200);
      const tools = toolsGate.list({
        category: request.query.category,
        authLevel: request.query.authLevel ? Number(request.query.authLevel) : undefined,
      }).slice(0, limit);
      const body = tools.map(({ parameters: _omitted, ...t }) => ({
        id: t.id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        category: t.category,
        sourceType: t.sourceType,
        dangerLevel: t.dangerLevel,
        authLevelRequired: t.authLevelRequired ?? 3,
      }));
      if (maybeSend304(request, reply, body)) return;
      return body;
    }
  );

  // GET /api/tools/:name
  app.get<{ Params: { name: string } }>(
    "/api/tools/:name",
    async (request, reply) => {
      const tool = toolsGate.get(request.params.name);
      if (!tool) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: `Tool '${request.params.name}' not found` });
      }
      const body = {
        id: tool.id,
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        category: tool.category,
        sourceType: tool.sourceType,
        dangerLevel: tool.dangerLevel,
        authLevelRequired: tool.authLevelRequired ?? 3,
        parameters: tool.parameters,
      };
      if (maybeSend304(request, reply, body)) return;
      return body;
    }
  );

  // POST /api/tools/execute-test
  app.post<{ Body: { agentId?: string; toolName: string; args: Record<string, any> } }>(
    "/api/tools/execute-test",
    {
      preHandler: authGate.requireAdmin,
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const { agentId = "agent-l1", toolName, args } = request.body;
      const result = await toolsGate.execute(agentId, toolName, args, {
        workspaceId: "default",
        channelId: "general",
      });
      return result;
    }
  );
}

import type { FastifyInstance } from "fastify";
import { toolsGate } from "../tools/toolsGate.js";
import { authGate } from "../Shared/auth/authGate.js";

export async function toolRoutes(app: FastifyInstance) {
  // GET /api/tools
  app.get<{ Querystring: { category?: string; authLevel?: number } }>(
    "/api/tools",
    async (request) => {
      const tools = toolsGate.list({
        category: request.query.category,
        authLevel: request.query.authLevel ? Number(request.query.authLevel) : undefined,
      });
      return tools.map(t => ({
        id: t.id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        category: t.category,
        sourceType: t.sourceType,
        dangerLevel: t.dangerLevel,
        authLevelRequired: t.authLevelRequired ?? 3,
        parameters: t.parameters,
      }));
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
      return {
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

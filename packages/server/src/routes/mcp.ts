import type { FastifyInstance } from "fastify";
import { toolsGate } from "../tools/tools-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";
import { encryptRecordValues } from "../shared/core/secret-box.js";

export async function mcpRoutes(app: FastifyInstance) {
  // GET /api/mcp/servers
  app.get("/api/mcp/servers", async () => {
    return toolsGate.listMcpStatuses();
  });

  // POST /api/mcp/servers
  app.post<{ Body: { id: string; name: string; transport: 'stdio' | 'sse'; command?: string; args?: string[]; serverUrl?: string; envVars?: Record<string, string>; autoStart?: boolean } }>(
    "/api/mcp/servers",
    async (request, reply) => {
      try {
        await toolsGate.registerMcpServer({ ...request.body, envVars: encryptRecordValues(request.body.envVars) });
        globalBroker?.emit("workspace:sync", {});
        return reply.status(201).send({ success: true, server: toolsGate.getMcpStatus(request.body.id) });
      } catch (err: any) {
        return reply.status(400).send({ statusCode: 400, error: "Bad Request", message: err.message });
      }
    }
  );

  // POST /api/mcp/servers/:id/connect
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/connect",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      try {
        const status = await toolsGate.connectMcp(request.params.id);
        globalBroker?.emit("workspace:sync", {});
        return status;
      } catch (err: any) {
        return reply.status(500).send({ statusCode: 500, error: "Connection Failed", message: err.message });
      }
    }
  );

  // POST /api/mcp/servers/:id/disconnect
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/disconnect",
    async (request, reply) => {
      await toolsGate.disconnectMcp(request.params.id);
      globalBroker?.emit("workspace:sync", {});
      return reply.status(204).send();
    }
  );
}

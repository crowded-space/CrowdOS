import type { FastifyInstance } from "fastify";

import {
  agentGate,
  createAgentSchema,
  updateAgentSchema,
  listAgentsQuerySchema,
  agentParamsSchema,
} from "../Agents/agentGate.js";
import type {
  ListAgentsQuery,
  AgentParams,
  CreateAgentBody,
  UpdateAgentBody,
} from "../Agents/agentGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

export async function agentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListAgentsQuery }>(
    "/api/agents",
    {
      schema: {
        querystring: listAgentsQuerySchema,
      },
    },
    async (request) =>
      agentGate.list({
        authorityLevel: request.query.authorityLevel as 0 | 1 | 2 | 3 | undefined,
        status: request.query.status,
        isTemplate: request.query.isTemplate,
      }),
  );

  app.get<{ Params: AgentParams }>(
    "/api/agents/:id",
    {
      schema: {
        params: agentParamsSchema,
      },
    },
    async (request, reply) => {
      const agent = await agentGate.getById(request.params.id);
      if (!agent) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Agent not found",
        });
      }

      return agent;
    },
  );

  app.post<{ Body: CreateAgentBody }>(
    "/api/agents",
    {
      schema: {
        body: createAgentSchema,
      },
    },
    async (request, reply) => {
      try {
        const agent = await agentGate.create(request.body);
        emitWorkspaceSync();
        return reply.status(201).send(agent);
      } catch (error) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: error instanceof Error ? error.message : "Failed to create agent",
        });
      }
    },
  );

  app.put<{ Params: AgentParams; Body: UpdateAgentBody }>(
    "/api/agents/:id",
    {
      schema: {
        params: agentParamsSchema,
        body: updateAgentSchema,
      },
    },
    async (request, reply) => {
      try {
        const previous = await agentGate.getById(request.params.id);
        const updated = await agentGate.update(request.params.id, request.body);
        if (!updated) {
          return reply.status(404).send({
            statusCode: 404,
            error: "Not Found",
            message: "Agent not found",
          });
        }

        if (previous && previous.status === "paused" && updated.status !== "paused") {
          globalBroker?.emit("agent:resumed", { agentId: updated.id });
        }

        emitWorkspaceSync();
        return updated;
      } catch (error) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: error instanceof Error ? error.message : "Failed to update agent",
        });
      }
    },
  );

  app.delete<{ Params: AgentParams }>(
    "/api/agents/:id",
    {
      schema: {
        params: agentParamsSchema,
      },
    },
    async (request, reply) => {
      const deleted = await agentGate.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Agent not found",
        });
      }

      emitWorkspaceSync();
      return reply.status(204).send();
    },
  );
}

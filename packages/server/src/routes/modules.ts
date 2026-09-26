import type { FastifyInstance } from "fastify";
import {
  modelModuleSchema,
  updateModelModuleSchema,
  instructionModuleSchema,
  updateInstructionModuleSchema,
  toolkitModuleSchema,
  updateToolkitModuleSchema,
  constraintsModuleSchema,
  updateConstraintsModuleSchema,
  capabilitiesModuleSchema,
  updateCapabilitiesModuleSchema,
  paramIdSchema,
  listAllModules,
  listModelModules,
  getModelModule,
  createModelModule,
  updateModelModule,
  deleteModelModule,
  testModelModule,
  listInstructionModules,
  getInstructionModule,
  createInstructionModule,
  updateInstructionModule,
  deleteInstructionModule,
  listToolkitModules,
  getToolkitModule,
  createToolkitModule,
  updateToolkitModule,
  deleteToolkitModule,
  listConstraintsModules,
  getConstraintsModule,
  createConstraintsModule,
  updateConstraintsModule,
  deleteConstraintsModule,
  listCapabilitiesModules,
  getCapabilitiesModule,
  createCapabilitiesModule,
  updateCapabilitiesModule,
  deleteCapabilitiesModule,
  findReferencingAgent
} from "../modules/module-gate.js";
import type {
  CreateModelModuleBody,
  UpdateModelModuleBody,
  CreateInstructionModuleBody,
  UpdateInstructionModuleBody,
  CreateToolkitModuleBody,
  UpdateToolkitModuleBody,
  CreateConstraintsModuleBody,
  UpdateConstraintsModuleBody,
  CreateCapabilitiesModuleBody,
  UpdateCapabilitiesModuleBody,
  ModuleParams
} from "../modules/module-gate.js";
import { globalBroker } from "../shared/sockets/register-socket-server.js";
import { redactSecrets } from "../shared/core/redact.js";
import { maybeSend304 } from "../shared/core/http-cache.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

/** Tenant scope for module ops: x-workspace-id header, or query param. */
function workspaceIdFrom(request: any): string | null {
  const raw = request.headers?.["x-workspace-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === "string" && header.trim()) return header.trim();
  const q = (request.query ?? {}) as { workspaceId?: unknown };
  return typeof q.workspaceId === "string" && q.workspaceId.trim() ? q.workspaceId.trim() : null;
}

function parseListQuery(query: unknown): { limit: number; offset: number } {
  const q = (query ?? {}) as { limit?: unknown; offset?: unknown };
  // Number("")/Number(null) are 0 (finite): an empty query-string limit used
  // to clamp to 1 row instead of the documented default of 500.
  const num = (v: unknown): number =>
    v === null || v === undefined || v === "" ? Number.NaN : Number(v);
  const rawLimit = num(q.limit);
  const rawOffset = num(q.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 500;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}

export async function moduleRoutes(app: FastifyInstance) {
  // GET /api/modules - Return all modules aggregated — redact secrets (P0-2)
  app.get("/api/modules", async (request, reply) => {
    const all = await listAllModules({ ...parseListQuery(request.query), workspaceId: workspaceIdFrom(request) });
    const body = {
      ...all,
      modelModules: (all.modelModules as unknown[]).map((m) => redactSecrets(m as Record<string, unknown>)),
    };
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  // --- Model Modules ---
  app.get("/api/modules/model", async (request, reply) => {
    const wsId = workspaceIdFrom(request);
    const list = await listModelModules({ ...parseListQuery(request.query), workspaceId: wsId });
    const body = (list as unknown[]).map((m) => redactSecrets(m as Record<string, unknown>));
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getModelModule(request.params.id, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      const body = redactSecrets(res as unknown as Record<string, unknown>);
      if (maybeSend304(request, reply, body)) return;
      return body;
    }
  );

  app.post<{ Body: CreateModelModuleBody }>(
    "/api/modules/model",
    { schema: { body: modelModuleSchema } },
    async (request, reply) => {
      const res = await createModelModule(request.body, workspaceIdFrom(request));
      emitWorkspaceSync();
      return reply.status(201).send(redactSecrets(res as unknown as Record<string, unknown>));
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateModelModuleBody }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema, body: updateModelModuleSchema } },
    async (request, reply) => {
      const res = await updateModelModule(request.params.id, request.body, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      emitWorkspaceSync();
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("model", request.params.id, workspaceIdFrom(request));
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ModelModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteModelModule(request.params.id, workspaceIdFrom(request));
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  app.post<{ Params: ModuleParams }>(
    "/api/modules/model/:id/test",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const result = await testModelModule(request.params.id, workspaceIdFrom(request));
      if (!result) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      return result;
    }
  );

  // --- Instruction Modules ---
  app.get("/api/modules/instruction", async (request, reply) => {
    const body = await listInstructionModules({ ...parseListQuery(request.query), workspaceId: workspaceIdFrom(request) });
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getInstructionModule(request.params.id, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      if (maybeSend304(request, reply, res)) return;
      return res;
    }
  );

  app.post<{ Body: CreateInstructionModuleBody }>(
    "/api/modules/instruction",
    { schema: { body: instructionModuleSchema } },
    async (request, reply) => {
      const res = await createInstructionModule(request.body, workspaceIdFrom(request));
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateInstructionModuleBody }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema, body: updateInstructionModuleSchema } },
    async (request, reply) => {
      const res = await updateInstructionModule(request.params.id, request.body, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("instruction", request.params.id, workspaceIdFrom(request));
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `InstructionModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteInstructionModule(request.params.id, workspaceIdFrom(request));
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Toolkit Modules ---
  app.get("/api/modules/toolkit", async (request, reply) => {
    const body = await listToolkitModules({ ...parseListQuery(request.query), workspaceId: workspaceIdFrom(request) });
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getToolkitModule(request.params.id, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      if (maybeSend304(request, reply, res)) return;
      return res;
    }
  );

  app.post<{ Body: CreateToolkitModuleBody }>(
    "/api/modules/toolkit",
    { schema: { body: toolkitModuleSchema } },
    async (request, reply) => {
      const res = await createToolkitModule(request.body, workspaceIdFrom(request));
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateToolkitModuleBody }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema, body: updateToolkitModuleSchema } },
    async (request, reply) => {
      const res = await updateToolkitModule(request.params.id, request.body, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("toolkit", request.params.id, workspaceIdFrom(request));
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ToolkitModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteToolkitModule(request.params.id, workspaceIdFrom(request));
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Constraints Modules ---
  app.get("/api/modules/constraints", async (request, reply) => {
    const body = await listConstraintsModules({ ...parseListQuery(request.query), workspaceId: workspaceIdFrom(request) });
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getConstraintsModule(request.params.id, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      if (maybeSend304(request, reply, res)) return;
      return res;
    }
  );

  app.post<{ Body: CreateConstraintsModuleBody }>(
    "/api/modules/constraints",
    { schema: { body: constraintsModuleSchema } },
    async (request, reply) => {
      const res = await createConstraintsModule(request.body, workspaceIdFrom(request));
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateConstraintsModuleBody }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema, body: updateConstraintsModuleSchema } },
    async (request, reply) => {
      const res = await updateConstraintsModule(request.params.id, request.body, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("constraints", request.params.id, workspaceIdFrom(request));
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ConstraintsModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteConstraintsModule(request.params.id, workspaceIdFrom(request));
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Capabilities Modules ---
  app.get("/api/modules/capabilities", async (request, reply) => {
    const body = await listCapabilitiesModules({ ...parseListQuery(request.query), workspaceId: workspaceIdFrom(request) });
    if (maybeSend304(request, reply, body)) return;
    return body;
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getCapabilitiesModule(request.params.id, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      if (maybeSend304(request, reply, res)) return;
      return res;
    }
  );

  app.post<{ Body: CreateCapabilitiesModuleBody }>(
    "/api/modules/capabilities",
    { schema: { body: capabilitiesModuleSchema } },
    async (request, reply) => {
      const res = await createCapabilitiesModule(request.body, workspaceIdFrom(request));
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateCapabilitiesModuleBody }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema, body: updateCapabilitiesModuleSchema } },
    async (request, reply) => {
      const res = await updateCapabilitiesModule(request.params.id, request.body, workspaceIdFrom(request));
      if (!res) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("capabilities", request.params.id, workspaceIdFrom(request));
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `CapabilitiesModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteCapabilitiesModule(request.params.id, workspaceIdFrom(request));
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

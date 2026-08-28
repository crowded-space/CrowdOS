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
} from "../Modules/moduleGate.js";
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
} from "../Modules/moduleGate.js";
import { globalBroker } from "../Shared/sockets/registerSocketServer.js";
import { redactSecrets } from "../Shared/core/redact.js";

function emitWorkspaceSync(): void {
  globalBroker?.emit("workspace:sync", {});
}

export async function moduleRoutes(app: FastifyInstance) {
  // GET /api/modules - Return all modules aggregated — redact secrets (P0-2)
  app.get("/api/modules", async () => {
    const all = await listAllModules();
    return {
      ...all,
      modelModules: (all.modelModules as unknown[]).map((m) => redactSecrets(m as Record<string, unknown>)),
    };
  });

  // --- Model Modules ---
  app.get("/api/modules/model", async () => {
    const list = await listModelModules();
    return (list as unknown[]).map((m) => redactSecrets(m as Record<string, unknown>));
  });

  app.get<{ Params: ModuleParams }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getModelModule(request.params.id);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.post<{ Body: CreateModelModuleBody }>(
    "/api/modules/model",
    { schema: { body: modelModuleSchema } },
    async (request, reply) => {
      const res = await createModelModule(request.body);
      emitWorkspaceSync();
      return reply.status(201).send(redactSecrets(res as unknown as Record<string, unknown>));
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateModelModuleBody }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema, body: updateModelModuleSchema } },
    async (request, reply) => {
      const res = await updateModelModule(request.params.id, request.body);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      emitWorkspaceSync();
      return redactSecrets(res as unknown as Record<string, unknown>);
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/model/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("model", request.params.id);
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ModelModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteModelModule(request.params.id);
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  app.post<{ Params: ModuleParams }>(
    "/api/modules/model/:id/test",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const result = await testModelModule(request.params.id);
      if (!result) return reply.status(404).send({ error: "Not Found", message: "ModelModule not found" });
      return result;
    }
  );

  // --- Instruction Modules ---
  app.get("/api/modules/instruction", async () => listInstructionModules());

  app.get<{ Params: ModuleParams }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getInstructionModule(request.params.id);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      return res;
    }
  );

  app.post<{ Body: CreateInstructionModuleBody }>(
    "/api/modules/instruction",
    { schema: { body: instructionModuleSchema } },
    async (request, reply) => {
      const res = await createInstructionModule(request.body);
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateInstructionModuleBody }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema, body: updateInstructionModuleSchema } },
    async (request, reply) => {
      const res = await updateInstructionModule(request.params.id, request.body);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/instruction/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("instruction", request.params.id);
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `InstructionModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteInstructionModule(request.params.id);
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "InstructionModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Toolkit Modules ---
  app.get("/api/modules/toolkit", async () => listToolkitModules());

  app.get<{ Params: ModuleParams }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getToolkitModule(request.params.id);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      return res;
    }
  );

  app.post<{ Body: CreateToolkitModuleBody }>(
    "/api/modules/toolkit",
    { schema: { body: toolkitModuleSchema } },
    async (request, reply) => {
      const res = await createToolkitModule(request.body);
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateToolkitModuleBody }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema, body: updateToolkitModuleSchema } },
    async (request, reply) => {
      const res = await updateToolkitModule(request.params.id, request.body);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/toolkit/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("toolkit", request.params.id);
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ToolkitModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteToolkitModule(request.params.id);
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ToolkitModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Constraints Modules ---
  app.get("/api/modules/constraints", async () => listConstraintsModules());

  app.get<{ Params: ModuleParams }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getConstraintsModule(request.params.id);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      return res;
    }
  );

  app.post<{ Body: CreateConstraintsModuleBody }>(
    "/api/modules/constraints",
    { schema: { body: constraintsModuleSchema } },
    async (request, reply) => {
      const res = await createConstraintsModule(request.body);
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateConstraintsModuleBody }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema, body: updateConstraintsModuleSchema } },
    async (request, reply) => {
      const res = await updateConstraintsModule(request.params.id, request.body);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/constraints/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("constraints", request.params.id);
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `ConstraintsModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteConstraintsModule(request.params.id);
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "ConstraintsModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );

  // --- Capabilities Modules ---
  app.get("/api/modules/capabilities", async () => listCapabilitiesModules());

  app.get<{ Params: ModuleParams }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const res = await getCapabilitiesModule(request.params.id);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      return res;
    }
  );

  app.post<{ Body: CreateCapabilitiesModuleBody }>(
    "/api/modules/capabilities",
    { schema: { body: capabilitiesModuleSchema } },
    async (request, reply) => {
      const res = await createCapabilitiesModule(request.body);
      emitWorkspaceSync();
      return reply.status(201).send(res);
    }
  );

  app.put<{ Params: ModuleParams; Body: UpdateCapabilitiesModuleBody }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema, body: updateCapabilitiesModuleSchema } },
    async (request, reply) => {
      const res = await updateCapabilitiesModule(request.params.id, request.body);
      if (!res) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      emitWorkspaceSync();
      return res;
    }
  );

  app.delete<{ Params: ModuleParams }>(
    "/api/modules/capabilities/:id",
    { schema: { params: paramIdSchema } },
    async (request, reply) => {
      const referencingAgent = await findReferencingAgent("capabilities", request.params.id);
      if (referencingAgent) {
        return reply.status(409).send({
          error: "Conflict",
          message: `CapabilitiesModule is still used by agent "${referencingAgent.name}". Reassign or delete that agent first.`,
        });
      }

      const deleted = await deleteCapabilitiesModule(request.params.id);
      if (deleted.length === 0) return reply.status(404).send({ error: "Not Found", message: "CapabilitiesModule not found" });
      emitWorkspaceSync();
      return reply.status(204).send();
    }
  );
}

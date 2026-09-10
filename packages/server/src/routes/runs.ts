import type { FastifyInstance } from "fastify";
import { authGate } from "../Shared/auth/authGate.js";
import { runsGate } from "../Runs/runsGate.js";
import { queueGate } from "../Queue/queueGate.js";
import { workspaceGate } from "../Workspace/workspaceGate.js";

function workspaceMismatch(run: { workspaceId?: string | null }, workspaceId: string): boolean {
  return run.workspaceId !== workspaceId;
}

export async function runsRoutes(app: FastifyInstance) {
  app.post("/api/runs/:id/resume", { preHandler: authGate.requireRole("operator") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const existing = await runsGate.getById(id);
    if (!existing) {
      return reply.status(404).send({ error: "run not found", runId: id });
    }
    if (workspaceMismatch(existing, workspaceId)) {
      return reply.status(403).send({ error: "Run does not belong to this workspace", runId: id });
    }
    const result = await runsGate.resumeRun(id);
    if (!result) {
      return reply.status(400).send({ error: "run not resumable", runId: id });
    }
    const { run, checkpoint } = result;
    const queueMode = queueGate.mode();
    const resumeContext = checkpoint ? { watermarkSeq: checkpoint.watermarkSeq, completedCallIds: checkpoint.completedCallIds, historyRef: checkpoint.historyRef, updatedAt: checkpoint.updatedAt } : { watermarkSeq: 0, completedCallIds: [] as string[] };
    if (queueMode === "bullmq") {
      const messageId = `resume:${run.id}:${Date.now()}`;
      try {
        await queueGate.enqueueRun({
          runId: run.id,
          channelId: run.channelId,
          agentId: run.agentId,
          messageId,
          userInput: "",
          workspaceId: run.workspaceId ?? undefined,
          // @ts-ignore extra resume payload not typed in EnqueueRunInput
          resumeContext,
          // @ts-ignore
          resumeFrom: checkpoint,
        } as unknown as never);
      } catch (err) {
        request.log.error({ err }, "[runs] enqueue resume failed");
      }
    } else {
      try {
        const { runtimeGate } = await import("../runtime/runtimeGate.js");
        const { agentGate } = await import("../Agents/agentGate.js");
        const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
        const broker = new EventBroker();
        let agent: unknown = null;
        try {
          if (typeof (agentGate as unknown as Record<string, unknown>).getById === "function") {
            agent = await (agentGate as unknown as { getById: (id: string) => Promise<unknown> }).getById(run.agentId);
          }
        } catch {}
        if (!agent) {
          try {
            const list = await (agentGate as unknown as { list: () => Promise<unknown[]> }).list();
            agent = (list as Array<{ id: string }>).find((a) => a.id === run.agentId) ?? null;
          } catch {}
        }
        if (agent) {
          void (runtimeGate as unknown as { execute: (req: unknown) => Promise<unknown> }).execute({
            agent,
            channelId: run.channelId,
            workspaceId: workspaceGate.requireId(run.workspaceId),
            userInput: "",
            broker,
            runId: run.id,
            resumeContext,
          });
        }
      } catch (err) {
        request.log.error({ err }, "[runs] inline resume execute failed");
      }
    }
    return reply.send({ runId: run.id, status: run.status, resumeFrom: checkpoint });
  });

  app.get("/api/runs/:id/compensations", { preHandler: authGate.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (workspaceMismatch(run, workspaceId)) return reply.status(403).send({ error: "Run does not belong to this workspace" });
    const entries = await runsGate.listCompensations(id);
    return reply.send({ runId: id, entries });
  });

  app.post("/api/runs/:id/compensations/:compId/undo", { preHandler: authGate.requireAdmin }, async (request, reply) => {
    const { id, compId } = request.params as { id: string; compId: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (workspaceMismatch(run, workspaceId)) return reply.status(403).send({ error: "Run does not belong to this workspace" });
    const result = await runsGate.undoCompensation(id, compId);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    const entries = await runsGate.listCompensations(id);
    try {
      const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
      const broker = new EventBroker();
      broker.emit("run.compensations" as never, { runId: id, entries } as never, { channelId: run.channelId, workspaceId: run.workspaceId } as never);
    } catch {}
    return reply.send({ runId: id, entries });
  });

  app.get("/api/runs/:id", { preHandler: authGate.requireRole("operator") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceGate.resolveHttpWorkspaceId(request as any);
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (workspaceMismatch(run, workspaceId)) return reply.status(403).send({ error: "Run does not belong to this workspace" });
    const entries = await runsGate.listCompensations(id);
    return reply.send({ run, compensations: entries });
  });
}

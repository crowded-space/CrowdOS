import type { FastifyInstance } from "fastify";
import { runsGate } from "../runs/runs-gate.js";
import { queueGate } from "../queue/queue-gate.js";

export async function runsRoutes(app: FastifyInstance) {
  // Local-first: loopback is the trust boundary; no role gates (single user).
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await runsGate.resumeRun(id);
    if (!result) {
      return reply.status(400).send({ error: "run not resumable", runId: id });
    }
    const { run, checkpoint } = result;
    const queueMode = queueGate.mode();
    const resumeContext = checkpoint ? { watermarkSeq: checkpoint.watermarkSeq, completedCallIds: checkpoint.completedCallIds, historyRef: checkpoint.historyRef, updatedAt: checkpoint.updatedAt } : { watermarkSeq: 0, completedCallIds: [] as string[] };
    if (queueMode === "bullmq") {
      const messageId = `resume:${run.id}`;
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
        const { runtimeGate } = await import("../runtime/runtime-gate.js");
        const { agentGate } = await import("../agents/agent-gate.js");
        // ponytail: single shared instance; no orphan fallback.
        const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
        const broker = getSharedBroker();
        if (!broker) throw new Error("EventBroker not initialized (no shared broker registered).");
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
            workspaceId: run.workspaceId ?? "default",
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

  app.get("/api/runs/:id/compensations", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [run, entries] = await Promise.all([runsGate.getById(id), runsGate.listCompensations(id)]);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return reply.send({ runId: id, entries });
  });

  app.post("/api/runs/:id/compensations/:compId/undo", async (request, reply) => {
    const { id, compId } = request.params as { id: string; compId: string };
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    const result = await runsGate.undoCompensation(id, compId);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    const entries = await runsGate.listCompensations(id);
    try {
      const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
      const broker = getSharedBroker();
      if (broker) {
        broker.emit("run.compensations" as never, { runId: id, entries } as never, { channelId: run.channelId } as never);
      } else {
        console.warn("[runs] dropped run.compensations: no shared broker registered");
      }
    } catch {}
    return reply.send({ runId: id, entries });
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [run, entries] = await Promise.all([runsGate.getById(id), runsGate.listCompensations(id)]);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return reply.send({ run, compensations: entries });
  });
}

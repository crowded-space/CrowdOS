import type { FastifyInstance } from "fastify";
import { runsGate } from "../runs/runs-gate.js";
import { queueGate } from "../queue/queue-gate.js";

export async function runsRoutes(app: FastifyInstance) {
  // Local-first: loopback is the trust boundary; no role gates (single user).
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    // RUN-025: resumeRun's null contract covers "not resumable"; a transport
    // failure (DB down) still throws. Map it to the same 400 shape with the
    // real cause so a DB outage does not surface as an opaque 500.
    let result: Awaited<ReturnType<typeof runsGate.resumeRun>>;
    try {
      result = await runsGate.resumeRun(id);
    } catch (err) {
      request.log.error({ err }, "[runs] resumeRun transport failure");
      return reply.status(400).send({ error: "run not resumable", runId: id, cause: err instanceof Error ? err.message : String(err) });
    }
    if (!result) {
      return reply.status(400).send({ error: "run not resumable", runId: id });
    }
    const { run, checkpoint } = result;
    const queueMode = queueGate.mode();
    const resumeContext = checkpoint ? { watermarkSeq: checkpoint.watermarkSeq, completedCallIds: checkpoint.completedCallIds, historyRef: checkpoint.historyRef, updatedAt: checkpoint.updatedAt } : { watermarkSeq: 0, completedCallIds: [] as string[] };
    // Q-2/Q-5: delivery honesty. An enqueue/inline failure used to log and
    // still return 200 success; callers could not distinguish delivered
    // from lost resumes (or duplicate no-ops).
    let delivery: "queued" | "inline" | "failed" = queueMode === "bullmq" ? "queued" : "inline";
    let deliveryDetail: string | null = null;
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
        delivery = "failed";
        deliveryDetail = err instanceof Error ? err.message : String(err);
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
        } else {
          // RUN-006: no agent resolved = nothing will execute the resume.
          // Previously this fell through as silent "inline" success.
          request.log.error({ runId: run.id, agentId: run.agentId }, "[runs] inline resume skipped: agent not found");
          delivery = "failed";
          deliveryDetail = `agent not found: ${run.agentId}`;
        }
      } catch (err) {
        request.log.error({ err }, "[runs] inline resume execute failed");
        delivery = "failed";
        deliveryDetail = err instanceof Error ? err.message : String(err);
      }
    }
    return reply.send({ runId: run.id, status: run.status, resumeFrom: checkpoint, delivery, ...(deliveryDetail ? { deliveryDetail } : {}) });
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

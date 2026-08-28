import type { FastifyInstance } from "fastify";
import { authGate } from "../Shared/auth/authGate.js";
import { approvalGate } from "../Approvals/approvalGate.js";
import { runsGate } from "../Runs/runsGate.js";

export async function approvalsRoutes(app: FastifyInstance) {
  // List approvals for a run
  app.get("/api/approvals", { preHandler: authGate.requireRole("viewer") }, async (request, reply) => {
    const { runId } = request.query as { runId?: string };
    if (!runId) return reply.status(400).send({ error: "runId query required" });
    const rows = await approvalGate.listByRun(runId);
    return reply.send({ runId, approvals: rows });
  });

  app.get("/api/approvals/:id", { preHandler: authGate.requireRole("viewer") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await approvalGate.getById(id);
    if (!row) return reply.status(404).send({ error: "approval not found" });
    return reply.send({ approval: row });
  });

  app.get("/api/runs/:id/approvals", { preHandler: authGate.requireRole("viewer") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await runsGate.getById(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    const rows = await approvalGate.listByRun(id);
    return reply.send({ runId: id, approvals: rows });
  });

  // Decision endpoint — operator role required (SEC-1 decided_by)
  app.post("/api/approvals/:id/decision", { preHandler: authGate.requireRole("operator") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { decision?: string; scope?: string | null; expiresAt?: string | null } | undefined;
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "denied") {
      return reply.status(400).send({ error: "decision must be 'approved'|'denied'" });
    }
    const identity = (request as unknown as { identity?: { id?: string; label?: string | null } }).identity;
    const decidedBy = identity?.id ? `apikey:${identity.id}` : ((request as unknown as { userId?: string }).userId ?? "operator");
    const scope = body?.scope ?? null;
    const expiresAt = body?.expiresAt ? new Date(body.expiresAt) : undefined;

    const row = await approvalGate.getById(id);
    if (!row) return reply.status(404).send({ error: "approval not found" });
    if (row.status !== "pending") return reply.status(409).send({ error: `approval already ${row.status}` });

    const updated = await approvalGate.decide(id, { decision, decidedBy, scope, expiresAt });
    if (!updated) return reply.status(409).send({ error: "decision failed (concurrent update?)" });

    // Emit approval.decided for observers + transition run if waiting
    let channelIdForRun: string | undefined;
    try {
      const { EventBroker } = await import("../EventBroker/eventBrokerGate.js");
      const broker = new EventBroker();
      // Try globalBroker for room fan-out, fallback to fresh broker
      let emitBroker: { emit: (t: string, p: unknown, o?: unknown) => void } | null = null;
      try {
        const { globalBroker } = await import("../Shared/sockets/registerSocketServer.js");
        emitBroker = (globalBroker as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }) ?? null;
      } catch {}
      const targetBroker = emitBroker ?? broker;
      const payload = {
        runId: updated.runId,
        approvalId: updated.id,
        tool: updated.toolName,
        decision: decision as "approved" | "denied",
        decidedBy,
        scope: updated.scope,
        riskClass: updated.riskClass,
      };
      const run = await runsGate.getById(updated.runId);
      channelIdForRun = run?.channelId;
      (targetBroker as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit("approval.decided" as never, payload as never, channelIdForRun ? { channelId: channelIdForRun } as never : undefined as never);
    } catch {}

    // APR-1 policy: run continues after decision (does not cancel). If the run
    // is still WAITING_FOR_APPROVAL and no live ToolExecutor poll is active
    // (e.g., worker crash), ensure it resumes. The live poll also transitions,
    // so this is idempotent — second transition is a no-op.
    try {
      const run = await runsGate.getById(updated.runId);
      if (run?.status === "waiting_for_approval") {
        await runsGate.transition(updated.runId, "running", `approval_${decision}`);
      }
    } catch {}

    return reply.send({ approval: updated });
  });

  // Bulk sweep endpoint (admin only) — triggers TTL default-deny expiry
  app.post("/api/approvals/sweep", { preHandler: authGate.requireAdmin }, async (_request, reply) => {
    const count = await approvalGate.sweepExpired();
    // After sweeper flips pending→expired, any run still WAITING_FOR_APPROVAL
    // for an expired approval should be resumed as denied (default-deny).
    // We iterate expired rows from last sweep? For now sweepExpired already
    // handles status flip; resume is handled by waiting pollers or next sweep.
    // To make admin sweep observable, we emit expired events for each.
    // Note: expirePendingApprovals already flipped; we just report count.
    return reply.send({ swept: count });
  });
}

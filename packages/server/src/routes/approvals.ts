import type { FastifyInstance } from "fastify";
import { approvalGate, emitDecided } from "../approvals/approval-gate.js";
import { runsGate } from "../runs/runs-gate.js";

export async function approvalsRoutes(app: FastifyInstance) {
  // List approvals for a run
  // Local-first: loopback is the trust boundary; no role gates (single user).
  app.get("/api/approvals", async (request, reply) => {
    const { runId } = request.query as { runId?: string };
    if (!runId) return reply.status(400).send({ error: "runId query required" });
    const rows = await approvalGate.listByRun(runId);
    return reply.send({ runId, approvals: rows });
  });

  app.get("/api/approvals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await approvalGate.getById(id);
    if (!row) return reply.status(404).send({ error: "approval not found" });
    return reply.send({ approval: row });
  });

  app.get("/api/runs/:id/approvals", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [run, rows] = await Promise.all([runsGate.getById(id), approvalGate.listByRun(id)]);
    if (!run) return reply.status(404).send({ error: "run not found" });
    return reply.send({ runId: id, approvals: rows });
  });

  // Decision endpoint — single-user local: no role gate; decidedBy is the local operator.
  app.post("/api/approvals/:id/decision", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { decision?: string; scope?: string | null; expiresAt?: string | null } | undefined;
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "denied") {
      return reply.status(400).send({ error: "decision must be 'approved'|'denied'" });
    }
    const decidedBy = ((request as unknown as { userId?: string }).userId ?? "local-user");
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
      const { getSharedBroker } = await import("../event-broker/event-broker-gate.js");
      let emitBroker: { emit: (t: string, p: unknown, o?: unknown) => void } | null = null;
      try {
        const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
        emitBroker = (globalBroker as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }) ?? null;
      } catch {}
      const targetBroker = emitBroker ?? (getSharedBroker() as unknown as { emit: (t: string, p: unknown, o?: unknown) => void } | null);
      const run = await runsGate.getById(updated.runId);
      channelIdForRun = run?.channelId;
      emitDecided(targetBroker, {
        runId: updated.runId,
        approvalId: updated.id,
        tool: updated.toolName,
        decision,
        decidedBy,
        scope: updated.scope,
        riskClass: updated.riskClass,
        channelId: channelIdForRun,
      });
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
  // Bulk sweep endpoint — single-user local: no role gate.
  app.post("/api/approvals/sweep", async (_request, reply) => {
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

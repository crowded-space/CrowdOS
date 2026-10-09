import { approvalGate, emitDecided } from "./approval-gate.js";
import { runsGate } from "../runs/runs-gate.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";
import { getSharedBroker } from "../event-broker/event-broker-gate.js";
import { runWithDb } from "../shared/config/database.js";
import { forEachWorkspaceDb } from "../workspace/workspace-gate.js";

let interval: NodeJS.Timeout | null = null;

// AP-016 convergence contract — concurrent sweeps (API inline timer + worker
// timer in separate processes; no leader election) converge by construction:
// - `expirePendingApprovals` is one atomic UPDATE; a row lands in exactly one
//   sweep's RETURNING set, so it is expired, resumed and emitted exactly once.
// - Two sweeps flipping disjoint rows of the SAME run both race the resume;
//   the runs CAS + waiting_for_approval guard let exactly one transition land
//   (stateGate emits run.status_changed only for the CAS winner).
// - Emits stay one-per-flipped-row: each approval.decided carries its own id.
// No advisory lock is taken on purpose: it would only dedupe overlapping work,
// never change outcomes, and would add cross-DB lock handling to the fan-out.
export async function sweepApprovalsOnce(broker?: unknown): Promise<number> {
  let total = 0;
  await forEachWorkspaceDb(async (db, workspaceId) => {
    await runWithDb(db, async () => {
      total += await sweepOneDb(broker, workspaceId);
    });
  });
  // AP-003: single-DB deployments have no per-workspace URLs, so the fan-out
  // above visits nothing and pending rows never expire. Always sweep the
  // ambient/global handle too (runWithDb keeps ALS semantics for getDb).
  const { getDb } = await import("../shared/config/database.js");
  try {
    const db = getDb();
    await runWithDb(db, async () => {
      total += await sweepOneDb(broker, null);
    });
  } catch {}
  return total;
}

async function sweepOneDb(broker?: unknown, workspaceId?: string | null): Promise<number> {
  const expiredRows = await approvalGate.expirePendingApprovals();
  if (expiredRows.length === 0) return 0;
  // For each expired, resume its run as denied (default-deny policy, run continues)
  // Prefer the explicit broker, then the shared instance. A fresh EventBroker
  // would reach no subscriber (durability + fan-out live on the shared one);
  // with neither registered the emits below warn-and-skip per row.
  const eb = (broker as EventBroker | undefined) ?? getSharedBroker() ?? null;
  // Try globalBroker for room fan-out if available
  let emitBroker: EventBroker | null = null;
  try {
    const { globalBroker } = await import("../shared/sockets/register-socket-server.js");
    emitBroker = (globalBroker as unknown as EventBroker) ?? null;
  } catch {}
  const target = emitBroker ?? eb;
  for (const row of expiredRows) {
    try {
      const run = await runsGate.getById(row.runId);
      const channelId = run?.channelId;
      // Transition WAITING_FOR_APPROVAL → RUNNING (default-deny resume). If not in waiting state, no-op.
      if (run && run.status === "waiting_for_approval") {
        // XD-009: funnel through stateGate so the hop emits
        // run.status_changed like every executor-driven transition.
        const { stateGate } = await import("../state/state-gate.js");
        await stateGate.applyRunTransition({ runId: row.runId, to: "running", reason: "approval_expired_default_deny", broker: target, workspaceId: (run as any)?.workspaceId ?? workspaceId ?? null });
      }
      // Emit approval.decided with expired for observers (sweeper is sole expiry owner)
      emitDecided(target, {
        runId: row.runId,
        approvalId: row.id,
        tool: row.toolName,
        decision: "expired",
        decidedBy: null,
        scope: row.scope,
        riskClass: row.riskClass,
        channelId,
        // ponytail: tag the owning workspace so clients ignore foreign decisions.
        workspaceId: (run as any)?.workspaceId ?? workspaceId ?? undefined,
      });
    } catch (e) {
      console.warn("[ApprovalSweeper] failed to handle expired approval", row.id, (e as Error)?.message || e);
    }
  }
  return expiredRows.length;
}

export function startApprovalSweeper(broker?: unknown): void {
  if (interval) return;
  const sweep = () => void sweepApprovalsOnce(broker).catch(err => console.warn("[ApprovalSweeper] sweep failed", err?.message || err));
  // Run shortly after boot then every 30s
  setTimeout(sweep, 5000);
  interval = setInterval(sweep, 30_000);
  interval.unref?.();
  console.log("[ApprovalSweeper] Active — sweep every 30s (TTL default-deny)");
}

export function stopApprovalSweeper(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

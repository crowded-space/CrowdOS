import { approvalGate } from "./approvalGate.js";
import { runsGate } from "../Runs/runsGate.js";
import { EventBroker } from "../EventBroker/eventBrokerGate.js";

let interval: NodeJS.Timeout | null = null;

export async function sweepApprovalsOnce(broker?: unknown): Promise<number> {
  const expiredRows = await approvalGate.expirePendingApprovals();
  if (expiredRows.length === 0) return 0;
  // For each expired, resume its run as denied (default-deny policy, run continues)
  const eb = (broker as EventBroker | undefined) ?? new EventBroker();
  // Try globalBroker for room fan-out if available
  let emitBroker: EventBroker | null = null;
  try {
    const { globalBroker } = await import("../Shared/sockets/registerSocketServer.js");
    emitBroker = (globalBroker as unknown as EventBroker) ?? null;
  } catch {}
  const target = emitBroker ?? eb;
  for (const row of expiredRows) {
    try {
      const run = await runsGate.getById(row.runId);
      const channelId = run?.channelId;
      // Transition WAITING_FOR_APPROVAL → RUNNING (default-deny resume). If not in waiting state, no-op.
      if (run && run.status === "waiting_for_approval") {
        await runsGate.transition(row.runId, "running", "approval_expired_default_deny");
      }
      // Emit approval.decided with expired for observers
      try {
        (target as unknown as { emit: (t: string, p: unknown, o?: unknown) => void }).emit(
          "approval.decided" as never,
          {
            runId: row.runId,
            approvalId: row.id,
            tool: row.toolName,
            decision: "expired" as const,
            decidedBy: null,
            scope: row.scope,
            riskClass: row.riskClass,
            channelId,
          } as never,
          channelId ? ({ channelId } as never) : (undefined as never)
        );
      } catch {}
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

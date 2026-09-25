// ─── State Gate (CrowdOS §28 event→reducer→state) ─────────────────────
// Emission point for executor-driven run transitions
// (validate via state machine → persist → emit). Approvals/tools/sweeps
// still call runsGate.transition directly (no fan-out); consolidating them
// here is a follow-up.
// Depends-on: runs-gate, messages/message-gate, event-broker-gate (gates only)
import { runsGate } from "../runs/runs-gate.js";
import { messageGate } from "../messages/message-gate.js";
import type { RunStatus } from "../runs/runs-gate.js";
import type { AppendMessageInput, AppendMessageOpts } from "../messages/message-gate.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

export interface RunTransitionInput {
  runId: string;
  to: RunStatus;
  reason?: string | null;
  errorCode?: string | null;
  broker?: EventBroker | null;
}

export async function applyRunTransition(input: RunTransitionInput) {
  const outcome = await runsGate.transition(input.runId, input.to, input.reason ?? null, input.errorCode ?? null);
  if (!outcome || !outcome.changed) return outcome;
  // Single emission point for executor-driven transitions.
  try {
    const broker = input.broker ?? (await import("../event-broker/event-broker-gate.js")).getSharedBroker();
    if (!broker) {
      console.warn("[stateGate] dropped run.status_changed: no shared broker registered");
    }
    broker?.emit(
      "run.status_changed",
      {
        runId: outcome.row.id,
        agentId: outcome.row.agentId,
        channelId: outcome.row.channelId,
        workspaceId: outcome.row.workspaceId,
        runtimeType: outcome.row.runtimeType,
        status: outcome.to,
        from: outcome.from,
        reason: outcome.reason,
        errorCode: outcome.row.errorCode,
      },
      { channelId: outcome.row.channelId },
    );
  } catch (err) {
    console.error("[stateGate] Failed to emit run.status_changed:", err);
  }
  return outcome;
}

export async function applyMessage(input: AppendMessageInput, opts: AppendMessageOpts = {}) {
  // messageGate.append already commits + emits atomically; the gate exists so
  // event→state has one entry point per entity type.
  return messageGate.append(input, opts);
}

export const stateGate = {
  applyRunTransition,
  applyMessage,
};

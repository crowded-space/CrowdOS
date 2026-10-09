// ─── State Gate (CrowdOS §28 event→reducer→state) ─────────────────────
// Emission point for run transitions routed through the gate
// (validate via state machine → persist → emit). Approval decide paths
// (sweeper, REST, socket) funnel here since XD-009; tool-executor approval
// waits keep direct runsGate calls with warn-on-failure (XD-028) because the
// wait loop owns retry semantics the funnel would duplicate; research-runtime
// child hops stay direct until consolidated (STATE-002).
// Depends-on: runs-gate, messages/message-gate, event-broker-gate (gates only)
import { runsGate } from "../runs/runs-gate.js";
import { messageGate } from "../messages/message-gate.js";
import type { RunStatus } from "../runs/runs-gate.js";
import type { AppendMessageInput, AppendMessageOpts } from "../messages/message-gate.js";
import type { BrokerEventMap, EventBroker } from "../event-broker/event-broker-gate.js";

type StatusChangedPayload = BrokerEventMap["run.status_changed"];

export interface RunTransitionInput {
  runId: string;
  to: RunStatus;
  reason?: string | null;
  errorCode?: string | null;
  broker?: EventBroker | null;
  /** XD-002: thread the owning workspace so split-DB runs transition on their own handle. */
  workspaceId?: string | null;
}

export async function applyRunTransition(input: RunTransitionInput) {
  const outcome = await runsGate.transition(
    input.runId,
    input.to,
    input.reason ?? null,
    input.errorCode,
    input.workspaceId ?? null
  );
  if (!outcome || !outcome.changed) return outcome;
  const payload: StatusChangedPayload = {
    runId: outcome.row.id,
    agentId: outcome.row.agentId,
    channelId: outcome.row.channelId,
    workspaceId: outcome.row.workspaceId,
    runtimeType: outcome.row.runtimeType,
    status: outcome.to,
    from: outcome.from,
    reason: outcome.reason,
    errorCode: outcome.row.errorCode,
  };
  const room = { channelId: outcome.row.channelId };
  // Single emission point for executor-driven transitions.
  try {
    const broker = input.broker ?? (await import("../event-broker/event-broker-gate.js")).getSharedBroker();
    if (!broker) {
      // STATE-005: no silent drop - the payload is buffered so a later
      // flushPendingStatusEvents() repairs the gap (durable repair across
      // hard kills stays a Runs-domain sweep concern - see State.md Gaps).
      console.warn("[stateGate] run.status_changed deferred: no shared broker registered (buffered for replay)");
      bufferPendingStatusEvent(outcome.row.id, payload, room.channelId);
    } else {
      // A delivered status supersedes any stale buffered one for this run
      // (drop it before flushing so we never emit stale-then-fresh for one hop).
      pendingStatusEvents.delete(outcome.row.id);
      // STATE-005: repair older gaps while a live broker is in hand, then
      // deliver this change.
      if (pendingStatusEvents.size > 0) await flushPendingStatusEvents(broker);
      broker.emit("run.status_changed", payload, room);
    }
  } catch (err) {
    console.error("[stateGate] Failed to emit run.status_changed:", err);
    bufferPendingStatusEvent(outcome.row.id, payload, room.channelId);
  }
  return outcome;
}

// -- STATE-005 repair leg: buffered run.status_changed -----------------
// Emit is best-effort after persist; a missing broker or a throwing emit
// used to drop the status change forever. The gate keeps the latest payload
// per run; a caller (boot / socket registration / sweep tick) repairs the
// gap via flushPendingStatusEvents(). Latest-wins per runId, so a replay can
// never regress a run's observed status.
const PENDING_STATUS_EVENT_CAP = 500;
const pendingStatusEvents = new Map<string, { payload: StatusChangedPayload; channelId: string }>();

function bufferPendingStatusEvent(runId: string, payload: StatusChangedPayload, channelId: string): void {
  if (pendingStatusEvents.size >= PENDING_STATUS_EVENT_CAP && !pendingStatusEvents.has(runId)) {
    const oldest = pendingStatusEvents.keys().next();
    if (!oldest.done) {
      console.warn(`[stateGate] pending status buffer full (${PENDING_STATUS_EVENT_CAP}); evicting oldest run ${oldest.value}`);
      pendingStatusEvents.delete(oldest.value);
    }
  }
  pendingStatusEvents.set(runId, { payload, channelId });
}

/** Re-emit buffered status changes; returns how many were delivered. */
export async function flushPendingStatusEvents(broker?: EventBroker | null): Promise<number> {
  const target = broker ?? (await import("../event-broker/event-broker-gate.js")).getSharedBroker();
  if (!target) return 0;
  let flushed = 0;
  for (const [runId, pending] of [...pendingStatusEvents]) {
    try {
      target.emit("run.status_changed", pending.payload, { channelId: pending.channelId });
      pendingStatusEvents.delete(runId);
      flushed += 1;
    } catch (err) {
      console.error("[stateGate] Failed to flush buffered run.status_changed:", err);
    }
  }
  return flushed;
}

export function resetPendingStatusEventsForTests(): void {
  pendingStatusEvents.clear();
}

export async function applyMessage(input: AppendMessageInput, opts: AppendMessageOpts = {}) {
  // messageGate.append already commits + emits atomically; the gate exists so
  // event→state has one entry point per entity type.
  return messageGate.append(input, opts);
}

export const stateGate = {
  applyRunTransition,
  applyMessage,
  flushPendingStatusEvents,
};

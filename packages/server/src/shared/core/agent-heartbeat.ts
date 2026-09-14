import type { EventBroker } from "../../event-broker/event-broker-gate.js";
import { startMemorySweeper } from "../../memories/memories-gate.js";

/**
 * Agent heartbeat + orphan recovery (P0-4).
 *
 * Problem: agents whose process crashed while status='working' stayed 'working'
 * forever (zombie) because runtimeStates.lastHeartbeat was never written.
 *
 * Mechanism:
 * - Runtimes mark agents working/idle via markWorking/markIdle.
 * - A periodic toucher refreshes last_heartbeat for locally-active agents.
 * - A sweeper pauses any agent still 'working' in the DB whose heartbeat went
 *   stale (i.e., no live process is touching it — crash or leak). DB truth
 *   decides, so multi-process deployments stay correct.
 */

const TOUCH_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 20_000;

const locallyWorkingAgents = new Set<string>();

export function markAgentWorking(agentId: string): void {
  locallyWorkingAgents.add(agentId);
}

export function markAgentIdle(agentId: string): void {
  locallyWorkingAgents.delete(agentId);
}

async function touchWorkingAgents(): Promise<void> {
  if (locallyWorkingAgents.size === 0) return;
  // Agents owns runtime_states writes; Shared keeps only the in-mem lease.
  const { agentGate } = await import("../../agents/agent-gate.js");
  await agentGate.touchHeartbeat([...locallyWorkingAgents]);
}

export async function sweepOrphans(broker: EventBroker): Promise<void> {
  // Agents owns the orphan sweep; Shared passes the live-lease check.
  const { agentGate } = await import("../../agents/agent-gate.js");
  await agentGate.sweepOrphans(broker, { isLive: (id) => locallyWorkingAgents.has(id) });
}

let started = false;

function isBullMqMode(): boolean {
  return String(process.env.QUEUE_MODE ?? "inline").trim().toLowerCase() === "bullmq";
}

/** Starts heartbeat toucher + orphan sweeper once per process. */
export function startHeartbeatSystem(broker: EventBroker): void {
  if (started) return;
  started = true;

  const toucher = setInterval(() => void touchWorkingAgents(), TOUCH_INTERVAL_MS);
  toucher.unref?.();

  // P31 single owner = worker: in bullmq mode the maintenance worker owns the
  // orphan sweep via repeatables; skip the in-process sweeper to avoid races.
  if (!isBullMqMode()) {
    const sweeper = setInterval(() => void sweepOrphans(broker), SWEEP_INTERVAL_MS);
    sweeper.unref?.();
  }

  startMemorySweeper();

  console.log(`[Heartbeat] Active — touch every ${TOUCH_INTERVAL_MS}ms, sweep every ${SWEEP_INTERVAL_MS}ms (threshold owned by Agents).`);
}

import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../config/database.js";
import { agents, runtimeStates } from "../../db/schema.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { startMemorySweeper } from "../../Memories/memoriesGate.js";

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

const ORPHAN_AFTER_MS = (() => {
  const raw = Number(process.env.ORPHAN_AFTER_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

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
  const ids = [...locallyWorkingAgents];
  try {
    await getDb()
      .update(runtimeStates)
      .set({ lastHeartbeat: new Date() })
      .where(inArray(runtimeStates.agentId, ids));
  } catch (err) {
    console.error("[Heartbeat] Failed to touch working agents:", (err as any)?.message || err);
  }
}

export async function sweepOrphans(broker: EventBroker): Promise<void> {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS);

    const stale = await db.query.runtimeStates.findMany({
      where: and(eq(runtimeStates.status, "working"), lt(runtimeStates.lastHeartbeat, cutoff)),
      limit: 50,
    });

    for (const state of stale) {
      // A live local run would be heartbeating — if it's in our set, skip
      // (covers clock skew between touch interval and threshold).
      if (locallyWorkingAgents.has(state.agentId)) continue;

      console.warn(`[Heartbeat] Orphaned 'working' agent ${state.agentId} detected (no heartbeat since ${state.lastHeartbeat?.toISOString() ?? "never"}) — pausing.`);

      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, state.agentId));
      await db
        .update(runtimeStates)
        .set({ status: "paused", errorInfo: { code: "ORPHANED", message: "Heartbeat expired; run presumed dead.", timestamp: new Date().toISOString() } })
        .where(eq(runtimeStates.agentId, state.agentId));

      broker.emit("agent:status", { agentId: state.agentId, status: "paused" } as never);
      broker.emit("agent:paused", { agentId: state.agentId, reason: "Heartbeat expired; run presumed dead." });
    }
  } catch (err) {
    console.error("[Heartbeat] Orphan sweep failed:", (err as any)?.message || err);
  }
}

let started = false;

/** Starts heartbeat toucher + orphan sweeper once per process. */
export function startHeartbeatSystem(broker: EventBroker): void {
  if (started) return;
  started = true;

  const toucher = setInterval(() => void touchWorkingAgents(), TOUCH_INTERVAL_MS);
  const sweeper = setInterval(() => void sweepOrphans(broker), SWEEP_INTERVAL_MS);
  toucher.unref?.();
  sweeper.unref?.();

  startMemorySweeper();

  console.log(`[Heartbeat] Active — touch every ${TOUCH_INTERVAL_MS}ms, orphan threshold ${ORPHAN_AFTER_MS}ms.`);
}

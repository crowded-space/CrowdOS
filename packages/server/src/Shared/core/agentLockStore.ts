/**
 * Agent Channel Lock Store — exempt Shared utility.
 * Any domain may import this directly (per Domain Facade Standard, Shared is exempt).
 * Used by Tools (lock_in/out) and Runtime (VisibilityMatrixMiddleware) without cross-gate coupling.
 */

type LockKey = string; // `${agentId}:${channelId}`

class AgentLockStore {
  private locks = new Map<LockKey, { locked: boolean; lockedAt: Date }>();

  private key(agentId: string, channelId: string): LockKey {
    return `${agentId}:${channelId}`;
  }

  lockIn(agentId: string, channelId: string): void {
    this.locks.set(this.key(agentId, channelId), { locked: true, lockedAt: new Date() });
  }

  lockOut(agentId: string, channelId: string): void {
    this.locks.delete(this.key(agentId, channelId));
  }

  isLockedIn(agentId: string, channelId: string): boolean {
    return this.locks.get(this.key(agentId, channelId))?.locked ?? false;
  }

  /** For diagnostics / tests */
  clearAll(): void {
    this.locks.clear();
  }

  getLockedChannelsForAgent(agentId: string): string[] {
    const prefix = `${agentId}:`;
    const out: string[] = [];
    for (const k of this.locks.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  }
}

export const agentLockStore = new AgentLockStore();

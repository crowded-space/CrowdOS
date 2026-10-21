// In-flight run cancellation registry (HM2), shared by the socket trigger path
// and the scheduler fire path. Keyed `${channelId}:${agentId}`. Aborting is
// user-initiated only (user:cancel event) — never on socket disconnect, so
// background work survives browser closes.
//
// CAN-1: the value is an ARRAY of runs, not a single controller — a second
// trigger for the same key does not overwrite (and strand) the first
// controller. Entries are removed when their run settles.

export interface ActiveRunEntry {
  controller: AbortController;
  startedAt: number;
}

export const activeRuns = new Map<string, ActiveRunEntry[]>();

export function runKey(channelId: string, agentId: string): string {
  return `${channelId}:${agentId}`;
}

/** Raised when a trigger arrives for a channel:agent pair that is already running. */
export class DuplicateRunError extends Error {
  readonly code = 'already_running' as const;

  constructor(agentName: string) {
    super(`@${agentName} is already running in this channel — previous request still in progress.`);
    this.name = 'DuplicateRunError';
  }
}

export function beginRun(key: string, agentName: string): ActiveRunEntry {
  const queue = activeRuns.get(key);
  if (queue && queue.length > 0) throw new DuplicateRunError(agentName);
  const entry: ActiveRunEntry = { controller: new AbortController(), startedAt: Date.now() };
  activeRuns.set(key, [...(queue ?? []), entry]);
  return entry;
}

export function endRun(key: string, entry: ActiveRunEntry): void {
  const queue = activeRuns.get(key);
  if (!queue) return;
  const next = queue.filter((e) => e !== entry);
  if (next.length > 0) activeRuns.set(key, next);
  else activeRuns.delete(key);
}

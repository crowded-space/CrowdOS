export const RUN_STATES = [
  "created",
  "queued",
  "starting",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retrying",
  "compacting",
  "completing",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
  "orphaned",
  "resumable",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = ["completed", "failed", "cancelled"] as const;

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  // created covers the queue-wait: fresh runs park here while queued to BullMQ,
  // so the sweeper must be able to reap a non-heartbeating one like any other.
  created: ["queued", "starting", "cancelling", "failed", "orphaned"],
  queued: ["starting", "cancelling", "failed", "orphaned"],
  starting: ["running", "cancelling", "failed", "orphaned"],
  running: [
    "waiting_for_tool",
    "waiting_for_approval",
    "retrying",
    "compacting",
    "completing",
    "cancelling",
    "failed",
    "orphaned",
  ],
  waiting_for_tool: ["running", "completing", "cancelling", "failed", "orphaned"],
  waiting_for_approval: ["running", "completing", "cancelling", "failed", "orphaned"],
  retrying: ["running", "cancelling", "failed", "orphaned"],
  compacting: ["running", "cancelling", "failed", "orphaned"],
  completing: ["verifying", "completed", "failed", "cancelling", "orphaned"],
  verifying: ["completed", "failed", "cancelling", "orphaned"],
  completed: [],
  failed: [],
  cancelled: [],
  cancelling: ["cancelled"],
  orphaned: ["resumable"],
  resumable: ["queued"],
};

export interface TransitionVerdict {
  ok: boolean;
  from: RunState;
  to: RunState;
  /** True when from === to — legal no-op, no state change required. */
  noop: boolean;
  reason: string | null;
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminal(status: RunState): status is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(status);
}

export function allowedTransitions(from: RunState): readonly RunState[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: RunState, to: RunState): boolean {
  if (!isRunState(from) || !isRunState(to)) return false;
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function transition(from: RunState, to: RunState): TransitionVerdict {
  if (!isRunState(from)) {
    return { ok: false, from, to, noop: false, reason: `unknown source state "${String(from)}"` };
  }
  if (!isRunState(to)) {
    return { ok: false, from, to, noop: false, reason: `unknown target state "${String(to)}"` };
  }
  if (from === to) {
    return { ok: true, from, to, noop: true, reason: null };
  }
  if (isTerminal(from)) {
    return { ok: false, from, to, noop: false, reason: `terminal state "${from}" is immutable` };
  }
  if (TRANSITIONS[from].includes(to)) {
    return { ok: true, from, to, noop: false, reason: null };
  }
  return { ok: false, from, to, noop: false, reason: `transition "${from}" -> "${to}" is not allowed` };
}

export interface AssertTransitionOptions {
  /** Default true: illegal transitions throw. False returns the verdict instead. */
  throwOnIllegal?: boolean;
}

export function assertTransition(
  from: RunState,
  to: RunState,
  options: AssertTransitionOptions = {}
): TransitionVerdict {
  const verdict = transition(from, to);
  if (!verdict.ok && options.throwOnIllegal !== false) {
    throw new Error(`[runStateMachine] Illegal transition ${from} -> ${to}: ${verdict.reason}`);
  }
  return verdict;
}

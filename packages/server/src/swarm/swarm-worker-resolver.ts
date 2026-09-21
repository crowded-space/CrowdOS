// ─── §22/§31: resolve a plan task's assignee to a REAL worker agent ────────
//
// The planner emits `assigneeTemplate` — a free-text hint from an LLM, so it
// can be an agent id, an agent name, a level reference, or nothing usable at
// all. Before this module existed the field was parsed, persisted, printed in
// the report, and never resolved: every "worker" silently re-ran the
// requesting agent with the requesting agent's model. The swarm had the shape
// of delegation without the substance.
//
// Resolution is deliberately tier-first (§31): a swarm fans out to L3 stateless
// workers, and an L3 is the only tier whose scope is narrow enough for a
// subtask. Matching is done in priority order and every fallback is REPORTED
// (never silent) so the final report can state exactly who ran what.

// Two rules keep this honest:
//   1. A worker is never invented. If no eligible agent exists the task fails
//      with a reason, because a fabricated worker is a fabricated result.
//   2. Substitution is always disclosed. `honestSubstitution` carries the reason
//      the requested assignee could not be used.
//
// A third rule follows from §31 and is the reason this module cannot simply
// honor any id it is given: **an assignment is honored only when the named
// agent is an eligible worker (L3).** The planner is an LLM and its own prompt
// used to suggest "use the requesting agent id if unsure" — so in the default
// case the plan named the ORCHESTRATOR, and an id-first resolver would hand
// every subtask straight back to it. That is precisely the fake-delegation
// defect this module exists to remove, just wearing a matching id.
//
// Naming a non-worker is therefore treated as a substitution with a stated
// reason, not as an instruction. A caller that genuinely wants a specific
// non-L3 agent is asking for a mention or a delegation, not a swarm.

import type { AgentProfile } from "../agents/agent-gate.js";
import { agentGate } from "../agents/agent-gate.js";

export interface ResolvedWorker {
  agent: AgentProfile;
  /** How the assignee was matched — rides the swarm report. */
  matchKind: "id" | "name" | "level" | "any-l3" | "requesting-agent";
  /** Set when the requested assignee was NOT used. Never silently dropped. */
  honestSubstitution?: string;
}

/** §31: the tier a swarm fans out to. */
export const WORKER_AUTHORITY_LEVEL = 3;

const LEVEL_RE = /^\s*l(?:evel)?[\s_-]?([0-3])\s*$/i;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The plan named an agent that exists but is not a worker (§31). Fall back to a
 * real L3 when one is available, and say so. Returns null when no L3 exists, so
 * the caller can fall through to its own last-resort handling.
 */
function substituteForNonWorker(
  requested: string,
  named: AgentProfile,
  eligible: readonly AgentProfile[],
): ResolvedWorker | null {
  if (eligible.length === 0) return null;
  const picked = eligible[0];
  return {
    agent: picked,
    matchKind: "any-l3",
    honestSubstitution: `plan assigned "${requested}" to ${named.name} (L${named.authorityLevel}, not the worker tier) — used L3 worker ${picked.name} (${picked.id})`,
  };
}

/**
 * Pick the worker for one task.
 *
 * `candidates` is the already-loaded roster; callers pass it in so an N-task
 * plan resolves against ONE roster read instead of N.
 */
export function resolveWorker(
  assigneeTemplate: string | undefined | null,
  candidates: readonly AgentProfile[],
  opts: { requestingAgent: AgentProfile; excludeIds?: ReadonlySet<string> },
): ResolvedWorker {
  const exclude = opts.excludeIds ?? new Set<string>();
  const requested = typeof assigneeTemplate === "string" ? assigneeTemplate.trim() : "";

  const eligible = candidates.filter(
    (a) => !exclude.has(a.id) && a.authorityLevel === WORKER_AUTHORITY_LEVEL,
  );

  if (requested) {
    const byId = candidates.find((a) => a.id === requested && !exclude.has(a.id));
    if (byId) {
      if (byId.authorityLevel === WORKER_AUTHORITY_LEVEL) return { agent: byId, matchKind: "id" };
      const sub = substituteForNonWorker(requested, byId, eligible);
      if (sub) return sub;
    }

    const wanted = normalize(requested);
    const byName = candidates.find((a) => normalize(a.name) === wanted && !exclude.has(a.id));
    if (byName) {
      if (byName.authorityLevel === WORKER_AUTHORITY_LEVEL) return { agent: byName, matchKind: "name" };
      const sub = substituteForNonWorker(requested, byName, eligible);
      if (sub) return sub;
    }

    const levelMatch = requested.match(LEVEL_RE);
    if (levelMatch) {
      const level = Number(levelMatch[1]);
      const atLevel = candidates.filter((a) => a.authorityLevel === level && !exclude.has(a.id));
      if (atLevel.length > 0) {
        const picked = atLevel[0];
        if (level === WORKER_AUTHORITY_LEVEL) return { agent: picked, matchKind: "level" };
        return {
          agent: picked,
          matchKind: "level",
          honestSubstitution: `requested ${requested}, but L${level} is not the worker tier — used ${picked.name} (${picked.id})`,
        };
      }
    }
  }

  // The planner named something unusable (or nothing). Fan out to a real L3
  // worker rather than re-running the orchestrator.
  if (eligible.length > 0) {
    const picked = eligible[0];
    return {
      agent: picked,
      matchKind: "any-l3",
      honestSubstitution: requested
        ? `assignee "${requested}" is not a known agent — used L3 worker ${picked.name} (${picked.id})`
        : `no assignee in plan — used L3 worker ${picked.name} (${picked.id})`,
    };
  }

  // No L3 exists in this workspace. Running the orchestrator again would be
  // the exact fake-delegation defect this module removes, so the requesting
  // agent is used ONLY when it is itself an L3 (a single-tier workspace), and
  // the substitution is stated plainly.
  if (opts.requestingAgent.authorityLevel === WORKER_AUTHORITY_LEVEL && !exclude.has(opts.requestingAgent.id)) {
    return {
      agent: opts.requestingAgent,
      matchKind: "requesting-agent",
      honestSubstitution: "no separate L3 worker configured — ran as the requesting L3 agent",
    };
  }

  throw new WorkerUnavailableError(
    requested
      ? `no eligible worker for assignee "${requested}": no L3 agent exists in this workspace`
      : "no eligible worker: no L3 agent exists in this workspace",
  );
}

/** Raised when a task cannot be assigned to any real worker. Never swallowed. */
export class WorkerUnavailableError extends Error {
  readonly code = "worker_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

/**
 * Load the roster a swarm resolves against. Workspace-scoped (§30) so a
 * worker can never be pulled from another workspace's roster.
 */
export async function loadWorkerCandidates(workspaceId: string | null | undefined): Promise<AgentProfile[]> {
  const roster = await agentGate
    .list({ isTemplate: false, workspaceId: workspaceId ?? undefined })
    .catch(() => [] as AgentProfile[]);
  return roster.filter((a) => a.status !== "offline" && a.status !== "paused");
}

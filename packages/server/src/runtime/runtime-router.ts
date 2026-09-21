import type { AgentProfile } from '../agents/agent-gate.js'
import type { InterpreterOutput, RuntimeType } from './types.js'
import { logMetric } from '../shared/core/structured-log.js'

/**
 * §25 Router inputs.
 *
 * `preferredRuntime` is the channel's persisted runtime pin (§6). It is
 * deliberately NOT called "pinned" here: the pin is a *preference* the Router
 * resolves, not an instruction the executor must obey blindly — the difference
 * matters because a pin can name a runtime whose rollback flag is off.
 *
 * There is no `channelTags` field. It was threaded through the executor and the
 * router but no production caller ever populated it, so every branch reading it
 * was unreachable — a routing rule that can never fire is worse than no rule,
 * because it reads as a supported feature. Channel-level runtime intent is
 * expressed by `preferredRuntime` (persisted, validated, workspace-scoped).
 */
export interface RoutingContext {
  agent: AgentProfile
  channelName?: string
  /** §6 channel pin, resolved by the caller from channel_settings. */
  preferredRuntime?: RuntimeType
  explicitRuntime?: RuntimeType
  librarianAgentId?: string
  /** §24 stabilized intent — the Router's primary Auto input. */
  interpreterOutput?: InterpreterOutput
}

/** Why a runtime was chosen. Rides the decision log; never invented. */
export type RouteReason =
  | 'explicit'
  | 'pin'
  | 'librarian'
  | 'intent'
  | 'tier'
  | 'rollback'

export interface RouteDecision {
  runtime: RuntimeType
  reason: RouteReason
  /** Runtime that would have been chosen had the rollback flag been on. */
  rolledBackFrom?: RuntimeType
}

/**
 * §31 tiers: which runtimes each authority level may be auto-routed to.
 *
 * This is the §25 "Authority-Aware Routing" table made executable. The rule it
 * encodes is that the relationship must not be inverted: reasoning tiers get
 * reasoning-capable runtimes, the orchestrator tier owns the swarm engine, and
 * the worker tier gets narrow execution runtimes only.
 *
 * Auto is still able to reach all five runtimes (§25) — the union across tiers
 * covers the whole set; no single tier can reach all of them, which is the
 * point of having tiers at all.
 */
const TIER_ALLOWED: ReadonlyArray<ReadonlySet<RuntimeType>> = [
  // L0 — personal assistant, whole-workspace reasoning.
  new Set<RuntimeType>(['research', 'agentic', 'conversational', 'coding']),
  // L1 — specialist / reasoning tier.
  new Set<RuntimeType>(['research', 'agentic', 'conversational', 'coding']),
  // L2 — sub-specialist / swarm orchestrator (§22, §31).
  new Set<RuntimeType>(['swarm', 'agentic', 'research', 'coding', 'conversational']),
  // L3 — stateless worker: narrow execution, never the swarm engine itself.
  new Set<RuntimeType>(['agentic', 'conversational', 'coding']),
]

/** The runtime a tier falls back to when the intent names nothing usable. */
const TIER_DEFAULT: readonly RuntimeType[] = [
  'agentic', // L0
  'agentic', // L1
  'swarm',   // L2 — orchestration is this tier's job
  'agentic', // L3
]

/** §24 interaction modes map onto runtimes; 'auto' means "no opinion". */
const INTENT_TO_RUNTIME: Record<string, RuntimeType> = {
  chat: 'conversational',
  agentic: 'agentic',
  coding: 'coding',
  research: 'research',
}

export class RuntimeRouter {
  private isResearchV1Enabled(): boolean {
    return String(process.env.RESEARCH_V1 ?? "false").trim().toLowerCase() === "true"
  }

  private isSwarmV1Enabled(): boolean {
    return String(process.env.SWARM_V1 ?? "false").trim().toLowerCase() === "true"
  }

  /** §23/§25 rollback: an off flag pins its runtime to agentic. */
  private applyRollback(runtime: RuntimeType): { runtime: RuntimeType; rolledBackFrom?: RuntimeType } {
    if (runtime === "research" && !this.isResearchV1Enabled()) return { runtime: "agentic", rolledBackFrom: "research" }
    if (runtime === "swarm" && !this.isSwarmV1Enabled()) return { runtime: "agentic", rolledBackFrom: "swarm" }
    return { runtime }
  }

  /**
   * Resolve a runtime and explain the decision.
   *
   * Precedence is fixed and each step is observable:
   *   1. explicit runtime        — the user said so (§6 Manual).
   *   2. librarian agent         — a fixed service identity, not a preference.
   *   3. channel pin             — §6 Pinned, persisted per workspace.
   *   4. interpreter intent      — §24 mode, when the tier permits it.
   *   5. tier default            — §25 authority mapping.
   */
  decide(ctx: RoutingContext): RouteDecision {
    const explicit = ctx.explicitRuntime
    if (explicit) {
      const rolled = this.applyRollback(explicit)
      return rolled.rolledBackFrom
        ? { runtime: rolled.runtime, reason: 'rollback', rolledBackFrom: rolled.rolledBackFrom }
        : { runtime: rolled.runtime, reason: 'explicit' }
    }

    if (ctx.librarianAgentId && ctx.agent.id === ctx.librarianAgentId) {
      const rolled = this.applyRollback('research')
      return rolled.rolledBackFrom
        ? { runtime: rolled.runtime, reason: 'rollback', rolledBackFrom: rolled.rolledBackFrom }
        : { runtime: rolled.runtime, reason: 'librarian' }
    }

    const level = ctx.agent.authorityLevel ?? 0
    const allowed = TIER_ALLOWED[level] ?? TIER_ALLOWED[TIER_ALLOWED.length - 1]

    // §6 pin: honored when the tier permits it and the flag is on. A pin the
    // tier forbids falls through to intent/tier rather than being obeyed.
    if (ctx.preferredRuntime) {
      const pinned = ctx.preferredRuntime
      if (allowed.has(pinned)) {
        const rolled = this.applyRollback(pinned)
        return rolled.rolledBackFrom
          ? { runtime: rolled.runtime, reason: 'rollback', rolledBackFrom: rolled.rolledBackFrom }
          : { runtime: rolled.runtime, reason: 'pin' }
      }
    }

    // §24 → §25: the Interpreter's stabilized mode is the primary Auto input.
    const mode = ctx.interpreterOutput?.mode
    const intended = mode && mode !== 'auto' ? INTENT_TO_RUNTIME[mode] : undefined
    if (intended && allowed.has(intended)) {
      const rolled = this.applyRollback(intended)
      return rolled.rolledBackFrom
        ? { runtime: rolled.runtime, reason: 'rollback', rolledBackFrom: rolled.rolledBackFrom }
        : { runtime: rolled.runtime, reason: 'intent' }
    }

    const fallback = TIER_DEFAULT[level] ?? 'agentic'
    const usable = allowed.has(fallback) ? fallback : 'agentic'
    const rolled = this.applyRollback(usable)
    return rolled.rolledBackFrom
      ? { runtime: rolled.runtime, reason: 'rollback', rolledBackFrom: rolled.rolledBackFrom }
      : { runtime: rolled.runtime, reason: 'tier' }
  }

  route(ctx: RoutingContext): RuntimeType {
    const decision = this.decide(ctx)
    // Decision telemetry: one structured line per routing decision so "why did
    // this go to Swarm?" is answerable from the log without a debugger.
    logMetric({
      stage: 'router.decision',
      runtime: decision.runtime,
      reason: decision.reason,
      rolledBackFrom: decision.rolledBackFrom,
      agent: ctx.agent?.name,
      authorityLevel: ctx.agent?.authorityLevel,
      intent: ctx.interpreterOutput?.mode,
    })
    return decision.runtime
  }
}

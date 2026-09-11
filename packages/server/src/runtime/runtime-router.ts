import type { AgentProfile } from '../agents/agent-gate.js'
import type { RuntimeType } from './types.js'

export interface RoutingContext {
  agent: AgentProfile
  channelName?: string
  channelTags?: string[]
  explicitRuntime?: RuntimeType
  librarianAgentId?: string
}

export class RuntimeRouter {
  private isResearchV1Enabled(): boolean {
    return String(process.env.RESEARCH_V1 ?? "false").trim().toLowerCase() === "true"
  }

  private isSwarmV1Enabled(): boolean {
    return String(process.env.SWARM_V1 ?? "false").trim().toLowerCase() === "true"
  }

  route(ctx: RoutingContext): RuntimeType {
    if (ctx.explicitRuntime) {
      console.log(`[Router] Override->${ctx.explicitRuntime} for @${ctx.agent.name}`)
      // RT-1 rollback: pin research->agentic when flag off (router-level)
      if (ctx.explicitRuntime === "research" && !this.isResearchV1Enabled()) {
        console.log("[Router] RESEARCH_V1=false — pinning explicit research->agentic (rollback)")
        return "agentic"
      }
      if (ctx.explicitRuntime === "swarm" && !this.isSwarmV1Enabled()) {
        console.log("[Router] SWARM_V1=false — pinning explicit swarm->agentic (rollback)")
        return "agentic"
      }
      return ctx.explicitRuntime
    }

    let chosen: RuntimeType | null = null
    if (ctx.librarianAgentId && ctx.agent.id === ctx.librarianAgentId) {
      chosen = "research"
    } else if (ctx.channelTags) {
      if (ctx.channelTags.some((t) => t === "coding" || t === "dev")) {
        chosen = "coding"
      } else if (ctx.channelTags.some((t) => t === "research" || t === "data")) {
        chosen = "research"
      } else if (ctx.channelTags.some((t) => t === "swarm" || t === "ops")) {
        chosen = "swarm"
      }
    }

    if (chosen === "research" && !this.isResearchV1Enabled()) {
      console.log("[Router] RESEARCH_V1=false — pinning research->agentic (rollback)")
      chosen = "agentic"
    }
    if (chosen === "swarm" && !this.isSwarmV1Enabled()) {
      console.log("[Router] SWARM_V1=false — pinning swarm->agentic (rollback)")
      chosen = "agentic"
    }
    if (chosen) return chosen

    const level = ctx.agent.authorityLevel ?? 0

    if (level <= 1) {
      return 'agentic'
    }

    if (level === 2) {
      return this.isSwarmV1Enabled() ? 'swarm' : 'agentic'
    }

    return 'conversational'
  }
}

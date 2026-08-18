import type { AgentProfile } from '../Agents/agentGate.js'
import type { RuntimeType } from './types.js'

export interface RoutingContext {
  agent: AgentProfile
  channelName?: string
  channelTags?: string[]
  explicitRuntime?: RuntimeType
  librarianAgentId?: string
}

export class RuntimeRouter {
  route(ctx: RoutingContext): RuntimeType {
    if (ctx.explicitRuntime) {
      return ctx.explicitRuntime
    }

    if (ctx.librarianAgentId && ctx.agent.id === ctx.librarianAgentId) {
      return 'research'
    }

    if (ctx.channelTags) {
      if (ctx.channelTags.some((t) => t === 'coding' || t === 'dev')) {
        return 'coding'
      }
      if (ctx.channelTags.some((t) => t === 'research' || t === 'data')) {
        return 'research'
      }
      if (ctx.channelTags.some((t) => t === 'swarm' || t === 'ops')) {
        return 'swarm'
      }
    }

    const level = ctx.agent.authorityLevel ?? 0

    if (level <= 1) {
      return 'agentic'
    }

    if (level === 2) {
      return 'swarm'
    }

    return 'conversational'
  }
}

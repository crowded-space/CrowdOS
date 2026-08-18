import type { AgentProfile } from '../Agents/agentGate.js'
import type { EventBroker } from '../EventBroker/eventBrokerGate.js'
import type { IRuntime, RuntimeResult, RuntimeType } from './types.js'
import { ContextAssembler } from './kernel/ContextAssembler.js'
import { RuntimeRouter } from './RuntimeRouter.js'
import { ConversationalRuntime } from './runtimes/ConversationalRuntime.js'
import { AgenticRuntime } from './runtimes/AgenticRuntime.js'
import { SwarmRuntime } from './runtimes/SwarmRuntime.js'
import { CodingRuntime } from './runtimes/CodingRuntime.js'

export interface ExecuteRequest {
  agent: AgentProfile
  channelId: string
  workspaceId: string
  userInput: string
  broker: EventBroker
  channelTags?: string[]
  explicitRuntime?: RuntimeType
  librarianAgentId?: string
}

export class RuntimeExecutor {
  private assembler = new ContextAssembler()
  private router = new RuntimeRouter()
  private runtimeMap?: Record<string, IRuntime>

  private getRuntimeMap(): Record<string, IRuntime> {
    if (!this.runtimeMap) {
      const agenticInstance = new AgenticRuntime()
      const codingInstance = new CodingRuntime()
      this.runtimeMap = {
        conversational: new ConversationalRuntime(),
        agentic: agenticInstance,
        coding: codingInstance,
        research: agenticInstance,
        swarm: new SwarmRuntime(),
      }
    }
    return this.runtimeMap
  }

  async execute(req: ExecuteRequest): Promise<RuntimeResult> {
    const { agent, channelId, workspaceId, userInput, broker, channelTags, explicitRuntime, librarianAgentId } = req

    try {
      const runtimeType = this.router.route({
        agent,
        channelTags,
        explicitRuntime,
        librarianAgentId,
      })

      let resolvedType = runtimeType
      const runtimes = this.getRuntimeMap()
      let runtime = runtimes[resolvedType]
      if (!runtime) {
        console.warn(`[RuntimeExecutor] No runtime registered for type "${resolvedType}". Falling back to agentic.`)
        resolvedType = 'agentic'
        runtime = runtimes[resolvedType]
      }

      const packet = await this.assembler.assemble({
        agent,
        channelId,
        workspaceId,
        userInput,
        runtimeType: resolvedType,
      })

      return runtime.execute(packet, broker)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        requestId: 'error',
        agentId: agent.id,
        channelId,
        finalResponse: `[RuntimeExecutor] Execution failed: ${message}`,
        runtimeEvents: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'failed',
      }
    }
  }
}

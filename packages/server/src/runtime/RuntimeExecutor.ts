import type { AgentProfile } from '../Agents/agentGate.js'
import type { EventBroker } from '../EventBroker/eventBrokerGate.js'
import { runsGate } from '../Runs/runsGate.js'
import type { RunRow, RunStatus } from '../Runs/runsGate.js'
import type { IRuntime, RuntimeResult, RuntimeType } from './types.js'
import { ContextAssembler } from './kernel/ContextAssembler.js'
import { RuntimeRouter } from './RuntimeRouter.js'
import { ConversationalRuntime } from './runtimes/ConversationalRuntime.js'
import { AgenticRuntime } from './runtimes/AgenticRuntime.js'
import { SwarmRuntime } from './runtimes/SwarmRuntime.js'
import { CodingRuntime } from './runtimes/CodingRuntime.js'
import { ResearchRuntime } from './runtimes/ResearchRuntime.js'

export interface ResumeContext {
  watermarkSeq: number
  completedCallIds: string[]
  historyRef?: string
  updatedAt?: string
}

export interface ExecuteRequest {
  agent: AgentProfile
  channelId: string
  workspaceId: string
  userInput: string
  broker: EventBroker
  channelTags?: string[]
  explicitRuntime?: RuntimeType
  librarianAgentId?: string
  /** User-initiated cancellation signal (never tied to socket disconnect). */
  abortSignal?: AbortSignal
  runId?: string | null
  resumeContext?: ResumeContext | null
}

export class RuntimeExecutor {
  private assembler = new ContextAssembler()
  private router = new RuntimeRouter()
  private runtimeMap?: Record<string, IRuntime>

  private isResearchV1Enabled(): boolean {
    return String(process.env.RESEARCH_V1 ?? "false").trim().toLowerCase() === "true"
  }

  private isSwarmV1Enabled(): boolean {
    return String(process.env.SWARM_V1 ?? "false").trim().toLowerCase() === "true"
  }

  private getRuntimeMap(): Record<string, IRuntime> {
    if (!this.runtimeMap) {
      const agenticInstance = new AgenticRuntime()
      const codingInstance = new CodingRuntime()
      const researchEnabled = this.isResearchV1Enabled()
      const researchRuntime: IRuntime = researchEnabled ? new ResearchRuntime() : agenticInstance
      if (!researchEnabled) {
        console.log("[RuntimeExecutor] RESEARCH_V1=false — research routes pinned to agentic (rollback)")
      } else {
        console.log("[RuntimeExecutor] RESEARCH_V1=true — research routes to ResearchRuntime")
      }
      this.runtimeMap = {
        conversational: new ConversationalRuntime(),
        agentic: agenticInstance,
        coding: codingInstance,
        research: researchRuntime,
        swarm: new SwarmRuntime(),
      }
    } else {
      // Re-evaluate flag at call time for hot reload in tests: if flag flipped after
      // construction, swap the mapping without rebuilding the whole map.
      const researchEnabled = this.isResearchV1Enabled()
      const currentIsResearch = this.runtimeMap["research"] instanceof ResearchRuntime
      if (researchEnabled !== currentIsResearch) {
        const agenticInstance = this.runtimeMap["agentic"]
        this.runtimeMap["research"] = researchEnabled ? new ResearchRuntime() : agenticInstance
      }
    }
    return this.runtimeMap
  }

  async execute(req: ExecuteRequest): Promise<RuntimeResult> {
    const { agent, channelId, workspaceId, userInput, broker, channelTags, explicitRuntime, librarianAgentId, abortSignal, runId: requestedRunId, resumeContext } = req

    let run: RunRow | null = null
    let isResume = false
    try {
      const runtimeType = this.router.route({
        agent,
        channelTags,
        explicitRuntime,
        librarianAgentId,
      })

      let resolvedType = runtimeType
      // RT-1 rollback: RESEARCH_V1=false pins research→agentic at executor layer too (belt+braces)
      if (resolvedType === "research" && !this.isResearchV1Enabled()) {
        console.log("[RuntimeExecutor] RESEARCH_V1=false — pinning runtime research->agentic (rollback at executor)")
        resolvedType = "agentic"
      }
      if (resolvedType === "swarm" && !this.isSwarmV1Enabled()) {
        console.log("[RuntimeExecutor] SWARM_V1=false — pinning runtime swarm->agentic (rollback at executor)")
        resolvedType = "agentic"
      }
      const runtimes = this.getRuntimeMap()
      let runtime = runtimes[resolvedType]
      if (!runtime) {
        console.warn(`[RuntimeExecutor] No runtime registered for type "${resolvedType}". Falling back to agentic.`)
        resolvedType = 'agentic'
        runtime = runtimes[resolvedType]
      }

      if (requestedRunId && resumeContext) {
        const fetched = await runsGate.getById(requestedRunId)
        if (!fetched) throw new Error(`Resume requested but run not found: ${requestedRunId}`)
        run = fetched
        isResume = true
        if (run.status === "queued") {
          run = await this.walkTransitions(broker, run, ["starting", "running"], "resume_started", null)
        } else if (run.status === "resumable") {
          run = await this.walkTransitions(broker, run, ["queued", "starting", "running"], "resume_started", null)
        } else if (run.status !== "running") {
          console.warn(`[RuntimeExecutor] Resume requested for run ${run.id} in status ${run.status} — proceeding without transition walk`)
        }
      } else {
        run = await this.openRun(broker, agent.id, channelId, workspaceId, resolvedType)
      }

      const packet = await this.assembler.assemble({
        agent,
        channelId,
        workspaceId,
        userInput,
        runtimeType: resolvedType,
        abortSignal,
        runId: run?.id ?? null,
      })
      if (isResume && resumeContext) {
        (packet as unknown as Record<string, unknown>).resumeContext = resumeContext
      }

      const result = await runtime.execute(packet, broker)

      if (run) void this.closeRun(broker, run, result.status)

      // Real token accounting (P1): persist usage for budget enforcement.
      // Off the hot path — the response is already streamed/persisted; budget
      // checks (soft-cap escalation) run asynchronously.
      if (result.usage && (result.usage.promptTokens > 0 || result.usage.completionTokens > 0)) {
        void (async () => {
          try {
            const { TokenTracker } = await import('../Shared/core/tokenTracker.js')
            await TokenTracker.trackUsage(
              broker,
              agent,
              channelId,
              agent.modelModuleId ?? null,
              result.usage.promptTokens,
              result.usage.completionTokens,
              run?.id ?? null
            )
          } catch (err) {
            console.error('[RuntimeExecutor] Failed to record token usage:', err)
          }
        })()
      }

      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (run) void this.closeRun(broker, run, 'failed', 'EXECUTION_FAILED')
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

  private async openRun(
    broker: EventBroker,
    agentId: string,
    channelId: string,
    workspaceId: string,
    runtimeType: string
  ): Promise<RunRow | null> {
    try {
      // RUN-1: rows start in 'created'; the honest chain created→starting→running
      // is walked through the state machine, one durable event per hop.
      const run = await runsGate.create({ agentId, channelId, workspaceId, runtimeType })
      if (!run) return null
      return await this.walkTransitions(broker, run, ['starting', 'running'], 'execution_started', null)
    } catch (err) {
      console.error('[RuntimeExecutor] Failed to record run start:', err)
      return null
    }
  }

  private closeRun(
    broker: EventBroker,
    run: RunRow,
    resultStatus: RuntimeResult['status'],
    errorCodeOverride?: string
  ): Promise<void> {
    return (async () => {
      try {
        const target: RunStatus =
          resultStatus === 'cancelled' ? 'cancelled'
          : resultStatus === 'completed' ? 'completed'
          : 'failed'
        const hops: RunStatus[] =
          target === 'completed' ? ['completing', 'verifying', 'completed']
          : target === 'cancelled' ? ['cancelling', 'cancelled']
          : ['failed']
        const errorCode = errorCodeOverride ?? (target === 'failed' ? resultStatus.toUpperCase() : null)

        await this.walkTransitions(broker, run, hops, `close:${resultStatus}`, errorCode)
      } catch (err) {
        console.error('[RuntimeExecutor] Failed to finalize run:', err)
      }
    })()
  }

  private async walkTransitions(
    broker: EventBroker,
    run: RunRow,
    hops: RunStatus[],
    reason: string,
    lastHopErrorCode: string | null
  ): Promise<RunRow> {
    let current = run
    for (let i = 0; i < hops.length; i++) {
      const isLast = i === hops.length - 1
      const outcome = await runsGate.transition(
        current.id,
        hops[i],
        reason,
        isLast ? lastHopErrorCode : null
      )
      if (!outcome) {
        console.warn(
          `[RuntimeExecutor] Run ${current.id} transition ${current.status} -> ${hops[i]} rejected by state machine; leaving run at ${current.status}`
        )
        break
      }
      if (outcome.changed) this.emitRunStatus(broker, outcome.row, outcome.from, outcome.to, outcome.reason)
      current = outcome.row
    }
    return current
  }

  private emitRunStatus(
    broker: EventBroker,
    run: RunRow,
    from: RunStatus,
    to: RunStatus,
    reason: string | null
  ): void {
    try {
      broker.emit(
        'run.status_changed',
        {
          runId: run.id,
          agentId: run.agentId,
          channelId: run.channelId,
          workspaceId: run.workspaceId,
          runtimeType: run.runtimeType,
          status: to,
          from,
          reason,
          errorCode: run.errorCode,
        },
        { channelId: run.channelId }
      )
    } catch (err) {
      console.error('[RuntimeExecutor] Failed to emit run.status_changed:', err)
    }
  }
}

import type { AgentProfile } from '../agents/agent-gate.js'
import type { EventBroker } from '../event-broker/event-broker-gate.js'
import { runsGate } from '../runs/runs-gate.js'
import type { RunRow, RunStatus } from '../runs/runs-gate.js'
import type { IRuntime, RuntimeResult, RuntimeType } from './types.js'
import { ContextAssembler } from './kernel/context-assembler.js'
import { interpret } from './interpreter.js'
import { RuntimeRouter } from './runtime-router.js'
import { ConversationalRuntime } from './runtimes/conversational-runtime.js'
import { AgenticRuntime } from './runtimes/agentic-runtime.js'
import { SwarmRuntime } from './runtimes/swarm-runtime.js'
import { CodingRuntime } from './runtimes/coding-runtime.js'
import { ResearchRuntime } from './runtimes/research-runtime.js'

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
  /** §6 channel pin, already resolved from channel_settings by the caller. */
  preferredRuntime?: RuntimeType
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

  private getRuntimeMap(): Record<string, IRuntime> {
    if (!this.runtimeMap) {
      // ponytail: pin-once in RuntimeRouter — executor trusts resolvedType, no flag checks here.
      this.runtimeMap = {
        conversational: new ConversationalRuntime(),
        agentic: new AgenticRuntime(),
        coding: new CodingRuntime(),
        research: new ResearchRuntime(),
        swarm: new SwarmRuntime(),
      }
    }
    return this.runtimeMap
  }

  async execute(req: ExecuteRequest): Promise<RuntimeResult> {
    const { agent, channelId, workspaceId, userInput, broker, preferredRuntime, explicitRuntime, librarianAgentId, abortSignal, runId: requestedRunId, resumeContext } = req

    let run: RunRow | null = null
    let isResume = false
    try {
      // §24 → §25: stabilize intent first, then route. The Router stays
      // authoritative — the intent rides the packet for runtimes to consume.
      const interpreterOutput = interpret({ content: userInput, explicitRuntime })
      const runtimeType = this.router.route({
        agent,
        preferredRuntime,
        explicitRuntime,
        librarianAgentId,
        // §24: the Interpreter's stabilized intent is the Router's primary
        // Auto input. Passing it here is what closes the loop — without it the
        // interpretation is computed, attached to the packet, and never read.
        interpreterOutput,
      })

      let resolvedType = runtimeType
      const runtimes = this.getRuntimeMap()
      let runtime = runtimes[resolvedType]
      if (!runtime) {
        console.warn(`[RuntimeExecutor] No runtime registered for type "${resolvedType}". Falling back to agentic.`)
        resolvedType = 'agentic'
        runtime = runtimes[resolvedType]
      }

      if (requestedRunId) {
        // ponytail: no .catch(()=>null) — DB error must fail loudly, not fork a duplicate run
        // RUN-007: thread the workspace so split-DB rows resolve on their
        // own handle instead of the ambient pool.
        const fetched = await runsGate.getById(requestedRunId, workspaceId ?? null)
        if (fetched) {
          run = fetched
          if (resumeContext) {
            isResume = true
            if (run.status === "queued") {
              run = await this.walkTransitions(broker, run, ["starting", "running"], "resume_started", null)
              if (run.status !== "running") throw new Error(`[RuntimeExecutor] Resume failed for run ${run.id}: resume walk ended at ${run.status}, expected running`)
            } else if (run.status === "resumable") {
              run = await this.walkTransitions(broker, run, ["queued", "starting", "running"], "resume_started", null)
              if (run.status !== "running") throw new Error(`[RuntimeExecutor] Resume failed for run ${run.id}: resume walk ended at ${run.status}, expected running`)
            } else if (run.status !== "running") {
              throw new Error(`[RuntimeExecutor] Resume requested for run ${run.id} in status ${run.status} — refusing to execute with stale state`)
            }
          } else if (run.status === "created" || run.status === "queued" || run.status === "starting") {
            // H4: fresh-run / BullMQ retry reuse — adopt the caller's row, never insert a new one.
            run = await this.walkTransitions(broker, run, ["starting", "running"], "execution_started", null)
          } else if (run.status !== "running") {
            // B-02: refusing to execute with stale state (matches the resume
            // path above). A warn-and-continue here let non-executable
            // statuses (failed/cancelled/verifying/...) run code.
            throw new Error(`[RuntimeExecutor] Run ${run.id} in status ${run.status} — refusing to execute with stale state`)
          }
        } else if (resumeContext) {
          throw new Error(`Resume requested but run not found: ${requestedRunId}`)
        } else {
          run = await this.openRun(broker, agent.id, channelId, workspaceId, resolvedType)
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
        interpreterOutput,
      })
      if (isResume && resumeContext) {
        (packet as unknown as Record<string, unknown>).resumeContext = resumeContext
      }

      // Heartbeat: long LLM calls + approval waits otherwise leave updatedAt
      // stale and the orphan sweep reaps live runs. Touch every 15s while
      // the runtime owns the run; cleared as soon as execute settles.
      const heartbeatRunId = run?.id ?? null
      const heartbeat = heartbeatRunId
        // RUN-007: heartbeat on the run's own handle.
        ? setInterval(() => { void runsGate.touchRunHeartbeat(heartbeatRunId, (run as unknown as Record<string, unknown> | null)?.workspaceId as string | null ?? workspaceId ?? null) }, 15_000)
        : null
      heartbeat?.unref?.()
      let result: RuntimeResult
      try {
        result = await runtime.execute(packet, broker)
      } finally {
        if (heartbeat) clearInterval(heartbeat)
      }

      if (run) await this.closeRun(broker, run, result.status)

      // Real token accounting (P1): persist usage for budget enforcement.
      // Off the hot path — the response is already streamed/persisted; budget
      // checks (soft-cap escalation) run asynchronously.
      if (result.usage && (result.usage.promptTokens > 0 || result.usage.completionTokens > 0)) {
        void (async () => {
          // B-04: one attempt + log silently skewed budgets on DB blips.
          // Retry 3x with backoff before declaring the usage lost.
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const { TokenTracker } = await import('../shared/core/token-tracker.js')
              await TokenTracker.trackUsage(
                broker,
                agent,
                channelId,
                agent.modelModuleId ?? null,
                result.usage.promptTokens,
                result.usage.completionTokens,
                run?.id ?? null,
                workspaceId
              )
              return;
            } catch (err) {
              if (attempt === 2) console.error('[RuntimeExecutor] token usage lost after 3 attempts:', err);
              else await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        })()
      }

      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (run) await this.closeRun(broker, run, 'failed', 'EXECUTION_FAILED')
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
    // CrowdOS §28: sole mutator is stateGate — validate→persist→emit in one place.
    const { stateGate } = await import('../state/state-gate.js')
    let current = run
    for (let i = 0; i < hops.length; i++) {
      const isLast = i === hops.length - 1
      const outcome = await stateGate.applyRunTransition({
        runId: current.id,
        to: hops[i],
        reason,
        errorCode: isLast ? lastHopErrorCode : null,
        broker,
        // XD-002: the run row knows its workspace; thread it so the
        // transition resolves the same DB handle the row was created on.
        workspaceId: (current as unknown as Record<string, unknown>).workspaceId as string | null ?? null,
      })
      if (!outcome) {
        throw new Error(
          `[RuntimeExecutor] Run ${current.id} transition ${current.status} -> ${hops[i]} rejected by state machine; refusing to execute with stale state`
        )
      }
      current = outcome.row
    }
    return current
  }
}

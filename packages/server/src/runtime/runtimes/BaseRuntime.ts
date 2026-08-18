import type { ContextPacket, RuntimeResult, IRuntime, RuntimeType } from '../types.js'
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js'
import { RuntimeKernel } from '../kernel/RuntimeKernel.js'

export abstract class BaseRuntime implements IRuntime {
  abstract readonly type: RuntimeType
  protected readonly kernel: RuntimeKernel

  constructor() {
    this.kernel = new RuntimeKernel()
  }

  abstract execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult>

  protected buildFailedResult(
    packet: ContextPacket,
    error: unknown
  ): RuntimeResult {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      requestId: packet.requestId,
      agentId: packet.agentId,
      channelId: packet.channelId,
      finalResponse: `[${this.type}Runtime] Execution failed: ${errorMessage}`,
      runtimeEvents: [
        this.kernel.buildEvent('agent:status', { agentId: packet.agentId, status: 'idle' }),
      ],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'failed',
    }
  }
}

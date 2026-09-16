import { randomUUID } from "node:crypto";
import type { AgentProfile } from "../../agents/agent-gate.js";
import type {
  ContextPacket,
  RuntimePolicy,
  RuntimeType,
  ModelModuleConfig,
} from "../types.js";
import { contextPipeline } from "./context-pipeline-manager.js";

/**
 * CTX-2 precedence doc: constraints > instructions > persona > history
 * Enforced by systemPromptBlocks priority ordering (lower number = higher precedence, earlier in prompt).
 * This constant is asserted in contextIntegrity tests.
 */
export const CONTEXT_PRECEDENCE = [
  "safety_constraints",
  "instruction_stack",
  "identity_authority",
] as const;

export const CONTEXT_PRECEDENCE_PRIORITIES: Record<string, number> = {
  safety_constraints: 10,
  instruction_stack: 15,
  identity_authority: 20,
};

export interface AssembleOptions {
  agent: AgentProfile;
  channelId: string;
  workspaceId: string;
  userInput: string;
  runtimeType: RuntimeType;
  policyOverrides?: Partial<RuntimePolicy>;
  /** Cancellation signal propagated onto the packet (user-initiated cancel only). */
  abortSignal?: AbortSignal;
  /** RUN-0 correlation id copied onto the packet so persisted messages trace to a run row. */
  runId?: string | null;
}

export class ContextAssembler {
  async assemble(
    options: AssembleOptions
  ): Promise<ContextPacket & { _modelConfig: ModelModuleConfig }> {
    const { agent, channelId, workspaceId, userInput, runtimeType, policyOverrides, abortSignal, runId } = options;
    const obsMod: typeof import("../../observability/observability-gate.js") | null = await import("../../observability/observability-gate.js").catch(() => null);
    const tracing = obsMod?.observabilityGate ?? null;
    const span = tracing ? tracing.startSpan("assemble", { runId: runId ?? null, channelId, agentId: agent.id, attributes: { runtimeType } }) : null;
    try {
      const compiled = await contextPipeline.assemble({
        agent,
        channelId,
        workspaceId,
        userInput,
        runtimeType,
        abortSignal,
      });

      const policies: RuntimePolicy = {
        ...compiled.policies,
        allowToolCalls: ["agentic", "coding", "research", "swarm"].includes(runtimeType),
        allowSpawn: ["swarm"].includes(runtimeType),
        allowDelegation: ["swarm"].includes(runtimeType),
        ...policyOverrides,
      };

      const result: ContextPacket & { _modelConfig: ModelModuleConfig } = {
        requestId: randomUUID(),
        agentId: agent.id,
        agentName: agent.name,
        authorityLevel: agent.authorityLevel,
        channelId,
        workspaceId,
        userInput,
        systemPrompt: compiled.systemPrompt,
        history: compiled.history,
        tools: compiled.tools,
        memoryPreviewBlock: compiled.memoryPreviewBlock,
        policies,
        metadata: {
          runtimeType,
          provider: compiled._modelConfig.provider,
          modelName: compiled._modelConfig.modelName,
          modelModuleId: agent.modelModuleId || "default",
          startedAt: new Date(),
        },
        _modelConfig: compiled._modelConfig,
        abortSignal,
        runId: runId ?? null,
      };
      if (span && tracing) tracing.endSpan(span, { attributes: { historyLen: result.history.length, toolCount: result.tools?.length ?? 0 } });
      return result;
    } catch (err) {
      if (span && tracing) tracing.endSpan(span, { error: err, attributes: { runtimeType } });
      throw err;
    }
  }
}

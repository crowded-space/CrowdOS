import { randomUUID } from "node:crypto";
import type { AgentProfile } from "../../Agents/agentGate.js";
import type {
  ContextPacket,
  RuntimePolicy,
  RuntimeType,
  ModelModuleConfig,
} from "../types.js";
import { contextPipeline } from "./ContextPipelineManager.js";

export interface AssembleOptions {
  agent: AgentProfile;
  channelId: string;
  workspaceId: string;
  userInput: string;
  runtimeType: RuntimeType;
  policyOverrides?: Partial<RuntimePolicy>;
}

export class ContextAssembler {
  async assemble(
    options: AssembleOptions
  ): Promise<ContextPacket & { _modelConfig: ModelModuleConfig }> {
    const { agent, channelId, workspaceId, userInput, runtimeType, policyOverrides } = options;

    const compiled = await contextPipeline.assemble({
      agent,
      channelId,
      workspaceId,
      userInput,
      runtimeType,
    });

    const policies: RuntimePolicy = {
      ...compiled.policies,
      allowToolCalls: ["agentic", "coding", "research", "swarm"].includes(runtimeType),
      allowSpawn: ["swarm", "orchestrator"].includes(runtimeType),
      allowDelegation: ["swarm", "orchestrator"].includes(runtimeType),
      ...policyOverrides,
    };

    return {
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
    };
  }
}

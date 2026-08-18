import type { AgentProfile } from "../../Agents/agentGate.js";
import type { RuntimeType, ModelModuleConfig, RuntimePolicy, HistoryMessage, LLMToolDefinition } from "../types.js";

export type { HistoryMessage, LLMToolDefinition };

export interface ContextBuildContext {
  agent: AgentProfile;
  channelId: string;
  workspaceId: string;
  userInput: string;
  runtimeType: RuntimeType;
  modelConfig?: ModelModuleConfig;
  abortSignal?: AbortSignal;
  customOverrides?: Record<string, unknown>;
}

export interface MutableContextPacket {
  systemPromptBlocks: Array<{ id: string; priority: number; content: string }>;
  authorityContext?: string;
  taskFileContext?: string;
  memoryPreviewBlock?: string;
  tools: LLMToolDefinition[];
  history: HistoryMessage[];
  userPrompt: string;
  policies: RuntimePolicy;
  metadata: Record<string, unknown>;
}

export interface IContextMiddleware {
  readonly name: string;
  readonly priority: number;
  process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void>;
}

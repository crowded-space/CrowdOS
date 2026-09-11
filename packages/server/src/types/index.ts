import type { ToolCall, TokenUsage } from "./tool.types.js";

export {
  type AgentProfile,
  type AuthorityLevel,
  type AgentStatus,
  type MemorySharingPolicy,
  type L3Subtype,
  type AgentAuthorityPermissions,
  type CreateAgentProfileInput,
  type UpdateAgentProfileInput,
  type AgentRegistryFilters,
} from "../agents/agent-gate.js";
export { type ModelModule, type InstructionModule, type ToolkitModule, type ConstraintsModule, type CapabilitiesModule, type ProviderEngine, type ModuleType, type ModuleUnion } from "../modules/module-gate.js";
export { type RuntimeOverride, type RuntimeState, type RuntimeOverrideType, type RuntimeStatus, type InstructionPatch, type PermissionPatch } from "./runtime.types.js";

export interface StandardMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface GenerationResult {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_call" | "length" | "error";
}

export interface StreamChunk {
  content?: string;
  toolCall?: Partial<ToolCall>;
  usage?: TokenUsage;
  done: boolean;
}

export interface TokenBudget {
  globalSoftCap: number;
  perProviderBudget: Record<string, {
    softCap: number;
    used: number;
    resetPeriod: "daily" | "weekly" | "monthly" | "never";
    lastResetAt: Date;
  }>;
}

export interface TokenUsageLog {
  id: string;
  agentId: string;
  channelId: string;
  modelProfileId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: Date;
}

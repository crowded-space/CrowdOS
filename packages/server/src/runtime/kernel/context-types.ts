import type { AgentProfile } from "../../agents/agent-gate.js";
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
  customOverrides?: Record<string, unknown> & { contextTokenCap?: number };
  /**
   * Advisory operator identity + preference (client profile). Null/undefined =
   * no preference set; middlewares must push nothing for it.
   */
  operatorContext?: { name: string; tag: string; preference: string } | null;
}

export interface MutableContextPacket {
  systemPromptBlocks: Array<{ id: string; priority: number; content: string }>;
  authorityContext?: string;
  taskFileContext?: string;
  memoryPreviewBlock?: string;
  tools: LLMToolDefinition[];
  /**
   * CrowdOS §26 visible_capabilities: discovery-first capability summaries
   * (id + domain + one line, never schemas). Populated by ToolSchemaMiddleware
   * and lifted onto the assembled ContextPacket/RuntimePacket.
   */
  visibleCapabilities?: import("../../capabilities/capabilities-gate.js").VisibleCapability[];
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

import type { ProviderEngine } from "./provider.types.js";

export interface ToolCall {
  id: string;
  toolId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  provider?: ProviderEngine;
}

import type { ProviderEngine } from "./provider.types.js";

export type ToolDangerLevel = "low" | "medium" | "high";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  handlerId: string;
  jsonSchema: Record<string, unknown>;
  dangerLevel: ToolDangerLevel;
  authLevelRequired: 0 | 1 | 2 | 3;
}

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

import type { PiMessage, PiToolSchema, PiModelConfig, PiModelAdapter } from '../ai/types.js';

export type AgentEventType =
  | 'agent_start'
  | 'thought_delta'
  | 'message_delta'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'turn_complete'
  | 'agent_end'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  data?: any;
  content?: string;
  thoughts?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  toolResult?: {
    id: string;
    name: string;
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
  };
  error?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: PiToolSchema['parameters'];
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ success: boolean; output: string; error?: string }>;
}

export interface AgentLoopOptions {
  modelConfig: PiModelConfig;
  modelAdapter: PiModelAdapter;
  systemPrompt: string;
  history: PiMessage[];
  userInput: string;
  tools: AgentTool[];
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

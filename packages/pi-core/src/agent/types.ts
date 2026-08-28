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
  /** Cumulative token usage reported by the model adapter (turn_complete/agent_end). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: PiToolSchema['parameters'];
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ success: boolean; output: string; error?: string }>;
}

/** Typed cancellation (CAN-1): thrown by the agent loop when the run signal aborts. */
export class AgentAbortError extends Error {
  readonly signal?: AbortSignal;

  constructor(message = 'Agent execution aborted.', signal?: AbortSignal) {
    super(message);
    this.name = 'AgentAbortError';
    this.signal = signal;
  }
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

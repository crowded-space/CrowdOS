export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface MessageContentPart {
  type: 'text' | 'image' | 'tool_call' | 'tool_result';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
}

export interface PiMessage {
  role: MessageRole;
  content: string;
  thoughts?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  name?: string;
}

export interface PiToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      items?: Record<string, unknown>;
    }>;
    required?: string[];
  };
}

export interface PiModelConfig {
  provider: 'google' | 'anthropic' | 'openai' | 'ollama' | 'custom';
  modelName: string;
  apiKey?: string;
  endpointUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

export interface PiStreamChunk {
  content?: string;
  thoughts?: string;
  isThoughts?: boolean;
  toolCallDelta?: {
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
}

export interface PiLLMResponse {
  content: string;
  thoughts?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export type PiModelAdapter = (
  config: PiModelConfig,
  messages: PiMessage[],
  tools: PiToolSchema[],
  onChunk?: (chunk: PiStreamChunk) => void,
  signal?: AbortSignal
) => Promise<PiLLMResponse>;

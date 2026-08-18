import type { TokenUsage } from '../types/tool.types.js'
import type { EventBroker } from '../EventBroker/eventBrokerGate.js'

export type { TokenUsage }

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  authorName?: string
  isInternalMonologue?: boolean
  timestamp: Date
}

export interface RuntimePolicy {
  maxTokenBudget: number
  maxIterations: number
  allowToolCalls: boolean
  allowSpawn: boolean
  allowDelegation: boolean
  loopDetection: boolean
  streamOutput: boolean
}

export interface ExecutionMetadata {
  runtimeType: RuntimeType
  provider: string
  modelName: string
  modelModuleId: string
  startedAt: Date
}

export interface ContextPacket {
  requestId: string
  agentId: string
  agentName: string
  authorityLevel: number
  channelId: string
  workspaceId: string
  userInput: string
  systemPrompt: string
  history: HistoryMessage[]
  /** Optional memory preview block injected before userInput in the prompt. */
  memoryPreviewBlock?: string
  tools?: LLMToolDefinition[]
  policies: RuntimePolicy
  metadata: ExecutionMetadata
}

export interface RuntimeResult {
  requestId: string
  agentId: string
  channelId: string
  finalResponse: string
  internalMonologue?: string
  toolCalls?: ToolCallRecord[]
  memoryCandidates?: MemoryCandidate[]
  runtimeEvents: RuntimeEvent[]
  usage: TokenUsage
  status: 'completed' | 'failed' | 'loop_detected' | 'budget_exceeded'
}

export interface ToolCallRecord {
  toolName: string
  input: Record<string, unknown>
  output: string
  success: boolean
  durationMs: number
}

export interface MemoryCandidate {
  content: string
  relevanceScore: number
  shouldPersist: boolean
}

export interface RuntimeEvent {
  type: RuntimeEventType
  payload: Record<string, unknown>
  timestamp: Date
}

export type RuntimeEventType =
  | 'agent:thinking'
  | 'agent:status'
  | 'message:stream'
  | 'message:new'
  | 'tool:start'
  | 'tool:complete'
  | 'loop:detected'
  | 'budget:exceeded'
  | 'delegation:start'
  | 'spawn:start'

export interface LLMRequest {
  systemPrompt: string
  userPrompt: string
  history?: HistoryMessage[]
  temperature?: number
  maxTokens?: number
  tools?: LLMToolDefinition[]
}

export interface LLMResponse {
  content: string
  thoughts?: string
  toolCalls?: RawToolCall[]
  usage: TokenUsage
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error'
}

export interface RawToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelModuleConfig {
  provider: string
  modelName: string
  apiKey?: string
  endpointUrl?: string
  temperature?: number
  maxOutputTokens?: number
  topP?: number
}

export type RuntimeType =
  | 'conversational'
  | 'agentic'
  | 'swarm'
  | 'coding'
  | 'research'
  | 'observer'
  | 'orchestrator'

export interface IRuntime {
  type: RuntimeType
  execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult>
}

export interface IProviderAdapter {
  provider: string
  call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void
  ): Promise<LLMResponse>
  supportsStreaming: boolean
  supportsTools: boolean
}

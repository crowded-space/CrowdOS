import type { TokenUsage } from '../types/tool.types.js'
import type { EventBroker } from '../event-broker/event-broker-gate.js'
import type { VisibleCapability } from '../capabilities/capabilities-gate.js'

export type { TokenUsage }

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  authorName?: string
  // Multi-agent source tagging (agent-context only, never shown in UI)
  authorId?: string
  authorType?: 'user' | 'agent' | 'system'
  authorLevel?: string
  isSelf?: boolean
  mentions?: import('../types/mention.types.js').MentionMetadata[]
  isInternalMonologue?: boolean
  timestamp: Date
  toolCalls?: RawToolCall[]
  toolCallId?: string
  toolName?: string
}

export interface ToolCallIR {
  id: string
  tool: string
  arguments: Record<string, unknown>
}

export type AgentEvent =
  | { type: 'thought'; content: string; timestamp: Date }
  | { type: 'tool_call'; callId: string; toolName: string; input: Record<string, unknown>; timestamp: Date }
  | { type: 'tool_result'; callId: string; toolName: string; success: boolean; output: string; durationMs: number; timestamp: Date }
  | { type: 'model_output'; content: string; timestamp: Date }
  | { type: 'agent_completed'; response: string; timestamp: Date }
  | { type: 'agent_error'; error: string; timestamp: Date }

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

// CrowdOS §24: semantic stabilization only — targets, communication mode,
// execution hints. Never planning, tool choice, or memory retrieval.
export type InteractionMode = 'chat' | 'agentic' | 'coding' | 'research'

export interface InterpreterOutput {
  /** Raw @-tokens in send order (unresolved — resolution stays in dispatch). */
  targets: string[]
  /** Stabilized mode hint; 'auto' means the Router decides. */
  mode: InteractionMode | 'auto'
  /** Opaque hints (e.g. 'multi-target', 'lock_in-requested', 'code-context'). */
  executionHints: string[]
  /** True when neither target nor mode could be stabilized. */
  ambiguous: boolean
  /** Refused assumptions, listed — never silently made. */
  assumptions: string[]
}

export interface ResumeContext {
  watermarkSeq: number
  completedCallIds: string[]
  historyRef?: string
  updatedAt?: string
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
  /**
   * Cancellation signal for this run (HM2). Aborted by explicit user cancel —
   * never by browser disconnect. Propagated to LLM fetches and tool execution.
   */
  abortSignal?: AbortSignal
  /** RUN-0 correlation: id of the runs row opened for this execution (null if bookkeeping failed). */
  runId?: string | null
  resumeContext?: ResumeContext | null
  /** CrowdOS §26 interpreter_output: semantic intent attached by the Executor. */
  interpreterOutput?: InterpreterOutput
  /**
   * CrowdOS §26 visible_capabilities: discovery-first capability view for this
   * agent (id + domain + one-line summary, never schemas). Populated by the
   * ToolSchemaMiddleware so runtimes and providers can surface what is possible
   * without expanding every tool schema up front (§21).
   */
  visibleCapabilities?: VisibleCapability[]
}

export interface RuntimeResult {
  requestId: string
  agentId: string
  channelId: string
  finalResponse: string
  internalMonologue?: string
  toolCalls?: ToolCallRecord[]
  memoryCandidates?: MemoryCandidate[]
  /**
   * §26 `artifacts[]`: durable outputs this run produced, referenced rather than
   * inlined. Populated by runtimes that write artifacts (Research citations,
   * Coding diffs, the Swarm report). A runtime that writes an artifact but does
   * not report it here forces every consumer to re-query by run — the caller is
   * told what was produced instead of having to guess.
   */
  artifacts?: RuntimeArtifactRef[]
  runtimeEvents: RuntimeEvent[]
  usage: TokenUsage
  status: 'completed' | 'failed' | 'loop_detected' | 'budget_exceeded' | 'cancelled'
}

/** A durable output produced by a run (§26). Ids are the artifact rows' own. */
export interface RuntimeArtifactRef {
  id: string
  type: string
  /** Present when the runtime knows the artifact was persisted; absent when the
   *  write failed and the runtime is reporting the failure honestly. */
  persisted: boolean
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

// §6 runtime selector: Auto + the five runtimes. 'chat' is the UI name for the
// Conversational Runtime; 'conversational' is accepted as an alias so persisted
// values written before this type existed keep resolving.
export type ComposerMode = 'auto' | 'chat' | 'conversational' | 'agentic' | 'coding' | 'research' | 'swarm'

export const COMPOSER_MODE_TO_RUNTIME: Record<Exclude<ComposerMode, 'auto'>, RuntimeType> = {
  chat: 'conversational',
  conversational: 'conversational',
  agentic: 'agentic',
  coding: 'coding',
  research: 'research',
  swarm: 'swarm',
}

export function composerModeToRuntime(mode: ComposerMode | string | undefined): RuntimeType | undefined {
  if (!mode || mode === 'auto') return undefined
  return COMPOSER_MODE_TO_RUNTIME[mode as Exclude<ComposerMode, 'auto'>]
}

const RUNTIME_TYPES: ReadonlySet<string> = new Set<string>([
  'conversational', 'agentic', 'swarm', 'coding', 'research',
])

/**
 * Resolve a raw string to a runtime TYPE (not a composer mode).
 *
 * `channel_settings.pinned_runtime` stores runtime names — the column is
 * validated against the runtime set, so it must be read with this function.
 * Reading it with `composerModeToRuntime` was a real defect: the stored value
 * 'swarm' is not a composer mode, so every Swarm pin silently resolved to
 * undefined and the channel fell back to Auto.
 */
export function runtimeTypeFromString(value: string | null | undefined): RuntimeType | undefined {
  if (!value) return undefined
  const raw = value.trim().toLowerCase()
  return RUNTIME_TYPES.has(raw) ? (raw as RuntimeType) : undefined
}

export interface IRuntime {
  type: RuntimeType
  execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult>
}

// D2 (CrowdOS §26): spec name is RuntimePacket. ContextPacket is the current
// shape; the alias keeps both names compiling. interpreter_output landed with
// the Interpreter; remaining §26 fields (visible_capabilities, state_updates,
// artifacts) land with their features (capability filter, artifacts) — not here.
export type RuntimePacket = ContextPacket;

export interface IProviderAdapter {
  provider: string
  call(
    config: ModelModuleConfig,
    request: LLMRequest,
    onChunk?: (chunk: { content: string; thoughts?: string; isThoughts?: boolean }) => void,
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse>
  supportsStreaming: boolean
  supportsTools: boolean
}

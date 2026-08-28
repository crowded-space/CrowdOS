export interface ToolContext {
  agentId: string
  channelId: string
  workspaceId: string
  actorId?: string
  authorityLevel?: number
  abortSignal?: AbortSignal
}

export interface CrowdToolResult<T = unknown> {
  success: boolean
  output?: T
  error?: string
  artifacts?: Array<{ type: string; path: string; mimeType?: string }>
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface CrowdToolMetadata {
  permissions?: string[]
  capabilities?: string[]
  requiresApproval?: boolean
  timeoutMs?: number
  dangerLevel?: 'safe' | 'moderate' | 'dangerous'
  /** PERF-8 static read/write classifier: omit to fall back to the name-based map (unknown → 'write'). */
  effectClass?: 'read' | 'write' | 'side-effect'
  authLevelRequired?: number
}

export interface CrowdTool<TInput = unknown, TResult = unknown> {
  /** Tool ID (e.g. 'read_file', future: 'filesystem.read') */
  id: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
  metadata?: CrowdToolMetadata
  execute(input: TInput, context: ToolContext): Promise<CrowdToolResult<TResult>>
}

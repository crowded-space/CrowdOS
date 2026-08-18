export type ToolSourceType = 'native' | 'dynamic' | 'mcp' | 'openapi';
export type ToolDangerLevel = 'safe' | 'moderate' | 'dangerous';

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, {
    type?: string;
    description?: string;
    enum?: string[];
    items?: Record<string, unknown> | any;
    default?: unknown;
    [k: string]: any;
  } | any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolExecutionContext {
  agentId: string;
  channelId: string;
  workspaceId: string;
  actorId?: string;
  authorityLevel?: number;
  abortSignal?: AbortSignal;
  logger?: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  artifacts?: Array<{
    type: string;
    path: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }>;
  durationMs?: number;
}

export interface ToolDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  sourceType: ToolSourceType;
  sourceId?: string;
  parameters: ToolParameterSchema;
  dangerLevel: ToolDangerLevel;
  authLevelRequired?: number;
  timeoutMs?: number;
  handler: (args: Record<string, any>, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

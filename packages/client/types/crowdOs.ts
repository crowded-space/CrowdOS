import { AgentStatus as SharedAgentStatus } from '@community-agent/shared';

export type AgentStatus = SharedAgentStatus;
export type AgentLevel = 0 | 1 | 2 | 3; // L0 (Omniscient), L1 (Admin), L2 (Coordinator), L3 (Worker)

export interface Agent {
  id: string;
  name: string;
  species: string; // e.g. "Raven", "Crow", "Falcon" (species instead of role)
  level: AgentLevel;
  status: AgentStatus;
  avatar?: string;
  instructionModuleId?: string;
  modelModuleId?: string;
  toolkitModuleId?: string;
  constraintsModuleId?: string;
  capabilitiesModuleId?: string;
  parentId?: string; // Links to parent agent for hierarchy
  roleId?: string;
  isOmniscient?: boolean;
  createdAt: string;
  lastActive: string;
  description?: string;
}

export type MessageType = 'human' | 'agent' | 'system' | 'governance' | 'delegation' | 'tool_execution';

export interface DelegationInfo {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  task: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  tokens: number;
  cost: number;
}

export interface ToolExecution {
  name: string;
  input: string; // JSON string input
  output?: string; // Result output
  durationMs: number;
  status: 'success' | 'error' | 'working';
}

export interface Attachment {
  id: string;
  name: string;
  type: string; // e.g., 'image/png' or 'application/pdf'
  url: string;  // Data URL or object URL
  size?: number;
}

export type AgentTurnStepType = 'reasoning' | 'tool_call' | 'response';

export interface AgentTurnStep {
  id: string;
  type: AgentTurnStepType;
  content?: string;
  toolExecution?: ToolExecution;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  timestamp?: string;
}

export type AgentTurnStatus = 'idle' | 'thinking' | 'executing' | 'completed' | 'failed' | 'cancelled';

export interface Message {
  id: string;
  type: MessageType;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  channelId: string;
  timestamp: string;
  mentions?: string[];
  delegationInfo?: DelegationInfo;
  toolExecution?: ToolExecution;
  turnSteps?: AgentTurnStep[];
  turnStatus?: AgentTurnStatus;
  metadata?: Record<string, any>;
  attachments?: Attachment[];
}

export type ProviderType = 'google' | 'openai' | 'anthropic' | 'ollama' | 'custom';

export interface ModelProfile {
  id: string;
  label: string;
  provider: ProviderType;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  apiKeyConfigured: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  unreadCount: number;
  hasMention: boolean;
  categoryId?: string | null;
  type?: 'standard' | 'pair_private' | 'archived';
  position?: number;
  archivedAt?: string | null;
}

export interface Category {
  id: string;
  name: string;
  collapsed: boolean;
  channels: Channel[];
  position?: number;
}

export interface WorkspaceDatabaseInfo {
  configured: boolean;
  host?: string;
  database?: string;
  port?: number | null;
  pendingSync?: boolean;
  schemaReady?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string; // Emoji or simple initial
  dbUrl?: string;
  database?: WorkspaceDatabaseInfo;
  _database?: {
    configured: boolean;
    host?: string;
    database?: string;
    port?: number | null;
    pendingSync?: boolean;
    schemaReady?: boolean;
  };
  screenLockEnabled?: boolean;
  categories: Category[];
  channels?: Channel[]; // top-level channels outside categories
  createdAt: string;
  updatedAt?: string;
}

// Cognitive Assembly Modules (Target modular architecture)
export interface InstructionModule {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  persona?: string;
  rules?: string[];
  sandboxPath?: string;
  modelProfileId?: string;
  createdAt: string;
}

export interface ModelModule {
  id: string;
  name: string;
  description?: string;
  modelProfileId: string; // Links to a ModelProfile
  provider?: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number; // 0.0 - 2.0
  maxTokens?: number;
  topP?: number;
  maxRecentMessages?: number;
  enableCompression?: boolean;
  compressionThreshold?: number;
  createdAt: string;
}

export interface ToolkitModule {
  id: string;
  name: string;
  description?: string;
  enabledToolIds: string[];
  sandboxConfig?: Record<string, any>;
  createdAt: string;
}

export interface ConstraintsModule {
  id: string;
  name: string;
  rules: string[];
  disallowedActions: string[];
  createdAt: string;
}

export interface CapabilitiesModule {
  id: string;
  name: string;
  skills: string[];
  functionSchemas: Record<string, any>[];
  createdAt: string;
}

export interface RuntimeOverride {
  id: string;
  agentId: string;
  type: 'instruction' | 'model' | 'toolkit';
  patch: Record<string, any>;
  reason?: string;
  expiresAt?: string;
  active: boolean;
  createdAt: string;
}

export interface Tool {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  usageCount: number;
}

export type ComposerMode = 'auto' | 'chat' | 'agentic' | 'coding' | 'research'

export const COMPOSER_MODE_META: Record<ComposerMode, { label: string; hint: string }> = {
  auto: { label: 'Auto', hint: 'Router decides' },
  chat: { label: 'Chat', hint: 'Fast conversational' },
  agentic: { label: 'Agentic', hint: 'Tool-capable agent' },
  coding: { label: 'Coding', hint: 'Code + Pi tools' },
  research: { label: 'Research', hint: 'Deep research' },
};

export interface Role {
  id: string;
  name: string;
  color: string; // oklch expression or hex
  permissions: string[];
}

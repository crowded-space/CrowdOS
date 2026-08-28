export interface AgentStatusEventPayload {
  agentId: string;
  status: string;
}

export interface MessageStreamEventPayload {
  channelId: string;
  agentId: string;
  chunk: string;
  isThoughts?: boolean;
  streamed?: boolean;
}

export interface AgentThinkingEventPayload {
  agentId: string;
  channelId: string;
}

export interface AgentSpawnedEventPayload {
  agentId: string;
  name: string;
  species: string;
  level: number;
  status: string;
  channelId: string;
  workspaceId?: string | null;
  timestamp: string;
  batchNum?: number;
  pairs?: string[];
}

export interface AgentDespawnedEventPayload {
  agentId: string;
}

export interface AgentPausedEventPayload {
  agentId: string;
  reason: string;
}

export interface IndexDegradedEventPayload {
  channelId: string;
  path: string;
  reason: string;
}

export interface StrikeInitiatedEventPayload {
  agentId: string;
  strikeCount: number;
  maxStrikes: number;
  reason: string;
  channelId: string;
  timestamp: string;
}

export interface RunStatusChangedEventPayload {
  runId: string;
  agentId: string;
  channelId: string;
  workspaceId?: string | null;
  runtimeType: string;
  status: string;
  from?: string;
  reason?: string | null;
  errorCode?: string | null;
}

export interface BudgetWarningEventPayload {
  profileId: string;
  usage: number;
  cap: number;
}

export interface BudgetExceededEventPayload {
  profileId: string;
  pausedAgents: string[];
}

export interface RunQueuedEventPayload {
  runId: string;
  channelId: string;
  agentId: string;
}

export interface RunCompensationsEventPayload {
  runId: string;
  entries: Array<{
    id: string;
    seq: number;
    toolName: string;
    targetPath: string;
    inverseOp: { op: string; path: string; priorHash?: string; priorContentRef?: string };
    createdAt: string;
  }>;
}

export interface ScheduledTriggeredEventPayload {
  id: string;
  channelId: string;
  task: string;
  cron?: string | null;
  triggeredAt: string;
}

export interface ApprovalRequestedEventPayload {
  runId: string;
  approvalId: string;
  tool: string;
  argsPreview: Record<string, unknown> | null;
  riskClass: string;
  scope?: string | null;
  requestedBy?: string;
  expiresAt?: string;
  channelId?: string;
  workspaceId?: string | null;
  autoApproved?: boolean;
}

export interface ApprovalDecidedEventPayload {
  runId: string;
  approvalId: string;
  tool: string;
  decision: "approved" | "denied" | "expired";
  decidedBy?: string | null;
  scope?: string | null;
  riskClass?: string;
  channelId?: string;
  autoApproved?: boolean;
}

export interface DelegationStartEventPayload {
  parentRunId: string;
  childRunId: string;
  depth: number;
  taskId?: string | null;
}

export interface DelegationCompletedEventPayload {
  parentRunId: string;
  childRunId: string;
  summary: string;
  artifactRef?: string | null;
}

export type Mode = 'auto' | 'conversational' | 'agentic' | 'coding' | 'research' | 'chat'
export type ComposerModePayload = Mode

export function isValidMode(mode: unknown): mode is Mode {
  return typeof mode === 'string' && ['auto', 'conversational', 'agentic', 'coding', 'research', 'chat'].includes(mode)
}

export interface UserMessageEventPayload {
  channelId: string;
  content: string;
  mentions: string[];
  mode?: Mode;
  runtimeMode?: Mode;
}

export interface ChannelMessagePayload {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorLevel: string | number;
  authorType: 'user' | 'agent' | 'system';
  content: string;
  mentions: unknown[];
  isInternalMonologue: boolean;
  sequenceNumber: number;
  timestamp: string | Date;
  metadata?: Record<string, unknown>;
  toolCalls?: unknown[];
}

export interface BrokerEventMap {
  "agent:status": AgentStatusEventPayload;
  "message:new": ChannelMessagePayload & { metadata?: Record<string, unknown>; toolCalls?: unknown[] };
  "message:stream": MessageStreamEventPayload;
  "agent:thinking": AgentThinkingEventPayload;
  "agent:spawned": AgentSpawnedEventPayload;
  "agent:despawned": AgentDespawnedEventPayload;
  "agent:paused": AgentPausedEventPayload;
  "agent:resumed": { agentId: string };
  "strike:initiated": StrikeInitiatedEventPayload;
  "runtime:snapshot": unknown;
  "sandbox:updated": { sandboxId: string; workspaceId: string; path: string; changeType: string; timestamp: string };
  "swarm:created": unknown;
  "swarm:updated": unknown;
  "swarm:terminated": unknown;
  "escalation:created": unknown;
  "budget:warning": BudgetWarningEventPayload;
  "budget:exceeded": BudgetExceededEventPayload;
  "workspace:sync": Record<string, never>;
  "tool:start": { callId?: string; agentId: string; channelId: string; toolName: string; input: unknown };
  "tool:complete": { callId?: string; agentId: string; channelId: string; toolName: string; output?: string; error?: string; success: boolean; durationMs?: number; structuredToolCall?: unknown };
  "run.status_changed": RunStatusChangedEventPayload;
  "run.queued": RunQueuedEventPayload;
  "run.compensations": RunCompensationsEventPayload;
  "index:degraded": IndexDegradedEventPayload;
  "scheduled:triggered": ScheduledTriggeredEventPayload;
  "approval.requested": ApprovalRequestedEventPayload;
  "approval.decided": ApprovalDecidedEventPayload;
  "delegation:start": DelegationStartEventPayload;
  "delegation:completed": DelegationCompletedEventPayload;
  "artifact.created": { runId: string | null; artifactId: string; artifactType?: string; channelId?: string; workspaceId?: string };
  "diff.created": { runId: string | null; artifactId: string; artifactType?: string; channelId?: string; workspaceId?: string };
  "artifact.updated": { runId: string | null; artifactId: string; artifactType?: string; channelId?: string; workspaceId?: string };
}

export type BrokerEventType = keyof BrokerEventMap;

export interface BrokerEvent<TType extends BrokerEventType = BrokerEventType> {
  eventId: string;
  seq?: number | null;
  type: TType;
  channelId?: string;
  payload: BrokerEventMap[TType];
  timestamp: Date;
}

export interface EventEnvelope<TType extends BrokerEventType = BrokerEventType> {
  eventId: string;
  seq?: number | null;
  timestamp: Date;
  type: TType;
  payload: BrokerEventMap[TType];
}

export type SocketServerToClientEvents = {
  [TType in BrokerEventType]: (payload: BrokerEventMap[TType] | EventEnvelope<TType>) => void;
};

export interface SocketClientToServerEvents {
  "user:message": (payload: UserMessageEventPayload) => void;
  "user:cancel": (payload: { channelId: string; agentId?: string }) => void;
  "run:resume": (payload: { runId: string }) => void;
  "run:compensations:list": (payload: { runId: string }) => void;
  "run:compensation:undo": (payload: { runId: string; compId: string }) => void;
  "approval:decide": (payload: { approvalId: string; decision: "approved" | "denied"; scope?: string | null }) => void;
  "approval:list": (payload: { runId: string }) => void;
}

export const RuntimeEvents = {
  AGENT_SPAWNED: "agent:spawned",
  AGENT_DESPAWNED: "agent:despawned",
  AGENT_PAUSED: "agent:paused",
  AGENT_RESUMED: "agent:resumed",
  AGENT_LIFECYCLE: "agent:lifecycle",
  AGENT_STATUS: "agent:status",
  AGENT_THINKING: "agent:thinking",
  MESSAGE_NEW: "message:new",
  MESSAGE_STREAM: "message:stream",
  TOOL_START: "tool:start",
  TOOL_COMPLETE: "tool:complete",
  RUNTIME_STATE: "runtime:state",
  RUNTIME_SNAPSHOT: "runtime:snapshot",
  RUNTIME_OVERRIDE: "runtime:override",
  WORKSPACE_PATCHED: "workspace:patched",
  WORKSPACE_SNAPSHOT: "workspace:snapshot",
  WORKSPACE_SYNC: "workspace:sync",
  SANDBOX_UPDATED: "sandbox:updated",
  SANDBOX_STREAM: "sandbox:stream",
  SANDBOX_PROCESS: "sandbox:process",
  SWARM_CREATED: "swarm:created",
  SWARM_UPDATED: "swarm:updated",
  SWARM_TERMINATED: "swarm:terminated",
  ESCALATION_CREATED: "escalation:created",
  ESCALATION_UPDATED: "escalation:updated",
  ESCALATION_RESOLVED: "escalation:resolved",
  BUDGET_WARNING: "budget:warning",
  BUDGET_EXCEEDED: "budget:exceeded",
  RUN_STATUS_CHANGED: "run.status_changed",
  RUN_QUEUED: "run.queued",
  RUN_COMPENSATIONS: "run.compensations",
  INDEX_DEGRADED: "index:degraded",
  SCHEDULED_TRIGGERED: "scheduled:triggered",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_DECIDED: "approval.decided",
  DELEGATION_START: "delegation:start",
  DELEGATION_COMPLETED: "delegation:completed",
  ARTIFACT_CREATED: "artifact.created",
  DIFF_CREATED: "diff.created",
  ARTIFACT_UPDATED: "artifact.updated",
} as const;

export type RuntimeEventType = typeof RuntimeEvents[keyof typeof RuntimeEvents];

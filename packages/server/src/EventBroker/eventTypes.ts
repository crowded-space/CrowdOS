import type { ChannelMessage, StructuredToolCall } from "../Messages/messageGate.js";
import type { RuntimeStatus } from "../types/runtime.types.js";
import type { RunStatus } from "../Runs/runsGate.js";

export interface AgentStatusEventPayload {
  agentId: string;
  status: RuntimeStatus;
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
  pairs: string[];
  channelId: string;
  batchNum: number;
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
  status: RunStatus;
  /** RUN-1: previous status (equals `status` only for no-op emissions). */
  from?: RunStatus;
  /** RUN-1: machine-audited writers supply why the transition happened. */
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

export interface BrokerEventMap {
  "agent:status": AgentStatusEventPayload;
  "message:new": ChannelMessage & { metadata?: Record<string, unknown>; toolCalls?: StructuredToolCall[] };
  "message:stream": MessageStreamEventPayload;
  "agent:thinking": AgentThinkingEventPayload;
  "agent:spawned": AgentSpawnedEventPayload;
  "agent:despawned": AgentDespawnedEventPayload;
  "agent:paused": AgentPausedEventPayload;
  "agent:resumed": { agentId: string };
  "strike:initiated": StrikeInitiatedEventPayload;
  "runtime:snapshot": any;
  "sandbox:updated": { sandboxId: string; workspaceId: string; path: string; changeType: string; timestamp: string };
  "swarm:created": any;
  "swarm:updated": any;
  "swarm:terminated": any;
  "escalation:created": any;
  "budget:warning": BudgetWarningEventPayload;
  "budget:exceeded": BudgetExceededEventPayload;
  "workspace:sync": Record<string, never>;
  "tool:start": { callId?: string; agentId: string; channelId: string; toolName: string; input: any };
  "tool:complete": { callId?: string; agentId: string; channelId: string; toolName: string; output?: string; error?: string; success: boolean; durationMs?: number; structuredToolCall?: StructuredToolCall };
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

/**
 * Wire format for socket emission (EVT-0): correlation fields live at the top
 * level alongside the original payload so consumers reading `event.payload`
 * keep working. Live events carry seq=null until persisted; replayed durable
 * rows always carry their allocated seq.
 */
export interface EventEnvelope<TType extends BrokerEventType = BrokerEventType> {
  eventId: string;
  seq?: number | null;
  timestamp: Date;
  type: TType;
  payload: BrokerEventMap[TType];
}

export type SocketServerToClientEvents = {
  [TType in BrokerEventType]: (payload: BrokerEventMap[TType]) => void;
};

export interface SocketClientToServerEvents {
  "user:message": (payload: UserMessageEventPayload) => void;
  /** Cancel in-flight runs for a channel (optionally a specific agent). */
  "user:cancel": (payload: { channelId: string; agentId?: string }) => void;
  "run:resume": (payload: { runId: string }) => void;
  "run:compensations:list": (payload: { runId: string }) => void;
  "run:compensation:undo": (payload: { runId: string; compId: string }) => void;
  "approval:decide": (payload: { approvalId: string; decision: "approved" | "denied"; scope?: string | null }) => void;
  "approval:list": (payload: { runId: string }) => void;
}

import type { ChannelMessage } from "../Messages/messageGate.js";
import type { RuntimeOverride, RuntimeState, RuntimeStatus } from "../types/runtime.types.js";

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

export interface RuntimeOverrideEventPayload {
  agentId: string;
  override: RuntimeOverride;
}

export interface RuntimeStateEventPayload {
  agentId: string;
  state: RuntimeState;
}

export interface EscalationEventPayload {
  channelId: string;
  fromAgent: string;
  reason: string;
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

export interface UserMessageEventPayload {
  channelId: string;
  content: string;
  mentions: string[];
}

export interface BrokerEventMap {
  "agent:status": AgentStatusEventPayload;
  "message:new": ChannelMessage;
  "message:stream": MessageStreamEventPayload;
  "agent:thinking": AgentThinkingEventPayload;
  "agent:spawned": AgentSpawnedEventPayload;
  "agent:despawned": AgentDespawnedEventPayload;
  "agent:paused": AgentPausedEventPayload;
  "agent:resumed": { agentId: string };
  "agent:lifecycle": { agentId: string; action: string; workspaceId: string; timestamp: string };
  "runtime:override": RuntimeOverrideEventPayload;
  "runtime:state": RuntimeStateEventPayload;
  "runtime:snapshot": any;
  "workspace:patched": { workspaceId: string; patch: any; timestamp: string };
  "workspace:snapshot": any;
  "sandbox:updated": { sandboxId: string; workspaceId: string; path: string; changeType: string; timestamp: string };
  "sandbox:stream": { channelId: string; agentId: string; chunk: string };
  "sandbox:process": any;
  "swarm:created": any;
  "swarm:updated": any;
  "swarm:terminated": any;
  "escalation:created": any;
  "escalation:updated": any;
  "escalation:resolved": any;
  escalation: EscalationEventPayload;
  "budget:warning": BudgetWarningEventPayload;
  "budget:exceeded": BudgetExceededEventPayload;
  "workspace:sync": Record<string, never>;
  "tool:start": { callId?: string; agentId: string; channelId: string; toolName: string; input: any };
  "tool:complete": { callId?: string; agentId: string; channelId: string; toolName: string; output?: string; error?: string; success: boolean; durationMs?: number };
}

export type BrokerEventType = keyof BrokerEventMap;

export interface BrokerEvent<TType extends BrokerEventType = BrokerEventType> {
  eventId: string;
  type: TType;
  channelId?: string;
  payload: BrokerEventMap[TType];
  timestamp: Date;
}

export type SocketServerToClientEvents = {
  [TType in BrokerEventType]: (payload: BrokerEventMap[TType]) => void;
};

export interface SocketClientToServerEvents {
  "user:message": (payload: UserMessageEventPayload) => void;
}

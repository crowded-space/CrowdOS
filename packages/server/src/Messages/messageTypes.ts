import type { AuthorityLevel } from "../Agents/agentGate.js";
import type { MentionMetadata } from "../types/mention.types.js";

export type MessageAuthorType = "user" | "agent" | "system";

export interface ChannelMessage {
  id: string;
  workspaceId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorLevel: AuthorityLevel | "stakeholder";
  authorType: MessageAuthorType;
  content: string;
  mentions: MentionMetadata[];
  isInternalMonologue: boolean;
  sequenceNumber: number;
  timestamp: Date;
}

export interface StructuredToolCall {
  name: string;
  args: unknown;
  result: string | unknown;
  truncated: boolean;
  durationMs: number | null;
  callId: string | null;
}

export interface MessagePageCursor {
  before: {
    timestamp: string;
    seq: number;
  };
}

export interface ChannelMessagesPage {
  messages: any[];
  cursor: MessagePageCursor | null;
}

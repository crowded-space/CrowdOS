import type { AuthorityLevel } from "../agents/agent-gate.js";
import type { MentionMetadata } from "../types/mention.types.js";

export type MessageAuthorType = "user" | "agent" | "system";

export interface ChannelMessage {
  id: string;
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

/** THR-015: raw thread message page — rows keep `threadId` (the merged channel page drops it). */
export interface ThreadMessagesPage {
  messages: any[];
  nextCursor: string | null;
}

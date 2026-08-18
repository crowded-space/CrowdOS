import type { AuthorityLevel } from "../Agents/agentGate.js";
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

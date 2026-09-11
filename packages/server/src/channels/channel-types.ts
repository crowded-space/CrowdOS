export interface Category {
  id: string;
  name: string;
  ownedByAgentId?: string;
  createdBy: string;
  embeddingProfileId?: string;
  position: number;
  createdAt: Date;
}

export type ChannelType = "standard" | "pair_private" | "archived";

export interface Channel {
  id: string;
  categoryId: string | null;
  name: string;
  type: ChannelType;
  createdBy: string;
  position: number;
  createdAt: Date;
  archivedAt?: Date;
}

export interface ChannelIndex {
  channelId: string;
  channelPath: string;
  topicSummary: string;
  lastIndexedAt: Date;
  messageCountSinceIndex: number;
}

export interface CompressedSummary {
  id: string;
  channelId: string;
  summary: string;
  coversUpToSeq: number;
  createdAt: Date;
}

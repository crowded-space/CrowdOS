export type MentionType = "agent" | "role";
export type MentionFlag = "critical" | "attention_boost" | "escalation" | null;

export interface MentionMetadata {
  type: MentionType;
  targetId: string;
  targetName: string;
  position: number;
  flag: MentionFlag;
}

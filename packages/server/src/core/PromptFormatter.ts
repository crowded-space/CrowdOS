import type { MentionMetadata } from "../types/mention.types.js";

interface MessageInput {
  authorName: string;
  authorLevel: string | number;
  content: string;
  mentions?: MentionMetadata[];
  isInternalMonologue?: boolean;
}

/**
 * Format a channel message into XML-like tagging for LLMs.
 * Handles escaping/injecting headers and attributes like level, mentions, and attention flags.
 */
export function formatMessageForAgent(
  message: MessageInput,
  recipientAgentName?: string
): string {
  const fromAttr = escapeXmlAttr(message.authorName);
  const levelAttr = escapeXmlAttr(String(message.authorLevel));
  
  let mentionAttr = "";
  let flagAttr = "";
  
  if (recipientAgentName && message.mentions) {
    // Check if the recipient agent is mentioned in the mentions array
    const targetMention = message.mentions.find(
      (m) =>
        m.targetName.toLowerCase() === recipientAgentName.toLowerCase() ||
        m.targetName.toLowerCase() === `@${recipientAgentName.toLowerCase()}`
    );
    
    if (targetMention) {
      mentionAttr = ` mention="${escapeXmlAttr(targetMention.targetName)}"`;
      if (targetMention.flag) {
        flagAttr = ` flag="${escapeXmlAttr(targetMention.flag)}"`;
      }
    }
  }
  
  return `<message from="${fromAttr}" level="${levelAttr}"${mentionAttr}${flagAttr}>\n${message.content}\n</message>`;
}

/**
 * Basic XML attribute escaping helper.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

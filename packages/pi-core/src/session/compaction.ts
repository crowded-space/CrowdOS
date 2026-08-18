import type { PiMessage } from '../ai/types.js';

export interface CompactionConfig {
  maxContextTokens: number;
  reserveTokens: number;
  keepRecentMessages: number;
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

export function estimateMessagesTokens(messages: PiMessage[]): number {
  return messages.reduce((acc, msg) => {
    let count = estimateTokenCount(msg.content);
    if (msg.thoughts) count += estimateTokenCount(msg.thoughts);
    if (msg.toolCalls) count += estimateTokenCount(JSON.stringify(msg.toolCalls));
    return acc + count;
  }, 0);
}

export function compactHistory(
  messages: PiMessage[],
  config: CompactionConfig = { maxContextTokens: 32000, reserveTokens: 4000, keepRecentMessages: 20 }
): { messages: PiMessage[]; compacted: boolean } {
  const currentTokens = estimateMessagesTokens(messages);
  const targetThreshold = config.maxContextTokens - config.reserveTokens;

  if (currentTokens <= targetThreshold || messages.length <= config.keepRecentMessages) {
    return { messages, compacted: false };
  }

  // Preserve system messages at the beginning
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  if (nonSystemMessages.length <= config.keepRecentMessages) {
    return { messages, compacted: false };
  }

  // Keep the most recent N messages
  const recentMessages = nonSystemMessages.slice(-config.keepRecentMessages);
  const olderMessages = nonSystemMessages.slice(0, -config.keepRecentMessages);

  // Generate a compact summary marker
  const summaryTurn: PiMessage = {
    role: 'user',
    content: `[SYSTEM NOTICE: Context window compacted. ${olderMessages.length} earlier conversational turns summarized to stay within context budget.]`,
  };

  return {
    messages: [...systemMessages, summaryTurn, ...recentMessages],
    compacted: true,
  };
}

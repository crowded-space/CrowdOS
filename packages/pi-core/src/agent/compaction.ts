import type { PiMessage } from '../ai/types.js';

export interface CompactionConfig {
  maxContextTokens: number;
  reserveTokens: number;
  keepRecentMessages: number;
}

export type SummarizeFn = (dropped: PiMessage[]) => Promise<string>;

export function isHonestCompactionEnabled(): boolean {
  const raw = typeof process !== 'undefined' ? (process.env.HONEST_COMPACTION ?? process.env.COMPACTION_SUMMARIZE) : undefined;
  if (raw == null || raw === '') return true;
  const v = String(raw).trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

export function formatHonestMarker(count: number, startSeq?: number, endSeq?: number): string {
  if (startSeq != null && endSeq != null) return `[truncated ${count} turns: seq ${startSeq}..${endSeq}]`;
  return `[truncated ${count} turns]`;
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

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  if (nonSystemMessages.length <= config.keepRecentMessages) {
    return { messages, compacted: false };
  }

  const recentMessages = nonSystemMessages.slice(-config.keepRecentMessages);
  const olderMessages = nonSystemMessages.slice(0, -config.keepRecentMessages);

  const marker: PiMessage = {
    role: 'user',
    content: formatHonestMarker(olderMessages.length),
  };

  return {
    messages: [...systemMessages, marker, ...recentMessages],
    compacted: true,
  };
}

export async function compactHistoryAsync(
  messages: PiMessage[],
  config: CompactionConfig = { maxContextTokens: 32000, reserveTokens: 4000, keepRecentMessages: 20 },
  options: { summarizeFn?: SummarizeFn; startSeq?: number; endSeq?: number } = {}
): Promise<{ messages: PiMessage[]; compacted: boolean; summary?: string; droppedCount: number }> {
  const currentTokens = estimateMessagesTokens(messages);
  const targetThreshold = config.maxContextTokens - config.reserveTokens;

  if (currentTokens <= targetThreshold || messages.length <= config.keepRecentMessages) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  if (nonSystemMessages.length <= config.keepRecentMessages) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const recentMessages = nonSystemMessages.slice(-config.keepRecentMessages);
  const olderMessages = nonSystemMessages.slice(0, -config.keepRecentMessages);
  const droppedCount = olderMessages.length;

  if (!isHonestCompactionEnabled()) {
    const marker: PiMessage = {
      role: 'user',
      content: formatHonestMarker(droppedCount, options.startSeq, options.endSeq),
    };
    return { messages: [...systemMessages, marker, ...recentMessages], compacted: true, droppedCount };
  }

  if (options.summarizeFn) {
    try {
      const summary = await options.summarizeFn(olderMessages);
      const trimmed = (summary || '').trim();
      if (trimmed) {
        const summaryTurn: PiMessage = {
          role: 'user',
          content: `[COMPRESSED SUMMARY | ${droppedCount} turns]\n${trimmed}`,
        };
        return { messages: [...systemMessages, summaryTurn, ...recentMessages], compacted: true, summary: trimmed, droppedCount };
      }
    } catch {}
  }

  const fallback: PiMessage = {
    role: 'user',
    content: formatHonestMarker(droppedCount, options.startSeq, options.endSeq),
  };
  return { messages: [...systemMessages, fallback, ...recentMessages], compacted: true, droppedCount };
}



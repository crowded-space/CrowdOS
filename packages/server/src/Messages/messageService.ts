import { eq } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { messages } from "../db/schema.js";
import { stripToolCalls, parseToolCalls } from "@community-agent/shared";

export async function getChannelMessages(channelId: string, includeMonologue: boolean) {
  const db = getDb();
  const list = await db.query.messages.findMany({
    where: eq(messages.channelId, channelId),
    orderBy: (table, { asc }) => [asc(table.sequenceNumber)],
  });

  const mergedList: any[] = [];
  const pendingToolCalls: Array<{
    agentId: string;
    toolCalls: Array<{ name: string; input: string }>;
  }> = [];

  for (const msg of list) {
    if (msg.isInternalMonologue) {
      if (msg.content.startsWith("🛠️ [Tool Result: ")) {
        const headerMatch = msg.content.match(/^🛠️ \[Tool Result: ([^\]]+)\]\n?([\s\S]*)$/);
        if (headerMatch) {
          const toolName = headerMatch[1].trim();
          const outcomeStr = headerMatch[2];

          const pendingIndex = pendingToolCalls.findIndex(
            p => p.agentId === msg.authorId && p.toolCalls.some(tc => tc.name === toolName)
          );

          let input = "";
          if (pendingIndex !== -1) {
            const pending = pendingToolCalls[pendingIndex];
            const tcIndex = pending.toolCalls.findIndex(tc => tc.name === toolName);
            if (tcIndex !== -1) {
              input = pending.toolCalls[tcIndex].input;
              pending.toolCalls.splice(tcIndex, 1);
              if (pending.toolCalls.length === 0) {
                pendingToolCalls.splice(pendingIndex, 1);
              }
            }
          }

          const isSuccess = !outcomeStr.startsWith("Error:");
          mergedList.push({
            id: `tool-${msg.id}`,
            type: 'tool_execution',
            authorId: msg.authorId,
            authorName: msg.authorName,
            authorLevel: msg.authorLevel,
            authorType: 'agent',
            content: '',
            channelId: msg.channelId,
            timestamp: msg.timestamp,
            sequenceNumber: msg.sequenceNumber,
            toolExecution: {
              name: toolName,
              input,
              output: outcomeStr,
              status: isSuccess ? 'success' : 'error',
              durationMs: 0
            }
          });
        }
      } else {
        const cleanThoughts = stripToolCalls(msg.content);
        if (cleanThoughts) {
          mergedList.push({
            id: msg.id,
            type: 'agent',
            authorId: msg.authorId,
            authorName: msg.authorName,
            authorLevel: msg.authorLevel,
            authorType: 'agent',
            content: '',
            channelId: msg.channelId,
            timestamp: msg.timestamp,
            sequenceNumber: msg.sequenceNumber,
            metadata: { monologue: cleanThoughts }
          });
        }

        const calls = parseToolCalls(msg.content);
        if (calls.length > 0) {
          pendingToolCalls.push({
            agentId: msg.authorId,
            toolCalls: calls
          });
        }
      }
    } else {
      // Normal message
      mergedList.push({
        id: msg.id,
        type: msg.authorType === 'user' ? 'human' : 'agent',
        authorId: msg.authorId,
        authorName: msg.authorName,
        authorLevel: msg.authorLevel,
        authorType: msg.authorType,
        content: msg.content,
        channelId: msg.channelId,
        timestamp: msg.timestamp,
        sequenceNumber: msg.sequenceNumber,
        mentions: msg.mentions || [],
        metadata: undefined
      });
    }
  }

  return mergedList;
}

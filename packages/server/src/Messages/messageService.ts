import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../Shared/config/database.js";
import { messages } from "../db/schema.js";
import { stripToolCalls, parseToolCalls } from "@community-agent/shared";
import type { StructuredToolCall, MessagePageCursor, ChannelMessagesPage } from "./messageTypes.js";

interface ToolExecutionCard {
  id: string;
  type: 'tool_execution';
  authorId: string;
  authorName: string;
  authorLevel: string;
  authorType: 'agent';
  content: string;
  channelId: string;
  timestamp: Date;
  sequenceNumber: number;
  toolExecution: {
    name: string;
    input: string;
    output: string;
    status: 'success' | 'error';
    durationMs: number;
  };
}

function buildToolCard(
  msg: typeof messages.$inferSelect,
  name: string,
  input: string,
  output: string,
  durationMs: number
): ToolExecutionCard {
  const isSuccess = !output.startsWith("Error:");
  return {
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
      name,
      input,
      output,
      status: isSuccess ? 'success' : 'error',
      durationMs
    }
  };
}

function parseStructuredToolCalls(value: unknown): StructuredToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StructuredToolCall =>
      !!entry && typeof entry === 'object' && typeof (entry as StructuredToolCall).name === 'string'
  );
}

function normalizeStructuredInput(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export class MalformedCursorError extends Error {
  code = "PAGINATION_BAD_CURSOR";
  constructor() {
    super("Invalid before cursor. Expected '<ISO timestamp>;<sequenceNumber>'.");
  }
}

export function parseBeforeCursor(raw: string | undefined | null): { timestamp: Date; seq: number } | undefined {
  if (!raw) return undefined;
  const sepIdx = raw.lastIndexOf(";");
  if (sepIdx === -1 || sepIdx === 0 || sepIdx === raw.length - 1) throw new MalformedCursorError();
  const ts = new Date(raw.slice(0, sepIdx));
  const seqPart = raw.slice(sepIdx + 1);
  if (!/^\d+$/.test(seqPart) || Number.isNaN(ts.getTime())) {
    throw new MalformedCursorError();
  }
  return { timestamp: ts, seq: Number(seqPart) };
}

function mergeMessageRows(list: Array<typeof messages.$inferSelect>, channelId: string): any[] {
  const mergedList: any[] = [];
  const pendingMonologues: Record<string, string> = {};
  const pendingToolCalls: Array<{
    agentId: string;
    toolCalls: Array<{ name: string; input: string }>;
  }> = [];

  for (const msg of list) {
    if (msg.isInternalMonologue) {
      const structured = parseStructuredToolCalls(msg.toolCalls);
      if (structured.length > 0) {
        for (const stc of structured) {
          mergedList.push(
            buildToolCard(
              msg,
              stc.name,
              normalizeStructuredInput(stc.args),
              typeof stc.result === 'string' ? stc.result : String(stc.result ?? ''),
              stc.durationMs ?? 0
            )
          );
        }
      } else if (msg.content.startsWith("🛠️ [Tool Result: ")) {
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

          mergedList.push(buildToolCard(msg, toolName, input, outcomeStr, 0));
        }
      } else {
        const cleanThoughts = stripToolCalls(msg.content);
        if (cleanThoughts) {
          pendingMonologues[msg.authorId] = cleanThoughts;
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
      // Normal / final response message
      const monologue = msg.authorType === 'agent' && pendingMonologues[msg.authorId]
        ? pendingMonologues[msg.authorId]
        : undefined;

      if (msg.authorType === 'agent') {
        delete pendingMonologues[msg.authorId];
      }

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
        metadata: monologue ? { monologue } : undefined
      });
    }
  }

  for (const [agentId, monologue] of Object.entries(pendingMonologues)) {
    if (monologue) {
      mergedList.push({
        id: 'monologue-' + agentId,
        type: 'agent',
        authorId: agentId,
        authorName: 'Agent Swarm',
        authorLevel: '3',
        authorType: 'agent',
        content: '*Reasoning completed*',
        channelId: channelId,
        timestamp: new Date().toISOString(),
        metadata: { monologue }
      });
    }
  }

  return mergedList;
}

export async function getChannelMessages(channelId: string, includeMonologue: boolean, opts: { workspaceId?: string } = {}) {
  const db = getDb();
  const list = await db.query.messages.findMany({
    where: opts.workspaceId
      ? and(eq(messages.channelId, channelId), eq(messages.workspaceId, opts.workspaceId))
      : eq(messages.channelId, channelId),
    orderBy: (table, { asc }) => [asc(table.sequenceNumber)],
  });

  return mergeMessageRows(list, channelId);
}

export async function getChannelMessagesPage(
  channelId: string,
  includeMonologue: boolean,
  opts: { limit?: number; before?: { timestamp: Date; seq: number }; workspaceId?: string } = {}
): Promise<ChannelMessagesPage> {
  const db = getDb();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);

  const scopeFilter = opts.workspaceId ? eq(messages.workspaceId, opts.workspaceId) : undefined;
  const channelFilter = eq(messages.channelId, channelId);
  const keysetFilter = opts.before
    ? and(
        channelFilter,
        ...(scopeFilter ? [scopeFilter] : []),
        sql`(${messages.timestamp}, ${messages.sequenceNumber}) < (${opts.before.timestamp.toISOString()}::timestamptz, ${opts.before.seq})`
      )
    : scopeFilter
      ? and(channelFilter, scopeFilter)
      : channelFilter;

  const rows = await db.query.messages.findMany({
    where: keysetFilter,
    orderBy: (table, { desc }) => [desc(table.timestamp), desc(table.sequenceNumber)],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  if (pageRows.length === 0) {
    return { messages: [], cursor: null };
  }

  // Merge pairing runs chronologically; the page is fetched newest-first.
  const chronological = [...pageRows].reverse();
  const mergedList = mergeMessageRows(chronological, channelId);

  const oldestRow = pageRows[pageRows.length - 1];
  const cursor: MessagePageCursor | null = hasMore
    ? {
        before: {
          timestamp: oldestRow.timestamp.toISOString(),
          seq: oldestRow.sequenceNumber,
        },
      }
    : null;

  return { messages: mergedList.reverse(), cursor };
}

import { eq, and, sql } from "drizzle-orm";
import { getDb, withTransaction, runWithDb } from "../shared/config/database.js";
import { messages } from "../db/schema.js";
import { stripToolCalls, parseToolCalls } from "@crowdspace/shared";
import { allocateSequence } from "../shared/core/sequence-number.js";
import { allocateThreadSequence } from "../shared/core/thread-sequence.js";
import { monotonicUlid } from "../shared/core/ulid.js";
import type { StructuredToolCall, MessagePageCursor, ChannelMessagesPage, MessageAuthorType } from "./message-types.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

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

const TOOL_RESULT_RE = /^🛠️ \[Tool Result: ([^\]]+)\]\n?([\s\S]*)$/;

function mergeMessageRows(list: Array<typeof messages.$inferSelect>, channelId: string): any[] {
  const mergedList: any[] = [];
  const pendingMonologues: Record<string, string> = {};
  const pendingToolCalls = new Map<string, Map<string, string[]>>();

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
        const headerMatch = TOOL_RESULT_RE.exec(msg.content);
        if (headerMatch) {
          const toolName = headerMatch[1].trim();
          const outcomeStr = headerMatch[2];
          let input = "";
          const byTool = pendingToolCalls.get(msg.authorId);
          const queue = byTool?.get(toolName);
          if (queue && queue.length > 0 && byTool) {
            input = queue.shift() ?? "";
            if (queue.length === 0) byTool.delete(toolName);
            if (byTool.size === 0) pendingToolCalls.delete(msg.authorId);
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
          let byTool = pendingToolCalls.get(msg.authorId);
          if (!byTool) pendingToolCalls.set(msg.authorId, (byTool = new Map()));
          for (const tc of calls) {
            const queue = byTool.get(tc.name);
            if (queue) queue.push(tc.input);
            else byTool.set(tc.name, [tc.input]);
          }
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

/** @deprecated Legacy getter — delegates to getChannelMessagesPage with limit 50. Use getChannelMessagesPage instead. */
export async function getChannelMessages(channelId: string, includeMonologue: boolean) {
  const page = await getChannelMessagesPage(channelId, includeMonologue, { limit: 50 });
  return page.messages;
}

export async function getChannelMessagesPage(
  channelId: string,
  includeMonologue: boolean,
  opts: { limit?: number; before?: { timestamp: Date; seq: number }; db?: any } = {}
): Promise<ChannelMessagesPage> {
  const db = opts.db || getDb();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);

  const keysetFilter = opts.before
    ? and(
        eq(messages.channelId, channelId),
        sql`(${messages.timestamp}, ${messages.sequenceNumber}) < (${opts.before.timestamp.toISOString()}::timestamptz, ${opts.before.seq})`
      )
    : eq(messages.channelId, channelId);

  const rows = await db.query.messages.findMany({
    where: keysetFilter,
    orderBy: (table: any, { desc }: any) => [desc(table.timestamp), desc(table.sequenceNumber)],
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

export interface AppendMessageInput {
  channelId: string;
  authorId: string;
  authorName: string;
  authorLevel: string | number;
  authorType: MessageAuthorType;
  content: string;
  mentions?: unknown[];
  metadata?: Record<string, unknown>;
  toolCalls?: StructuredToolCall[];
  isInternalMonologue?: boolean;
  threadId?: string | null;
  workspaceId?: string | null;
  id?: string;
}

export interface AppendMessageOpts {
  broker?: EventBroker;
  db?: any;
  tx?: any;
}

/** Single owner write path for `messages`: sequence reserve + insert commit atomically, then `message:new`. */
export async function appendMessage(input: AppendMessageInput, opts: AppendMessageOpts = {}): Promise<typeof messages.$inferSelect> {
  const msgId = input.id ?? monotonicUlid();
  const timestamp = new Date();
  const write = async (tx: any) => {
    const sequenceNumber = input.threadId
      ? await allocateThreadSequence(input.threadId, 1, tx)
      : await allocateSequence(input.channelId, 1, tx);
    const row = {
      id: msgId,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      workspaceId: input.workspaceId ?? null,
      authorId: input.authorId,
      authorName: input.authorName,
      authorLevel: String(input.authorLevel),
      authorType: input.authorType,
      content: input.content,
      mentions: (input.mentions ?? []) as any,
      metadata: input.metadata as any,
      toolCalls: input.toolCalls as any,
      isInternalMonologue: input.isInternalMonologue ?? false,
      sequenceNumber,
      timestamp,
    };
    await tx.insert(messages).values(row);
    return { ...row, authorLevel: input.authorLevel } as unknown as typeof messages.$inferSelect;
  };

  let msg: typeof messages.$inferSelect;
  if (opts.tx) {
    msg = await write(opts.tx);
  } else if (opts.db) {
    msg = await runWithDb(opts.db, () => withTransaction(write));
  } else {
    msg = await withTransaction(write);
  }

  opts.broker?.emit("message:new", msg as never, { channelId: input.channelId } as never);
  return msg;
}

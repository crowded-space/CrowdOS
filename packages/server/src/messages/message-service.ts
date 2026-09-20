import { eq, and, sql } from "drizzle-orm";
import {
  getDb,
  withTransaction,
  runWithDb,
  resolveTier,
  withStoreFallback,
  isConnectionError,
  noteDbFailure,
  noteDbSuccess,
} from "../shared/config/database.js";
import { channelGate } from "../channels/channel-gate.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { messages } from "../db/schema.js";
import { stripToolCalls, parseToolCalls } from "@crowdspace/shared";
import { allocateSequence } from "../shared/core/sequence-number.js";
import { allocateThreadSequence } from "../shared/core/thread-sequence.js";
import { monotonicUlid } from "../shared/core/ulid.js";
import { localAllocateSequence, localAppendMessage, localFloorSequence, localListRawMessages } from "./message-local-store.js";
import { appendOutbox } from "../shared/core/outbox.js";
import type { StructuredToolCall, MessagePageCursor, ChannelMessagesPage, MessageAuthorType } from "./message-types.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

// Owning-workspace lookup for tier decisions (workspaceId is immutable after
// channel create, so a bounded memo is safe; worst case one extra tier flip).
// ponytail: +1 indexed read per first-seen channel per process.
const channelWorkspaceCache = new Map<string, string | null>();

async function workspaceOfChannel(channelId: string): Promise<string | null> {
  const hit = channelWorkspaceCache.get(channelId);
  if (hit !== undefined) return hit;
  const ch = await channelGate.get(channelId).catch(() => null);
  const ws = ch?.workspaceId ?? null;
  if (channelWorkspaceCache.size > 5000) channelWorkspaceCache.clear();
  channelWorkspaceCache.set(channelId, ws);
  return ws;
}

// §17 migration bridge: (channel|thread) keys whose local counter has already
// been floored against the PG replica head in this process. Bounded; the set
// only grows once per channel per process and a fresh process re-floors, which
// is idempotent (the floor only ever raises the counter).
const seqFloored = new Set<string>();

/**
 * Floor a local sequence counter to the replica head so the local-first path
 * cannot reissue a seq the PG replica already holds.
 *
 * Runs at most once per key per process, only when the local counter is still
 * at zero (i.e. this process has not written locally yet), and never throws:
 * if the replica is unreachable the local tier simply proceeds — the outbox
 * replay is idempotent (insert-ignore by id) so a collision cannot lose a row.
 */
async function floorLocalSequenceFromReplica(seqKey: string, input: AppendMessageInput): Promise<void> {
  const current = await localAllocateSequence(seqKey, 0);
  if (current > 0) return;
  try {
    const head = input.threadId
      ? await getDb().select({ max: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` }).from(messages).where(eq(messages.threadId, input.threadId))
      : await getDb().select({ max: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` }).from(messages).where(eq(messages.channelId, input.channelId));
    const max = Number((head[0] as any)?.max ?? 0);
    if (max > 0) await localFloorSequence(seqKey, max);
  } catch {
    // Replica unreachable: local numbering starts fresh. Replay is idempotent.
  }
}

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

/** Raw newest-first rows for context middlewares (owning-workspace tier). */
export async function listRecentMessages(channelId: string, limit: number, dbOverride?: any): Promise<any[]> {
  if (dbOverride) {
    return dbOverride.query.messages.findMany({
      where: eq(messages.channelId, channelId),
      orderBy: (table: any, { desc }: any) => [desc(table.timestamp)],
      limit,
    });
  }
  const ctx = await tierContextFor(await workspaceOfChannel(channelId));
  return withStoreFallback(
    ctx,
    async () => {
      const db = getDb();
      return db.query.messages.findMany({
        where: eq(messages.channelId, channelId),
        orderBy: (table: any, { desc }: any) => [desc(table.timestamp)],
        limit,
      });
    },
    () => localListRawMessages(channelId, { limit }),
  );
}

export async function getChannelMessagesPage(
  channelId: string,
  opts: { limit?: number; before?: { timestamp: Date; seq: number }; db?: any } = {}
): Promise<ChannelMessagesPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);

  const fetchPg = async (db: any) => {
    const keysetFilter = opts.before
      ? and(
          eq(messages.channelId, channelId),
          sql`(${messages.timestamp}, ${messages.sequenceNumber}) < (${opts.before.timestamp.toISOString()}::timestamptz, ${opts.before.seq})`
        )
      : eq(messages.channelId, channelId);
    return db.query.messages.findMany({
      where: keysetFilter,
      orderBy: (table: any, { desc }: any) => [desc(table.timestamp), desc(table.sequenceNumber)],
      limit: limit + 1,
    });
  };

  // Explicit handle pins PG exactly (tests/seeds/backfill replay).
  if (opts.db) return assemblePage(await fetchPg(opts.db), limit, channelId);

  const ctx = await tierContextFor(await workspaceOfChannel(channelId));
  const rows = await withStoreFallback(
    ctx,
    async () => fetchPg(getDb()),
    () => localListRawMessages(channelId, { limit: limit + 1, before: opts.before }),
  );
  return assemblePage(rows, limit, channelId);
}

function assemblePage(
  rows: Array<typeof messages.$inferSelect>,
  limit: number,
  channelId: string,
): ChannelMessagesPage {
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

/**
 * Single owner write path for `messages` (§17 local-first).
 *
 * Order: local sequence reserve + local append (THE COMMIT POINT), then
 * `message:new`, then a best-effort PG replica insert that adopts the same
 * seq and repairs the PG counter upward. The PG leg can fail without failing
 * the write — local is truth, so replica lag is queued on the outbox for
 * replay rather than surfaced as a caller-visible error.
 *
 * The explicit `opts.tx` / `opts.db` path below is the deliberate exception:
 * a caller holding a transaction is doing a PG-side operation (tests, seeds,
 * backfill replay) and pins PG exactly.
 */
export async function appendMessage(input: AppendMessageInput, opts: AppendMessageOpts = {}): Promise<typeof messages.$inferSelect> {
  const msgId = input.id ?? monotonicUlid();
  const timestamp = new Date();
  const baseRow = {
    id: msgId,
    channelId: input.channelId,
    threadId: input.threadId ?? null,
    authorId: input.authorId,
    authorName: input.authorName,
    authorLevel: String(input.authorLevel),
    authorType: input.authorType,
    content: input.content,
    mentions: (input.mentions ?? []) as any,
    metadata: input.metadata as any,
    toolCalls: input.toolCalls as any,
    isInternalMonologue: input.isInternalMonologue ?? false,
    timestamp,
  };

  const writeLocal = async (sequenceNumber: number, workspaceId: string | null) =>
    localAppendMessage({
      ...baseRow,
      workspaceId,
      mentions: (input.mentions ?? []) as unknown[],
      metadata: (input.metadata ?? null) as Record<string, unknown> | null,
      toolCalls: (input.toolCalls ?? null) as unknown[] | null,
      sequenceNumber,
      timestamp: timestamp.toISOString(),
    });

  const queueForBackfill = async (sequenceNumber: number, workspaceId: string | null) => {
    await appendOutbox({
      workspaceId,
      entity: "message",
      op: "upsert",
      rowId: msgId,
      row: { ...baseRow, workspaceId, sequenceNumber, timestamp: timestamp.toISOString() },
    });
  };

  // Explicit handle/tx pins PG exactly (tests/seeds/backfill replay).
  if (opts.tx || opts.db) {
    const write = async (tx: any) => {
      const sequenceNumber = input.threadId
        ? await allocateThreadSequence(input.threadId, 1, tx)
        : await allocateSequence(input.channelId, 1, tx);
      const row = { ...baseRow, workspaceId: input.workspaceId ?? null, sequenceNumber };
      await tx.insert(messages).values(row);
      return { ...row, authorLevel: input.authorLevel } as unknown as typeof messages.$inferSelect;
    };
    const msg = opts.tx ? await write(opts.tx) : await runWithDb(opts.db, () => withTransaction(write));
    opts.broker?.emit("message:new", msg as never, { channelId: input.channelId } as never);
    return msg;
  }

  const workspaceId = input.workspaceId ?? (await workspaceOfChannel(input.channelId));
  const ctx = await tierContextFor(workspaceId);
  const { tier, url } = resolveTier(ctx);

  // ── §17 local-first: the local file is the COMMIT POINT. ──────────────
  // The truth tier owns sequence numbering, so the seq is allocated from the
  // local counter and the message lands locally before PG is touched. A local
  // throw propagates and the replica is never written.
  const seqKey = input.threadId ? `thread:${input.threadId}` : `ch:${input.channelId}`;
  // §17 migration bridge: a workspace whose history still lives only in PG has
  // an empty local log, so the local counter would restart at 1 and re-issue
  // seqs the replica already holds. Floor it to the replica head once per
  // (channel|thread) per process; afterwards the local counter is authoritative
  // and this costs nothing.
  if (!seqFloored.has(seqKey)) {
    await floorLocalSequenceFromReplica(seqKey, input);
    seqFloored.add(seqKey);
  }
  const sequenceNumber = await localAllocateSequence(seqKey, 1);
  await writeLocal(sequenceNumber, workspaceId);
  // The file row is normalized for JSON storage (absent => null); the value
  // returned to callers and emitted on `message:new` keeps the caller’s shape
  // (absent => undefined) so the broker contract is byte-for-byte unchanged.
  const msg = { ...baseRow, workspaceId, sequenceNumber, authorLevel: input.authorLevel } as unknown as typeof messages.$inferSelect;

  // No replica target, or the tier is paused: the local commit IS the write.
  if (!url || tier === "local") {
    if (url) await queueForBackfill(sequenceNumber, workspaceId);
    opts.broker?.emit("message:new", msg as never, { channelId: input.channelId } as never);
    return msg;
  }

  // Replica leg: adopt the SAME seq the local truth allocated, then repair the
  // PG counter upward so any PG-side allocation by another process can never
  // re-issue a seq the local log already used.
  try {
    await withTransaction(async (tx: any) => {
      const row = { ...baseRow, workspaceId, sequenceNumber };
      // Best-effort replica insert: a pre-existing row must not fail the run.
      await tx.insert(messages).values(row).onConflictDoNothing();
      await tx.execute(sql`
        insert into "channel_sequences" ("channel_id", "last_seq")
        values (${input.channelId}, ${sequenceNumber})
        on conflict ("channel_id") do update
          set "last_seq" = greatest("channel_sequences"."last_seq", ${sequenceNumber}),
              "updated_at" = now()
      `);
    });
    noteDbSuccess(url);
  } catch (err) {
    // Local already committed, so the message IS durable. A failed replica leg
    // is replica lag (queued for replay), never a caller-visible failure — the
    // previous PG-first order surfaced exactly this as a phantom error.
    if (isConnectionError(err)) noteDbFailure(url, err);
    await queueForBackfill(sequenceNumber, workspaceId).catch(() => {});
    console.warn(
      "[appendMessage] local message " + msgId + " (ch " + input.channelId + " seq " + sequenceNumber +
        ") committed; PG replica leg failed and was queued for replay: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  opts.broker?.emit("message:new", msg as never, { channelId: input.channelId } as never);
  return msg;
}

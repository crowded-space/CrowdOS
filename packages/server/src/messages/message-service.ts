import { eq, and, or, isNull, sql } from "drizzle-orm";
import {
  getDb,
  isSchemaMismatchError,
  withTransaction,
  runWithDb,
  resolveTier,
  withStoreFallback,
  isConnectionError,
  noteDbFailure,
  noteDbSuccess,
  dbForWorkspace,
  isDatabaseConfigured,
} from "../shared/config/database.js";
import { channelGate } from "../channels/channel-gate.js";
import { threadGate } from "../threads/thread-gate.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { messages } from "../db/schema.js";
import { stripToolCalls, parseToolCalls } from "@crowdspace/shared";
import { allocateSequence } from "../shared/core/sequence-number.js";
import { monotonicUlid } from "../shared/core/ulid.js";
import { localAllocateSequence, localAppendMessage, localDetachThreadReplies, localFloorSequence, localListRawMessages, localMessageExists } from "./message-local-store.js";
import { localAdjacentMessage } from "./message-local-store.js";
import { resolveWorkspaceIdForChannel, findWorkspaceIdForChannelLog } from "../shared/core/local-file.js";
import { MAX_PAGE_LIMIT, appendMessageInputSchema } from "./message-validators.js";
import { appendOutbox } from "../shared/core/outbox.js";
import type { StructuredToolCall, MessagePageCursor, ChannelMessagesPage, ThreadMessagesPage, MessageAuthorType } from "./message-types.js";
import type { EventBroker } from "../event-broker/event-broker-gate.js";

// Owning-workspace lookup for tier decisions (workspaceId is immutable after
// channel create, so a bounded memo of POSITIVE hits is safe; worst case one
// extra tier flip). MSG-011: null results are deliberately NOT cached — the
// old negative cache pinned a channel that did not resolve on first lookup
// (created later, or a transient gate error) to "no workspace" until process
// restart, filing its messages into the default scope.
// ponytail: +1 indexed read per first-seen channel per process.
const channelWorkspaceCache = new Map<string, string>();

export async function workspaceOfChannel(channelId: string): Promise<string | null> {
  const hit = channelWorkspaceCache.get(channelId);
  if (hit !== undefined) return hit;
  const ch = await channelGate.get(channelId).catch(() => null);
  let ws = ch?.workspaceId ?? null;
  if (!ws) {
    // MSG-011 fallback: the channel row may be unreadable (dead DB, index
    // reset) while its local log still exists. The log file pins the owning
    // scope, so resolve through it before giving up — and never cache the
    // miss (the channel may be created a moment later).
    ws =
      (await findWorkspaceIdForChannelLog("messages", channelId).catch(() => null)) ??
      (await resolveWorkspaceIdForChannel(channelId).catch(() => null));
  }
  if (ws) {
    if (channelWorkspaceCache.size > 5000) channelWorkspaceCache.clear();
    channelWorkspaceCache.set(channelId, ws);
  }
  return ws;
}

/**
 * MSG-002/MSG-010: one resolution of the workspace-record DB handle used by
 * the floor, the read gap-fill, and the replica write leg. Returns null when
 * the workspace has no record DB (local-only); callers then fall back to the
 * ambient pool.
 */
async function resolveWorkspaceHandle(workspaceId: string | null): Promise<any | null> {
  if (!workspaceId) return null;
  try {
    const { getWorkspaceDb } = await import("../workspace/workspace-gate.js");
    const resolved = await (getWorkspaceDb as (id: string) => Promise<any>)(workspaceId);
    return resolved?.db ?? null;
  } catch {
    return null;
  }
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
async function floorLocalSequenceFromReplica(
  seqKey: string,
  input: AppendMessageInput,
  workspaceId: string | null,
): Promise<void> {
  const current = await localAllocateSequence(seqKey, 0, false, workspaceId);
  if (current > 0) return;
  try {
    // MSG-002: resolve the workspace record DB when one exists, so the
    // floor reads the same handle the replica write leg uses. Ambient pool
    // stays as fallback (single-DB deployments).
    const handle = (await resolveWorkspaceHandle(workspaceId)) ?? getDb();
    const head = input.threadId
      ? await handle.select({ max: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` }).from(messages).where(eq(messages.threadId, input.threadId))
      : await handle.select({ max: sql<number>`coalesce(max(${messages.sequenceNumber}), 0)` }).from(messages).where(eq(messages.channelId, input.channelId));
    const max = Number((head[0] as any)?.max ?? 0);
    if (max > 0) await localFloorSequence(seqKey, max, workspaceId);
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
  durationMs: number,
  callIndex = 0,
  explicitStatus?: 'success' | 'error',
): ToolExecutionCard {
  // MSG-008: explicit ok/error fields win over prefix heuristics (the caller
  // resolves them from the structured result); legacy string results fall back
  // to prefix matching. Non-string results JSON-stringify instead of String()
  // ([object Object] loss).
  // MSG-016: id includes the call index so multiple calls per row are unique.
  const isSuccess = explicitStatus
    ? explicitStatus === 'success'
    : !output.startsWith("Error:") && !output.startsWith("error:");
  return {
    id: `tool-${msg.id}-${callIndex}`,
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

/**
 * MSG-008: resolve a structured tool-call result's status from explicit
 * ok/error fields. Returns undefined for legacy string results (the caller
 * then uses prefix matching). A result shaped `{ok:false}` or `{error:...}`
 * used to be JSON-stringified and marked success — the wrong badge.
 */
function structuredResultStatus(result: unknown): 'success' | 'error' | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  if (r.ok === true) return 'success';
  if (r.ok === false) return 'error';
  if (typeof r.error === 'string' && r.error.length > 0) return 'error';
  return undefined;
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
// MSG-013: the ceiling lives in message-validators so the route schema can
// derive from it; re-exported here for the gate and existing importers.
export { MAX_PAGE_LIMIT };

export class MalformedCursorError extends Error {
  code = "PAGINATION_BAD_CURSOR";
  constructor() {
    super("Invalid before cursor. Expected '<ISO timestamp>;<sequenceNumber>'.");
  }
}

/** MSG-012: typed rejection for appendMessage input that fails shape checks. */
export class InvalidMessageInputError extends Error {
  code = "MESSAGE_INVALID_INPUT";
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super("Invalid AppendMessageInput: " + issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.issues = issues;
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

/**
 * MSG-004: a row that participates in monologue→final pairing as a pure
 * thought carrier. Tool rows (structured or legacy emoji) are page-local
 * cards and must not seed pairing across a page boundary.
 */
function isPlainThoughtRow(row: any): boolean {
  return (
    !!row &&
    row.isInternalMonologue === true &&
    row.authorType === 'agent' &&
    parseStructuredToolCalls(row.toolCalls).length === 0 &&
    typeof row.content === 'string' &&
    !row.content.startsWith("🛠️ [Tool Result: ")
  );
}

function mergeMessageRows(
  list: Array<typeof messages.$inferSelect>,
  channelId: string,
  olderContext: any | null = null,
  newerContext: any | null = null,
): any[] {
  const mergedList: any[] = [];
  const pendingMonologues: Record<string, string> = {};
  const pendingToolCalls = new Map<string, Map<string, string[]>>();
  // MSG-004: authors whose pending monologue was seeded from the older-context
  // row. Context rows are never emitted, so an unconsumed seed must not produce
  // a synthetic card for a row that lives on another page. Only plain-thought
  // rows seed pairing; structured/emoji tool rows are page-local cards.
  const seededFromOlderContext = new Set<string>();
  if (isPlainThoughtRow(olderContext)) {
    const cleanThoughts = stripToolCalls(olderContext.content);
    if (cleanThoughts) {
      pendingMonologues[olderContext.authorId] = cleanThoughts;
      seededFromOlderContext.add(olderContext.authorId);
    }
  }

  for (const msg of list) {
    if (msg.isInternalMonologue) {
      const structured = parseStructuredToolCalls(msg.toolCalls);
      if (structured.length > 0) {
        // MSG-016: index keeps card ids unique within the row.
        for (let si = 0; si < structured.length; si++) {
          const stc = structured[si];
          mergedList.push(
            buildToolCard(
              msg,
              stc.name,
              normalizeStructuredInput(stc.args),
              // MSG-008: JSON-stringify preserves structure (was String()
              // producing [object Object]).
              typeof stc.result === 'string' ? stc.result : JSON.stringify(stc.result ?? null),
              stc.durationMs ?? 0,
              si,
              // MSG-008: explicit ok/error fields win over the prefix
              // heuristic; legacy string results (undefined here) keep it.
              structuredResultStatus(stc.result)
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
          // MSG-004: an in-page monologue supersedes a boundary seed; it must
          // not be dropped by the post-loop seed cleanup below.
          seededFromOlderContext.delete(msg.authorId);
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
        type: msg.authorType === 'user' ? 'human' : msg.authorType === 'system' ? 'system' : 'agent',
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

  // MSG-004: `newerContext` is the single row immediately NEWER than this
  // page, fetched only for pages that carry a `before` cursor. A monologue →
  // final pair split at the page boundary would otherwise leave the monologue
  // trailing on the older page (a synthetic "*Reasoning completed*" row) while
  // the final on the newer page renders bare. When the context row is a
  // non-monologue agent row it consumes its author's pending monologue —
  // forward-pairing parity with the loop above — so the boundary synthetic is
  // suppressed. The context row itself is never emitted (the newer page owns
  // it), and the head page fetches no context, so genuinely in-flight
  // monologues keep their synthetic row.
  if (newerContext && !newerContext.isInternalMonologue && newerContext.authorType === 'agent') {
    delete pendingMonologues[newerContext.authorId];
  }
  // MSG-004: drop an unconsumed boundary seed. The seed's row lives on another
  // page; a synthetic here would duplicate it. If its final sits beyond the
  // single adjacent context row, the attachment gap stays bounded to that
  // one-row overlap (see the domain spec Gaps).
  for (const agentId of seededFromOlderContext) {
    delete pendingMonologues[agentId];
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
  // MSG-014: non-finite limit (NaN from direct callers) propagated into
  // limit+1 math tier-dependently. Clamp like the page path.
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  limit = safeLimit;
  if (dbOverride) {
    return dbOverride.query.messages.findMany({
      where: eq(messages.channelId, channelId),
      orderBy: (table: any, { desc }: any) => [desc(table.timestamp)],
      limit,
    });
  }
  const workspaceId = await workspaceOfChannel(channelId);
  const ctx = await tierContextFor(workspaceId);
  return withStoreFallback(
    ctx,
    async () => {
      const db = (await resolveWorkspaceHandle(workspaceId)) ?? getDb();
      return db.query.messages.findMany({
        where: eq(messages.channelId, channelId),
        // MSG-006: seq tiebreak so same-timestamp rows order deterministically,
        // matching getChannelMessagesPage and the local path.
        orderBy: (table: any, { desc }: any) => [desc(table.timestamp), desc(table.sequenceNumber)],
        limit,
      });
    },
    async () => localListRawMessages(channelId, { limit, workspaceId }),
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

  // MSG-004: the single row immediately NEWER than the page head — the merge
  // context that resolves a monologue/final pair split at the page boundary
  // (see mergeMessageRows). Only pages fetched with a `before` cursor need it.
  const fetchNewerContextPg = async (db: any, ref: { timestamp: Date; seq: number }) => {
    const rows = await db.query.messages.findMany({
      where: and(
        eq(messages.channelId, channelId),
        sql`(${messages.timestamp}, ${messages.sequenceNumber}) > (${ref.timestamp.toISOString()}::timestamptz, ${ref.seq})`,
      ),
      orderBy: (table: any, { asc }: any) => [asc(table.timestamp), asc(table.sequenceNumber)],
      limit: 1,
    });
    return rows[0] ?? null;
  };
  const pageHead = (rows: any[]): { timestamp: Date; seq: number } | null =>
    rows.length > 0 ? { timestamp: rows[0].timestamp, seq: rows[0].sequenceNumber } : null;

  // Explicit handle pins PG exactly (tests/seeds/backfill replay) — unless
  // the handle points at an unprovisioned schema (stale BYODB: the table
  // itself is missing, 42P01/42703). Then the replica cannot answer and the
  // local tier serves the page instead of a raw 500. Genuine query defects
  // against a provisioned schema keep propagating.
  if (opts.db) {
    try {
      const pageRows = await fetchPg(opts.db);
      const head = opts.before ? pageHead(pageRows) : null;
      return assemblePage(pageRows, limit, channelId, head ? await fetchNewerContextPg(opts.db, head) : null);
    } catch (err) {
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[messages] tenant PG schema missing for channel ${channelId}; serving local page`);
    }
  }

  const workspaceId = await workspaceOfChannel(channelId);
  const ctx = await tierContextFor(workspaceId);
  const page = await withStoreFallback(
    ctx,
    async () => {
      // MSG-010: the read gap-fill must consult the SAME workspace-record DB
      // the write replica leg resolves (resolveWorkspaceHandle) — the ambient
      // pool is a different database in dual mode, so a first open after
      // migration saw an empty page while the replica held history. Ambient
      // stays as the fallback for single-DB deployments.
      const db = (await resolveWorkspaceHandle(workspaceId)) ?? getDb();
      const pageRows = await fetchPg(db);
      const head = opts.before ? pageHead(pageRows) : null;
      return { rows: pageRows, newerContext: head ? await fetchNewerContextPg(db, head) : null };
    },
    async () => {
      const pageRows = await localListRawMessages(channelId, {
        limit: limit + 1,
        before: opts.before,
        workspaceId,
      });
      const head = opts.before ? pageHead(pageRows) : null;
      return {
        rows: pageRows,
        newerContext: head ? await localAdjacentMessage(channelId, head, "newer", workspaceId) : null,
      };
    },
    { localIsEmpty: (value) => value.rows.length === 0 },
  );
  return assemblePage(page.rows, limit, channelId, page.newerContext);
}

function assemblePage(
  rows: Array<typeof messages.$inferSelect>,
  limit: number,
  channelId: string,
  newerContext: any | null = null,
): ChannelMessagesPage {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  if (pageRows.length === 0) {
    return { messages: [], cursor: null };
  }

  // MSG-004: the probe row (fetched but not shown) is the row immediately
  // OLDER than the page — pairing context for a monologue whose final opens
  // this page (see mergeMessageRows). Free: the limit+1 fetch already carries
  // it whenever more pages exist.
  const olderContext = hasMore ? rows[limit] ?? null : null;
  // Merge pairing runs chronologically; the page is fetched newest-first.
  const chronological = [...pageRows].reverse();
  const mergedList = mergeMessageRows(chronological, channelId, olderContext, newerContext);

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

/**
 * THR-015: thread-scoped RAW page — the Messages-owned port behind
 * `threadGate.getMessages` (Threads used to reach into message-local-store).
 * Rows keep `threadId`: the merged channel-page shape drops it, so this must
 * not reuse `getChannelMessagesPage`. The wire shape is identical to the read
 * Threads ran inline: `limit + 1` newest-first fetch, page sliced, returned
 * oldest-first, `nextCursor` from the oldest returned row when more remain.
 *
 * Tier selection mirrors `getChannelMessagesPage`: an explicit `db` handle
 * pins PG (tests/seeds and the THR-025 tenant-routed handle); without one the
 * owning channel log is the truth source, scoped by `workspaceId`.
 */
export async function getThreadMessagesPage(
  threadId: string,
  opts: {
    channelId: string;
    workspaceId?: string | null;
    limit?: number;
    before?: { timestamp: Date; seq: number } | null;
    db?: any;
  },
): Promise<ThreadMessagesPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);

  const assemble = (rows: any[]): ThreadMessagesPage => {
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const reversed = [...sliced].reverse();
    const nextCursor =
      hasMore && reversed.length > 0
        ? `${new Date(reversed[0].timestamp).toISOString()};${reversed[0].sequenceNumber}`
        : null;
    return { messages: reversed, nextCursor };
  };

  if (opts.db) {
    // Same fetch shape as getChannelMessagesPage.fetchPg (incl. the ISO-string
    // bind that avoids the raw-Date crash postgres.js had).
    const keysetFilter = opts.before
      ? and(
          eq(messages.threadId, threadId),
          sql`(${messages.timestamp}, ${messages.sequenceNumber}) < (${opts.before.timestamp.toISOString()}::timestamptz, ${opts.before.seq})`,
        )
      : eq(messages.threadId, threadId);
    const rows = await opts.db.query.messages.findMany({
      where: keysetFilter,
      orderBy: (table: any, { desc }: any) => [desc(table.timestamp), desc(table.sequenceNumber)],
      limit: limit + 1,
    });
    return assemble(rows);
  }

  // Local-first tier: filter the owning channel log to this thread before the
  // bounded probe so ordinary channel rows cannot consume the page or cursor.
  const rows = await localListRawMessages(opts.channelId, {
    limit: limit + 1,
    before: opts.before ?? undefined,
    workspaceId: opts.workspaceId ?? null,
    threadId,
  });
  return assemble(rows);
}

/**
 * Check for a raw message by its exact id, channel, and workspace. An explicit
 * database handle pins the lookup to that DB; otherwise the requested
 * workspace's raw JSONL file is checked first and its assigned DB fills misses
 * when the workspace tier is dual.
 */
async function messageExistsInDb(
  db: any,
  messageId: string,
  channelId: string,
  workspaceId: string,
  allowLegacyNullWorkspace: boolean,
): Promise<boolean> {
  const workspaceFilter = workspaceId === "default"
    ? or(isNull(messages.workspaceId), eq(messages.workspaceId, "default"))
    : allowLegacyNullWorkspace
      ? or(isNull(messages.workspaceId), eq(messages.workspaceId, workspaceId))
      : eq(messages.workspaceId, workspaceId);
  const match = await db.query.messages.findFirst({
    columns: { id: true },
    where: and(
      eq(messages.id, messageId),
      eq(messages.channelId, channelId),
      workspaceFilter,
    ),
  });
  return match !== undefined && match !== null;
}

export async function messageExistsInChannel(
  messageId: string,
  opts: { channelId: string; workspaceId?: string | null; db?: any },
): Promise<boolean> {
  const workspaceId = opts.workspaceId ?? null;
  if (opts.db) {
    // An opaque explicit handle has no ownership metadata, so keep its
    // workspace predicate exact (except for the documented default alias).
    return messageExistsInDb(opts.db, messageId, opts.channelId, workspaceId ?? "default", false);
  }

  if (workspaceId) {
    const localMatch = await localMessageExists(messageId, opts.channelId, workspaceId);
    if (localMatch) return true;
    const ctx = await tierContextFor(workspaceId);
    if (resolveTier(ctx).tier === "local") return false;

    // dbForWorkspace only returns the assigned workspace database. Its
    // physical tenant scope makes legacy rows with NULL workspace_id safe to
    // match, while the non-null predicate still excludes conflicting rows.
    const db = await dbForWorkspace(workspaceId);
    return messageExistsInDb(db, messageId, opts.channelId, workspaceId, true);
  }

  const localMatch = await localMessageExists(messageId, opts.channelId, null);
  if (localMatch || !isDatabaseConfigured()) return localMatch;
  return messageExistsInDb(getDb(), messageId, opts.channelId, "default", false);
}

/** Clear thread links for one channel's replies in the workspace-owned stores. */
export async function detachThreadReplies(
  threadId: string,
  opts: { channelId: string; workspaceId?: string | null; db?: any; allowLegacyNullWorkspace?: boolean },
): Promise<number> {
  if (opts.db) {
    const workspaceId = opts.workspaceId ?? "default";
    const workspaceFilter =
      workspaceId === "default" || opts.allowLegacyNullWorkspace
        ? or(isNull(messages.workspaceId), eq(messages.workspaceId, workspaceId))
        : eq(messages.workspaceId, workspaceId);
    const rows = await opts.db.update(messages)
      .set({ threadId: null })
      .where(and(eq(messages.threadId, threadId), eq(messages.channelId, opts.channelId), workspaceFilter))
      .returning({ id: messages.id });
    return rows.length;
  }

  const workspaceId = opts.workspaceId ?? null;
  const localCount = await localDetachThreadReplies(opts.channelId, threadId, workspaceId);
  if (!workspaceId) {
    if (!isDatabaseConfigured()) return localCount;
    const db = getDb();
    const rows = await db.update(messages)
      .set({ threadId: null })
      .where(and(eq(messages.threadId, threadId), eq(messages.channelId, opts.channelId), or(isNull(messages.workspaceId), eq(messages.workspaceId, "default"))))
      .returning({ id: messages.id });
    return rows.length;
  }

  const ctx = await tierContextFor(workspaceId);
  if (resolveTier(ctx).tier === "local") return localCount;
  const db = await dbForWorkspace(workspaceId);
  const rows = await db.update(messages)
    .set({ threadId: null })
    .where(and(
      eq(messages.threadId, threadId),
      eq(messages.channelId, opts.channelId),
      or(isNull(messages.workspaceId), eq(messages.workspaceId, workspaceId)),
    ))
    .returning({ id: messages.id });
  return rows.length;
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
 * MSG-001: the replica insert must target the primary key (id) ONLY. The old
 * untargeted onConflictDoNothing() swallowed ANY unique violation — including
 * a (channel|thread, sequence_number) collision — which silently dropped the
 * row from PG. With the thread-aware index (migration 0025) plus the local
 * counter floor, a seq collision is a real defect and must surface (caught by
 * the replica leg → outbox replay), not vanish. A same-id retry stays
 * idempotent. Exported for the in-domain regression test.
 */
export function buildReplicaInsert(tx: any, row: unknown) {
  return tx.insert(messages).values(row).onConflictDoNothing({ target: messages.id });
}

/**
 * Single owner write path for `messages` (§17 local-first).
 *
 * Order: local sequence reserve + local append (THE COMMIT POINT), then the
 * best-effort PG replica insert (dual tier only; adopts the same seq and
 * repairs the PG counter upward), then exactly one `message:new`. The PG leg
 * can fail without failing the write — local is truth, so replica lag is
 * queued on the outbox for replay rather than surfaced as a caller-visible
 * error.
 *
 * MSG-018 contract: `message:new` is a LOCAL-COMMIT event. It fires once on
 * every path (tx, local-only, dual) regardless of the replica outcome, so it
 * promises local durability plus queued replay — never PG replica visibility.
 * Consumers that read PG (e.g. the channel-index counter) must tolerate the
 * replica-lag window or read the local tier instead.
 *
 * The explicit `opts.tx` / `opts.db` path below is the deliberate exception:
 * a caller holding a transaction is doing a PG-side operation (tests, seeds,
 * backfill replay) and pins PG exactly.
 *
 * MSG-030 trust boundary (documented, not enforced here): this is an internal
 * domain API - authorId/authorName/authorType are persisted verbatim for any
 * in-process caller, so a caller CAN claim agent/system authorship. The trust
 * boundary is the TRANSPORT: the socket path derives authorId from the
 * verified socket identity (SEC-2), and REST/thread/runtime callers are
 * in-process domains. An optional in-domain actor check was considered and
 * deferred (see Messages.md Gaps).
 */
export async function appendMessage(input: AppendMessageInput, opts: AppendMessageOpts = {}): Promise<typeof messages.$inferSelect> {
  // MSG-012: shape validation at the domain boundary. Transports used to be
  // the only validators (and only the threads route did it): the socket path
  // destructured `content` without checking it, which wrote a local row with
  // no content key and produced a permanently failing PG replica entry
  // (NOT NULL violation). Validation is additive — callers that pass valid
  // input are unaffected; invalid input now fails BEFORE any write.
  const parsedInput = appendMessageInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new InvalidMessageInputError(
      parsedInput.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
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

  const writeLocal = async (workspaceId: string | null) =>
    localAppendMessage(
      async (sequenceNumber) => ({
        ...baseRow,
        workspaceId,
        mentions: (input.mentions ?? []) as unknown[],
        metadata: (input.metadata ?? null) as Record<string, unknown> | null,
        toolCalls: (input.toolCalls ?? null) as unknown[] | null,
        sequenceNumber,
        timestamp: timestamp.toISOString(),
      }),
      msgId,
      input.channelId,
      async () => {
        if (!seqFloored.has(seqKey)) {
          await floorLocalSequenceFromReplica(seqKey, input, workspaceId);
          seqFloored.add(seqKey);
        }
        return localAllocateSequence(seqKey, 1, false, workspaceId);
      },
      workspaceId,
    );

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
        ? await threadGate.allocateSequence(input.threadId, 1, tx)
        : await allocateSequence(input.channelId, 1, tx);
      const row = { ...baseRow, workspaceId: input.workspaceId ?? null, sequenceNumber };
      await tx.insert(messages).values(row);
      // MSG-003: return the persisted shape (baseRow already String()s
      // authorLevel); the old code echoed the caller value (number stayed
      // number) while storage normalized it.
      return { ...row } as unknown as typeof messages.$inferSelect;
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
  const localWrite = await writeLocal(workspaceId);
  const persistedRow = localWrite.row as typeof messages.$inferSelect;
  if (!localWrite.appended) return persistedRow;
  const sequenceNumber = persistedRow.sequenceNumber;
  // The file row is normalized for JSON storage (absent => null); the value
  // MSG-003: the returned row is the persisted shape (baseRow normalizes
  // authorLevel via String()); broker payload matches storage.
  const msg = persistedRow;

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
    // Tenant routing: a workspace-record database owns this channel's replica
    // rows. The ambient handle (global pool) is only the fallback for
    // workspaces with no record URL — writing the replica leg there would
    // strand the row in the wrong database with the outbox never triggered.
    let replicaDb: any = null;
    try {
      if (workspaceId) {
        const { getWorkspaceDb } = await import("../workspace/workspace-gate.js");
        replicaDb = (await getWorkspaceDb(workspaceId)).db ?? null;
      }
    } catch {
      // local-only workspace: fall back to the ambient handle below
    }
    const replicate = async (tx: any) => {
      const row = { ...baseRow, workspaceId, sequenceNumber };
      // MSG-001: targeted conflict clause (see buildReplicaInsert).
      await buildReplicaInsert(tx, row);
      await tx.execute(sql`
        insert into "channel_sequences" ("channel_id", "last_seq")
        values (${input.channelId}, ${sequenceNumber})
        on conflict ("channel_id") do update
          set "last_seq" = greatest("channel_sequences"."last_seq", ${sequenceNumber}),
              "updated_at" = now()
      `);
    };
    if (replicaDb) {
      await runWithDb(replicaDb, () => withTransaction(replicate));
    } else {
      await withTransaction(replicate);
    }
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

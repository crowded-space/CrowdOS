import { randomUUID } from "node:crypto";
import { eq, desc, sql, and } from "drizzle-orm";
import { getDb, isDatabaseConfigured, resolveTier, withTransaction, dbForWorkspace } from "../shared/config/database.js";
import { localDeleteThread, localFindThreadByParent, localGetThread, localListThreads, localUpsertThread } from "./thread-local-store.js";
import { threads, threadSequences, channels } from "../db/schema.js";
import type { CreateThreadInput, UpdateThreadInput, threadCallContext } from "./thread-types.js";
// THR-015: cross-domain reads go through the owning gates (AGENTS §2 gate-to-
// gate), never domain internals: channel reads via channelGate, thread message
// pages via the Messages-owned port messageGate.getThreadPage.
import { channelGate } from "../channels/channel-gate.js";
import { messageGate } from "../messages/message-gate.js";

// THR-004: drizzle 0.45 wraps driver errors (DrizzleQueryError) and puts the
// postgres error on `.cause`, so a top-level `err.code === "23505"` check never
// matched and the duplicate-parent race surfaced as a 500 instead of the
// winner thread. Walk the cause chain like isConnectionError does.
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// THR-025: explicit tenant context for non-HTTP callers. No ctx → the ambient
// ALS handle (request hook) or the global pool, exactly as before. workspaceId
// selects the effective Local/DB tier and resolves that workspace's handle;
// db pins the exact handle. A worker that passes its workspace never silently
// hits another database.
async function resolveThreadDb(ctx?: threadCallContext): Promise<any> {
  if (ctx?.db) return ctx.db;
  if (ctx?.workspaceId) return dbForWorkspace(ctx.workspaceId);
  return getDb();
}

async function isLocalThreadTier(ctx?: threadCallContext): Promise<boolean> {
  if (ctx?.db) return false;
  if (ctx?.workspaceId) {
    const { tierContextFor } = await import("../workspace/workspace-gate.js");
    return resolveTier(await tierContextFor(ctx.workspaceId)).tier === "local";
  }
  // Context-free legacy callers operate on the process-wide pool. Tenant
  // callers pass workspaceId so their tier is selected from workspace config.
  return !isDatabaseConfigured();
}

export async function createThread(input: CreateThreadInput, ctx?: threadCallContext) {
  // THR-003: local-first tier. When the effective workspace tier is local,
  // the file store is truth; channel scope follows the caller's workspace.
  if (await isLocalThreadTier(ctx)) {
    return createThreadLocal(input, ctx?.workspaceId);
  }
  const db = await resolveThreadDb(ctx);
  let rootId: string | null = input.parentMessageId ?? null;
  if (input.parentMessageId) {
    const [channel, parentExists, existingThread] = await Promise.all([
      db.query.channels.findFirst({ where: eq(channels.id, input.channelId) }),
      messageGate.existsInChannel(input.parentMessageId, {
        channelId: input.channelId,
        workspaceId: ctx?.workspaceId,
        db: ctx?.db,
      }),
      db.query.threads.findFirst({ where: eq(threads.parentMessageId, input.parentMessageId) }),
    ]);
    if (!channel) return { error: "channel_not_found" as const };
    if (!parentExists) return { error: "parent_not_found" as const };
    // If the parent already anchors a thread, that thread IS the thread for
    // this message: return it idempotently instead of minting a second thread
    // on the same parent (the previous code fetched it and voided it, so
    // duplicate threads per parent were possible).
    if (existingThread) {
      return { thread: existingThread, created: false as const };
    }
    rootId = input.parentMessageId;
  } else {
    const channel = await db.query.channels.findFirst({ where: eq(channels.id, input.channelId) });
    if (!channel) return { error: "channel_not_found" as const };
  }

  const id = `thr_${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const isEphemeral = input.isEphemeral ?? true;
  const ttlHours = input.ttlHours ?? (isEphemeral ? 24 : 0);
  const expiresAt = isEphemeral && ttlHours > 0 ? new Date(now.getTime() + ttlHours * 3600 * 1000) : null;

  // THR-004: a concurrent create on the same parent hits the partial
  // unique index (23505). Return the winner instead of 500.
  try {
    // THR-025: a pinned handle owns the transaction; the ambient path keeps
    // withTransaction (ALS-aware) unchanged.
    const runTx: (fn: (tx: any) => Promise<any>) => Promise<any> =
      ctx?.db || ctx?.workspaceId ? (fn) => (db as any).transaction(fn) : (withTransaction as any);
    const [row] = await runTx(async (tx) => {
      const inserted = await tx.insert(threads).values({
        id,
        channelId: input.channelId,
        parentMessageId: input.parentMessageId ?? null,
        rootMessageId: rootId,
        title: input.title ?? null,
        createdBy: input.createdBy,
        isEphemeral,
        status: "active",
        expiresAt,
        archivedAt: null,
        messageCount: 0,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning();

      // init thread sequence in the same txn so a crash never leaves a
      // thread row without its sequence (or vice versa).
      await tx.insert(threadSequences).values({ threadId: id, lastSeq: 0, updatedAt: now }).onConflictDoNothing();
      return inserted;
    });

    return { thread: row };
  } catch (err: any) {
    if (isUniqueViolation(err) && input.parentMessageId) {
      const winner = await (db as any).query.threads.findFirst({ where: eq(threads.parentMessageId, input.parentMessageId) });
      if (winner) return { thread: winner, created: false as const };
    }
    throw err;
  }
}

export async function getThread(id: string, ctx?: threadCallContext) {
  // THR-003: local tier lookup — GET serves the workspace file store whenever
  // its effective tier is local.
  if (await isLocalThreadTier(ctx)) {
    const found = await localThreadScope(id, ctx?.workspaceId);
    return found ? found.thread : undefined;
  }
  const db = await resolveThreadDb(ctx);
  return db.query.threads.findFirst({ where: eq(threads.id, id) });
}

export async function listThreads(channelId: string, opts?: { includeArchived?: boolean; limit?: number; cursor?: string | null }, ctx?: threadCallContext) {
  // THR-003: local tier serves channel-scoped JSON rows.
  if (await isLocalThreadTier(ctx)) {
    const scope = await localChannelScope(channelId, ctx?.workspaceId);
    if (ctx?.workspaceId && !scope) return [];
    const rows = await localListThreads(channelId, { includeArchived: opts?.includeArchived, workspaceId: scope });
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
    let filteredRows = rows;
    let offset = 0;
    if (opts?.cursor) {
      const raw = String(opts.cursor);
      if (raw.includes(";")) {
        const sep = raw.lastIndexOf(";");
        const timestamp = new Date(raw.slice(0, sep));
        const id = raw.slice(sep + 1);
        if (!isNaN(timestamp.getTime()) && id) {
          const cursorTime = timestamp.getTime();
          filteredRows = rows.filter((thread: any) => {
            const threadTime = new Date(thread.lastActivityAt).getTime();
            return threadTime < cursorTime || (threadTime === cursorTime && thread.id.localeCompare(id) < 0);
          });
        }
      } else {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
      }
    }
    return filteredRows.slice(offset, offset + limit);
  }
  const db = await resolveThreadDb(ctx);
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const base = opts?.includeArchived ? eq(threads.channelId, channelId) : and(eq(threads.channelId, channelId), eq(threads.status, "active"));
  // Keyset on (lastActivityAt,id) "ISO;id"; old numeric offset cursors still accepted via offset fallback.
  let offset: number | undefined;
  let where: any = base;
  if (opts?.cursor) {
    const raw = String(opts.cursor);
    if (raw.includes(";")) {
      const sep = raw.lastIndexOf(";");
      const ts = new Date(raw.slice(0, sep));
      const id = raw.slice(sep + 1);
      if (!isNaN(ts.getTime()) && id) {
        where = and(base as any, sql`(${threads.lastActivityAt}, ${threads.id}) < (${ts.toISOString()}::timestamptz, ${id})`) as any;
      }
    } else {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
    }
  }
  const rows = await db.query.threads.findMany({
    where: where as any,
    orderBy: [desc(threads.lastActivityAt), desc(threads.id)],
    limit,
    ...(offset ? { offset } : {}),
  });
  return rows;
}

export async function updateThread(id: string, input: UpdateThreadInput, ctx?: threadCallContext) {
  // THR-003: local tier update in the selected workspace scope.
  if (await isLocalThreadTier(ctx)) {
    return updateThreadLocal(id, input, ctx?.workspaceId);
  }
  const db = await resolveThreadDb(ctx);
  // THR-006: guarded transition map. Any-to-any moves allowed resurrection
  // (expired->active) and phantom expiry (active->expired with no
  // bookkeeping). THR-009: single conditional UPDATE so a concurrent
  // delete yields notFound instead of { thread: undefined }.
  const ALLOWED: Record<string, string[]> = {
    active: ["active", "archived", "expired"],
    archived: ["archived", "active"],
    expired: ["expired", "archived"],
  };
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updateData.title = input.title;
  if (input.status !== undefined) {
    const existing = await getThread(id, ctx);
    if (!existing) return { notFound: true as const };
    const from = (existing as unknown as Record<string, unknown>).status as string;
    if (!(ALLOWED[from] ?? []).includes(input.status)) {
      return { error: "illegal_transition", from, to: input.status } as const;
    }
    updateData.status = input.status;
    // THR-014: stamp leave-active time on every non-active move, never
    // overwrite the first stamp.
    if (input.status !== "active" && !(existing as unknown as Record<string, unknown>).archivedAt) {
      updateData.archivedAt = new Date();
    }
    if (input.status === "active") updateData.expiresAt = null;
  }
  const [updated] = await db.update(threads).set(updateData as any).where(eq(threads.id, id)).returning();
  if (!updated) return { notFound: true as const };
  return { thread: updated };
}

export async function archiveExpiredThreads(ctx?: threadCallContext): Promise<number> {
  // THR-003: local tier expiry sweep over the selected workspace, or all
  // searchable workspace scopes for a context-free local sweep.
  // Tier-select BEFORE resolving a database handle: a local-only workspace
  // has no tenant database, so resolving first throws NO_DATABASE instead
  // of reaching the file-store sweep. DB workspaces keep handle resolution.
  const localTier = await isLocalThreadTier(ctx).catch(() => false);
  if (localTier) {
    let count = 0;
    const mod = await import("../shared/core/local-file.js");
    const scopes = ctx?.workspaceId
      ? [ctx.workspaceId]
      : (mod as any).searchableWorkspaceScopes() as string[];
    const now = new Date();
    for (const scope of scopes) {
      await forEachLocalChannel(scope, async (c) => {
        const rows = await localListThreads(c.id, { includeArchived: true, workspaceId: scope });
        for (const t of rows) {
          if (t.status === "active" && t.expiresAt && new Date(t.expiresAt).getTime() < now.getTime()) {
            t.status = "expired";
            t.archivedAt = now;
            t.updatedAt = now;
            await localUpsertThread(t, scope);
            count++;
          }
        }
        return false;
      });
    }
    return count;
  }
  const db = await resolveThreadDb(ctx);
  const now = new Date();
  // ponytail: single UPDATE...WHERE (1 RTT, not 1+N)
  // NOTE: a raw Date inside the sql template is not serializable by
  // postgres.js ("The string argument must be of type string... Received an
  // instance of Date") — bind the ISO string with an explicit cast instead.
  const nowIso = now.toISOString();
  const rows = await db.update(threads).set({ status: "expired", archivedAt: now, updatedAt: now }).where(and(eq(threads.status, "active"), sql`${threads.expiresAt} IS NOT NULL AND ${threads.expiresAt} < ${nowIso}::timestamptz`)).returning({ id: threads.id });
  return rows.length;
}

export async function deleteThread(id: string, ctx?: threadCallContext) {
  // THR-003: local tier delete.
  if (await isLocalThreadTier(ctx)) {
    return deleteThreadLocal(id, ctx?.workspaceId);
  }
  const db = await resolveThreadDb(ctx);
  const existing = await getThread(id, ctx);
  if (!existing) return { notFound: true as const };
  // THR-005: SET NULL rule. Replies survive as channel messages (their
  // thread_id clears) instead of dangling on a deleted thread.
  await db.transaction(async (tx: any) => {
    await messageGate.detachThreadReplies(id, {
      channelId: existing.channelId,
      workspaceId: ctx?.workspaceId,
      db: tx,
      allowLegacyNullWorkspace: true,
    });
    await tx.delete(threads).where(eq(threads.id, id));
  });
  return { deleted: true as const };
}

export async function getThreadMessages(threadId: string, opts?: { limit?: number; before?: string | null }, ctx?: threadCallContext) {
  // THR-003: local tier reads thread replies from the messages local store —
  // THR-015: now through the Messages-owned gate port (raw rows, threadId kept).
  if (await isLocalThreadTier(ctx)) {
    const found = await localThreadScope(threadId, ctx?.workspaceId);
    if (!found) return { error: "thread_not_found" as const };
    let before: { timestamp: Date; seq: number } | undefined;
    if (opts?.before && opts.before.includes(";")) {
      const [ts, sq] = opts.before.split(";");
      const tsD = new Date(ts);
      const sqN = Number(sq);
      if (!isNaN(tsD.getTime()) && Number.isFinite(sqN)) before = { timestamp: tsD, seq: sqN };
    }
    return messageGate.getThreadPage(threadId, {
      channelId: found.thread.channelId,
      workspaceId: found.scope,
      limit: opts?.limit,
      before,
    });
  }
  const db = await resolveThreadDb(ctx);
  const thread = await getThread(threadId, ctx);
  if (!thread) return { error: "thread_not_found" as const };
  // Cursor is "timestamp;seq"
  let before: { timestamp: Date; seq: number } | undefined;
  if (opts?.before) {
    try {
      const [tsStr, seqStr] = opts.before.split(";");
      const tsD = new Date(tsStr);
      const sqN = Number(seqStr);
      if (!isNaN(tsD.getTime()) && Number.isFinite(sqN)) before = { timestamp: tsD, seq: sqN };
    } catch {}
  }
  // THR-015: the page query itself (cursor clause incl. the ISO-string bind
  // that avoids the raw-Date crash) lives in the Messages-owned port; Threads
  // passes the tenant handle and never re-implements the keyset page.
  return messageGate.getThreadPage(threadId, {
    channelId: thread.channelId,
    limit: opts?.limit,
    before,
    db,
  });
}

export async function incrementThreadMessageCount(threadId: string, ctx?: threadCallContext) {
  // THR-003: local tier bump.
  if (await isLocalThreadTier(ctx)) {
    const found = await localThreadScope(threadId, ctx?.workspaceId);
    if (found && found.thread.status === "active") {
      found.thread.messageCount = Number(found.thread.messageCount ?? 0) + 1;
      found.thread.lastActivityAt = new Date();
      found.thread.updatedAt = new Date();
      await localUpsertThread(found.thread, found.scope);
    }
    return;
  }
  const db = await resolveThreadDb(ctx);
  // Only an active thread's counters advance; archived/expired threads stay
  // frozen (posting is already refused at the route, this guards other callers).
  await db.update(threads).set({ messageCount: sql`${threads.messageCount} + 1`, lastActivityAt: new Date(), updatedAt: new Date() }).where(and(eq(threads.id, threadId), eq(threads.status, "active")));
}

// THR-003 local-tier: createThreadLocal + scope helper
const LOCAL_CHANNEL_PAGE_SIZE = 200;

function parseLocalChannelCursor(cursor: string): { position: number; id: string } | null {
  const separator = cursor.indexOf(":");
  if (separator <= 0) return null;
  const position = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  return Number.isFinite(position) && id ? { position, id } : null;
}

function localChannelCursor(channel: any): string | null {
  const position = Number(channel?.position ?? 0);
  const id = typeof channel?.id === "string" ? channel.id : "";
  return Number.isFinite(position) && id ? `${position}:${id}` : null;
}

function localChannelCursorAdvances(cursor: string | null, nextCursor: string): boolean {
  const next = parseLocalChannelCursor(nextCursor);
  if (!next) return false;
  if (!cursor) return true;
  const current = parseLocalChannelCursor(cursor);
  if (!current) return false;
  return next.position > current.position || (next.position === current.position && next.id > current.id);
}

async function forEachLocalChannel(
  workspaceId: string,
  visit: (channel: { id: string; position?: number }) => Promise<boolean>,
): Promise<boolean> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  while (true) {
    const rows = await channelGate.list({
      limit: LOCAL_CHANNEL_PAGE_SIZE,
      cursor,
      workspaceId,
    });
    if (rows.length === 0) return false;
    for (const channel of rows) {
      if (await visit(channel)) return true;
    }
    if (rows.length < LOCAL_CHANNEL_PAGE_SIZE) return false;

    const nextCursor = localChannelCursor(rows[rows.length - 1]);
    if (
      !nextCursor ||
      seenCursors.has(nextCursor) ||
      !localChannelCursorAdvances(cursor, nextCursor)
    ) {
      throw new Error(`Local channel pagination did not advance for workspace ${workspaceId}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function localChannelScope(channelId: string, workspaceId?: string | null): Promise<string | null> {
  const mod = await import("../shared/core/local-file.js");
  const scopes = workspaceId
    ? [workspaceId]
    : (mod as any).searchableWorkspaceScopes() as string[];
  for (const scope of scopes) {
    if (await forEachLocalChannel(scope, async (channel) => channel.id === channelId)) return scope;
  }
  return null;
}
async function createThreadLocal(input: CreateThreadInput, workspaceId?: string | null) {
  const scope = await localChannelScope(input.channelId, workspaceId);
  if (!scope) return { error: "channel_not_found" as const };
  if (input.parentMessageId) {
    const parentExists = await messageGate.existsInChannel(input.parentMessageId, {
      channelId: input.channelId,
      workspaceId: scope,
    });
    if (!parentExists) return { error: "parent_not_found" as const };
    const existing = await localFindThreadByParent(input.parentMessageId, input.channelId, scope);
    if (existing) return { thread: existing, created: false as const };
  }
  const now = new Date();
  const eph = input.isEphemeral ?? true;
  const ttl = input.ttlHours ?? (eph ? 24 : 0);
  const row = {
    id: `thr_${randomUUID().slice(0, 8)}`,
    channelId: input.channelId,
    parentMessageId: input.parentMessageId ?? null,
    rootMessageId: input.parentMessageId ?? null,
    title: input.title ?? null,
    createdBy: input.createdBy,
    isEphemeral: eph,
    status: "active",
    expiresAt: eph && ttl > 0 ? new Date(now.getTime() + ttl * 3600 * 1000) : null,
    archivedAt: null,
    messageCount: 0,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    workspaceId: scope,
  };
  const thread = await localUpsertThread(row, scope);
  return { thread };
}
async function localThreadScope(id: string, workspaceId?: string | null): Promise<{ thread: any; scope: string | null } | null> {
  const mod = await import("../shared/core/local-file.js");
  const scopes = workspaceId
    ? [workspaceId]
    : (mod as any).searchableWorkspaceScopes() as string[];
  for (const scope of scopes) {
    let found: { thread: any; scope: string } | null = null;
    await forEachLocalChannel(scope, async (channel) => {
      const thread = await localGetThread(id, channel.id, scope);
      if (!thread) return false;
      found = { thread, scope };
      return true;
    });
    if (found) return found;
  }
  return null;
}
async function updateThreadLocal(id: string, input: UpdateThreadInput, workspaceId?: string | null) {
  const found = await localThreadScope(id, workspaceId);
  if (!found) return { notFound: true as const };
  const ALLOWED: Record<string, string[]> = { active: ["active", "archived", "expired"], archived: ["archived", "active"], expired: ["expired", "archived"] };
  const t = found.thread;
  if (input.title !== undefined) t.title = input.title;
  if (input.status !== undefined) {
    if (!(ALLOWED[t.status] ?? []).includes(input.status)) return { error: "illegal_transition", from: t.status, to: input.status } as const;
    t.status = input.status;
    if (input.status !== "active" && !t.archivedAt) t.archivedAt = new Date();
    if (input.status === "active") t.expiresAt = null;
  }
  t.updatedAt = new Date();
  const thread = await localUpsertThread(t, found.scope);
  return { thread };
}
async function deleteThreadLocal(id: string, workspaceId?: string | null) {
  const found = await localThreadScope(id, workspaceId);
  if (!found) return { notFound: true as const };
  await messageGate.detachThreadReplies(id, {
    channelId: found.thread.channelId,
    workspaceId: found.scope,
  });
  await localDeleteThread(id, found.thread.channelId, found.scope);
  return { deleted: true as const };
}

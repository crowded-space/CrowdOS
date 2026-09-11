import { randomUUID } from "node:crypto";
import { eq, isNull, desc, sql, and } from "drizzle-orm";
import { getDb, withTransaction } from "../shared/config/database.js";
import { threads, messages, threadSequences, channels } from "../db/schema.js";
import { allocateThreadSequence } from "../shared/core/thread-sequence.js";
import type { CreateThreadInput, UpdateThreadInput } from "./thread-types.js";

export async function createThread(input: CreateThreadInput) {
  const db = getDb();
  let rootId: string | null = input.parentMessageId ?? null;
  if (input.parentMessageId) {
    const [channel, parent, existingThread] = await Promise.all([
      db.query.channels.findFirst({ where: eq(channels.id, input.channelId) }),
      db.query.messages.findFirst({ where: eq(messages.id, input.parentMessageId) }),
      db.query.threads.findFirst({ where: eq(threads.parentMessageId, input.parentMessageId) }),
    ]);
    if (!channel) return { error: "channel_not_found" as const };
    if (!parent || parent.channelId !== input.channelId) return { error: "parent_not_found" as const };
    // If parent already in a thread, inherit root
    void existingThread;
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

  const [row] = await withTransaction(async (tx) => {
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
}

export async function getThread(id: string) {
  const db = getDb();
  return db.query.threads.findFirst({ where: eq(threads.id, id) });
}

export async function listThreads(channelId: string, opts?: { includeArchived?: boolean; limit?: number; cursor?: string | null }) {
  const db = getDb();
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

export async function updateThread(id: string, input: UpdateThreadInput) {
  const db = getDb();
  const existing = await getThread(id);
  if (!existing) return { notFound: true as const };
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updateData.title = input.title;
  if (input.status !== undefined) {
    updateData.status = input.status;
    if (input.status === "archived") updateData.archivedAt = new Date();
  }
  const [updated] = await db.update(threads).set(updateData as any).where(eq(threads.id, id)).returning();
  return { thread: updated };
}

export async function archiveExpiredThreads(): Promise<number> {
  const db = getDb();
  const now = new Date();
  // ponytail: single UPDATE...WHERE (1 RTT, not 1+N)
  const rows = await db.update(threads).set({ status: "expired", archivedAt: now, updatedAt: now }).where(and(eq(threads.status, "active"), sql`${threads.expiresAt} IS NOT NULL AND ${threads.expiresAt} < ${now}`)).returning({ id: threads.id });
  return rows.length;
}

export async function deleteThread(id: string) {
  const db = getDb();
  const existing = await getThread(id);
  if (!existing) return { notFound: true as const };
  await db.delete(threads).where(eq(threads.id, id));
  return { deleted: true as const };
}

export async function getThreadMessages(threadId: string, opts?: { limit?: number; before?: string | null }) {
  const db = getDb();
  const thread = await getThread(threadId);
  if (!thread) return { error: "thread_not_found" as const };
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  // Cursor is "timestamp;seq"
  let beforeTs: Date | null = null;
  let beforeSeq: number | null = null;
  if (opts?.before) {
    try {
      const [tsStr, seqStr] = opts.before.split(";");
      beforeTs = new Date(tsStr);
      beforeSeq = Number(seqStr);
      if (isNaN(beforeSeq)) beforeSeq = null;
      if (isNaN(beforeTs.getTime())) beforeTs = null;
    } catch {}
  }
  let rows;
  if (beforeTs && beforeSeq !== null) {
    rows = await db.select().from(messages).where(and(eq(messages.threadId, threadId), sql`(${messages.timestamp}, ${messages.sequenceNumber}) < (${beforeTs}::timestamptz, ${beforeSeq})`)).orderBy(desc(messages.timestamp), desc(messages.sequenceNumber)).limit(limit + 1);
  } else {
    rows = await db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(desc(messages.timestamp), desc(messages.sequenceNumber)).limit(limit + 1);
  }
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const reversed = [...sliced].reverse();
  const nextCursor = hasMore && reversed.length > 0 ? `${reversed[0].timestamp.toISOString()};${reversed[0].sequenceNumber}` : null;
  return { messages: reversed, nextCursor };
}

export async function incrementThreadMessageCount(threadId: string) {
  const db = getDb();
  await db.update(threads).set({ messageCount: sql`${threads.messageCount} + 1`, lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(threads.id, threadId));
}

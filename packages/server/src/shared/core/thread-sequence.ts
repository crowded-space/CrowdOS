import { eq, sql } from "drizzle-orm";
import { getDb, isDatabaseConfigured } from "../config/database.js";
import { threadSequences, messages } from "../../db/schema.js";
import { localAllocateSequence } from "../../messages/message-local-store.js";

export async function allocateThreadSequence(threadId: string, count = 1, txOverride?: any): Promise<number> {
  // C3 local-first: file counter when no DATABASE_URL.
  if (!txOverride && !isDatabaseConfigured()) {
    return count === 1
      ? localAllocateSequence(`thread:${threadId}`, 1)
      : localAllocateSequence(`thread:${threadId}`, count, true);
  }
  const dbOrTx = txOverride ?? getDb();
  // Ensure row exists
  const existing = await dbOrTx.query.threadSequences.findFirst({ where: eq(threadSequences.threadId, threadId) });
  if (!existing) {
    const maxSeqRow = await dbOrTx.select({ max: sql<number>`COALESCE(MAX(${messages.sequenceNumber}),0)` }).from(messages).where(eq(messages.threadId, threadId));
    const base = (maxSeqRow[0] as any)?.max ?? 0;
    await dbOrTx.insert(threadSequences).values({ threadId, lastSeq: base, updatedAt: new Date() }).onConflictDoNothing();
  }
  const [row] = await dbOrTx
    .insert(threadSequences)
    .values({ threadId, lastSeq: count, updatedAt: new Date() })
    .onConflictDoUpdate({ target: threadSequences.threadId, set: { lastSeq: sql`${threadSequences.lastSeq} + ${count}`, updatedAt: new Date() } })
    .returning();
  // The returned lastSeq is the new max; we need start seq for batch
  // For simplicity if count=1, return lastSeq
  if (count === 1) return row.lastSeq;
  return row.lastSeq - count + 1;
}

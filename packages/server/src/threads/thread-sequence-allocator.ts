// THR-016: `thread_sequences` has ONE owner — Threads. The allocator moved
// here from shared/core (where the Messages append path reached across the
// domain boundary) and is exposed as `threadGate.allocateSequence`; Messages
// calls the gate with its transaction so the counter bump stays atomic with
// the message insert. Local-tier thread counters live in the Messages local
// store (sequences.json, `thread:<id>` key) and are allocated by the append
// path — this port is the PG `thread_sequences` allocator only.
import { eq, sql } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { threadSequences, messages } from "../db/schema.js";

/**
 * Atomically reserve `count` sequence numbers for a thread and return the
 * FIRST reserved value (`count = 1` returns the only value). The first
 * allocation for a thread without a counter row seeds the counter from
 * MAX(messages.sequence_number) — bootstrap and repair are now the same
 * domain's business. Pass `tx` to bind the reservation to the caller's
 * transaction: a rollback restores the counter.
 */
export async function allocateThreadSequence(threadId: string, count = 1, tx?: any): Promise<number> {
  const dbOrTx = tx ?? getDb();
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
  // The returned lastSeq is the new max; batch reservations return the start.
  if (count === 1) return row.lastSeq;
  return row.lastSeq - count + 1;
}

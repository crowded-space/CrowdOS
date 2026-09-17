import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { getDb, isDatabaseConfigured } from "../config/database.js";
import { messages } from "../../db/schema.js";
import { localAllocateSequence } from "../../messages/message-local-store.js";

/** Anything that can run raw SQL: the pool-backed db or a transaction client. */
export interface SequenceSqlClient {
  execute: (query: SQL) => Promise<unknown>;
}

/**
 * DB-2: atomically reserve `count` sequence numbers for a channel and return
 * the LAST reserved value. Backed by a dedicated channel_sequences row advanced
 * via INSERT ... ON CONFLICT DO UPDATE RETURNING — a single round trip that is
 * race-free under concurrency (no SELECT-MAX+1, no 23505, no gaps). The first
 * allocation for a legacy channel seeds the counter from MAX(messages.sequence_number)
 * so existing data keeps its numbering. Pass `client` to bind the reservation
 * to the caller's transaction: a rollback restores the counter, preventing
 * burned sequences.
 */
export async function allocateSequence(channelId: string, count: number = 1, client?: SequenceSqlClient): Promise<number> {
  // C3 local-first: file counter when no DATABASE_URL (bump-first, gaps OK, never dups).
  if (!client && !isDatabaseConfigured()) return localAllocateSequence(`ch:${channelId}`, count);
  const db = client ?? getDb();
  const rows = (await db.execute(sql`
    insert into "channel_sequences" ("channel_id", "last_seq")
    values (
      ${channelId},
      coalesce(
        (select max(${messages.sequenceNumber}) from ${messages} where ${messages.channelId} = ${channelId}),
        0
      ) + ${count}
    )
    on conflict ("channel_id") do update
      set "last_seq" = "channel_sequences"."last_seq" + ${count},
          "updated_at" = now()
    returning "last_seq"
  `)) as unknown as Array<{ last_seq: string | number }>;

  const row = rows[0];
  if (!row) {
    throw new Error(`allocateSequence(${channelId}, ${count}) returned no row`);
  }

  return Number(row.last_seq);
}

/** Backward-compatible shim over allocateSequence for existing importers. */
export async function getNextSequenceNumber(channelId: string): Promise<number> {
  return allocateSequence(channelId, 1);
}

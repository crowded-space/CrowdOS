import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allocateSequence } from "../shared/core/sequence-number.js";
import { monotonicUlid } from "../shared/core/ulid.js";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function conflict23505Count(results: Array<PromiseSettledResult<unknown>>): number {
  return results.filter(
    (r) =>
      r.status === "rejected" &&
      ((r.reason as { code?: string } | undefined)?.code === "23505"),
  ).length;
}

describe.skipIf(!DATABASE_URL)("DB-2 · channel_sequences atomic allocation (real dev DB)", () => {
  const channelA = `db2-concurrency-${randomUUID().slice(0, 8)}`;
  const channelB = `db2-concurrency-${randomUUID().slice(0, 8)}`;
  let client: ReturnType<typeof postgres> | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  let connectionError = "";

  beforeAll(async () => {
    client = postgres(DATABASE_URL, {
      prepare: false,
      max: 25,
      idle_timeout: 5,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      await client`select 1`;
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
      return;
    }
    db = drizzle(client);

    await db.execute(sql`
      create table if not exists "channel_sequences" (
        "channel_id" text primary key references "channels"("id") on delete cascade,
        "last_seq" bigint not null default 0,
        "updated_at" timestamp with time zone not null default now()
      )
    `);
    await db.execute(sql`delete from "channels" where "id" like 'db2-concurrency-%'`);
    for (const channelId of [channelA, channelB]) {
      await db.execute(sql`
        insert into "channels" ("id", "name", "type", "created_by", "position")
        values (${channelId}, ${channelId}, 'standard', 'db2-test', 0)
        on conflict ("id") do nothing
      `);
    }
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    try {
      if (db && !connectionError) {
        await db.execute(sql`delete from "channels" where "id" like 'db2-concurrency-%'`);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("allocates 20 parallel single-sequence requests as contiguous 1..20 with zero conflicts", async (ctx) => {
    if (!connectionError) expect(db).toBeTruthy();
    else {
      console.warn(`[DB-2] Skipping: DATABASE_URL unreachable — ${connectionError}`);
      ctx.skip();
      return;
    }
    const database = db!;

    const settled = (await Promise.allSettled(
      Array.from({ length: 20 }, () => allocateSequence(channelA, 1, database)),
    )) as Array<PromiseSettledResult<number>>;

    expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
    expect(conflict23505Count(settled)).toBe(0);

    const seqs = settled.map((r) => (r as PromiseFulfilledResult<number>).value).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const counterRows = (await database.execute(
      sql`select "last_seq" from "channel_sequences" where "channel_id" = ${channelA}`,
    )) as unknown as Array<{ last_seq: string }>;
    expect(Number(counterRows[0]?.last_seq)).toBe(20);
  }, 30_000);

  it("keeps 20 parallel persistMessage-equivalent transactions gap-free and id-monotonic", async (ctx) => {
    if (!connectionError) expect(db).toBeTruthy();
    else {
      console.warn(`[DB-2] Skipping: DATABASE_URL unreachable — ${connectionError}`);
      ctx.skip();
      return;
    }
    const database = db!;

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        database.transaction(async (tx) => {
          const sequenceNumber = await allocateSequence(channelB, 1, tx);
          const id = monotonicUlid();
          await tx.execute(sql`
            insert into "messages"
              ("id", "channel_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number")
            values (
              ${id}, ${channelB}, 'db2-test-agent', 'DB-2 Concurrency Test', '0', 'agent',
              'DB-2 concurrency probe', ${sequenceNumber}
            )
          `);
          return { id, sequenceNumber };
        }),
      ),
    );

    expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
    expect(conflict23505Count(settled)).toBe(0);

    const rows = (await database.execute(
      sql`select "id", "sequence_number" from "messages" where "channel_id" = ${channelB} order by "sequence_number"`,
    )) as unknown as Array<{ id: string; sequence_number: number }>;

    expect(rows).toHaveLength(20);
    expect(rows.map((r) => Number(r.sequence_number))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(20);
    expect([...ids].sort()).toEqual(ids);

    const counterRows = (await database.execute(
      sql`select "last_seq" from "channel_sequences" where "channel_id" = ${channelB}`,
    )) as unknown as Array<{ last_seq: string }>;
    expect(Number(counterRows[0]?.last_seq)).toBe(20);
  }, 30_000);
});

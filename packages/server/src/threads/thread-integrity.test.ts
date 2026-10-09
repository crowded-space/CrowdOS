// THR-002/004/005/006 · PG-tier integrity proofs against a scratch database.
//
// Gated on THR_TEST_DATABASE_URL (a disposable database; migrations are applied
// by this suite). Skipped silently when unset, mirroring message-pagination's
// real-DB pattern. Run:
//   THR_TEST_DATABASE_URL=postgresql://... npx vitest run src/threads/thread-integrity.test.ts
//
// Pins, in order:
//   THR-002: channel msg seq 1 + thread reply seq 1 coexist (thread-aware index
//            messages_channel_thread_sequence_idx; old channel-scoped index gone).
//   THR-004: partial unique index threads_parent_message_idx rejects a second
//            thread on one parent (23505) and the service maps the race to the
//            winner (drizzle cause-chain walk).
//   THR-005: deleting a thread SET NULLs its replies' thread_id (no orphans).
//   THR-006: guarded transition map — expired->active is refused, archivedAt is
//            stamped on every non-active move.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Must run before the env module loads so isDatabaseConfigured() sees the URL.
const { TEST_URL } = vi.hoisted(() => {
  const url = process.env.THR_TEST_DATABASE_URL ?? "";
  if (url) process.env.DATABASE_URL = url;
  return { TEST_URL: url };
});

import { runWithDb } from "../shared/config/database.js";
import * as schema from "../db/schema.js";
import { threadGate } from "./thread-gate.js";

describe.skipIf(!TEST_URL)("THR-002/004/005/006 · thread integrity (scratch PG)", () => {
  let client: ReturnType<typeof postgres> | null = null;
  let handle: ReturnType<typeof drizzle<typeof schema>> | null = null;
  let connectionError = "";
  const CH = `thr-integrity-${Date.now().toString(36)}`;

  beforeAll(async () => {
    client = postgres(TEST_URL, { max: 5, connect_timeout: 5, onnotice: () => {} });
    try {
      await client`select 1`;
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
      return;
    }
    const migrationsFolder = fileURLToPath(new URL("../db/migrations", import.meta.url));
    await migrate(drizzle(client), { migrationsFolder });
    await client`insert into "workspaces" ("id", "name", "owner_id", "root_path") values ('default', 'Default', 'system', '.') on conflict ("id") do nothing`;
    await client`insert into "channels" ("id", "name", "type", "created_by", "position") values (${CH}, ${CH}, 'standard', 'thr-test', 0) on conflict ("id") do nothing`;
    handle = drizzle(client, { schema });
  }, 120_000);

  afterAll(async () => {
    if (client) {
      try {
        if (!connectionError) await client`delete from "channels" where "id" = ${CH}`;
      } finally {
        await client.end({ timeout: 5 });
      }
    }
  });

  function requireClient() {
    if (!client || connectionError) throw new Error(connectionError || "db unavailable");
    return client;
  }

  function requireHandle() {
    if (!handle) throw new Error(connectionError || "db unavailable");
    return handle;
  }

  it("THR-002: channel seq 1 and thread reply seq 1 coexist; old channel-scoped index is gone", async (ctx) => {
    if (connectionError) return ctx.skip();
    const sql = requireClient();
    const threadId = `thr_idx_${Date.now().toString(36)}`;
    await sql`insert into "messages" ("id", "channel_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${`m-ch-${threadId}`}, ${CH}, 'u', 'U', '1', 'user', 'channel seq 1', 1, now())`;
    await sql`insert into "threads" ("id", "channel_id", "created_by", "is_ephemeral", "status", "message_count", "last_activity_at", "created_at", "updated_at") values (${threadId}, ${CH}, 't', true, 'active', 0, now(), now(), now())`;
    await sql`insert into "messages" ("id", "channel_id", "thread_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${`m-th-${threadId}`}, ${CH}, ${threadId}, 'u', 'U', '1', 'user', 'thread seq 1', 1, now())`;
    const rows = await sql`select "id" from "messages" where "channel_id" = ${CH} and "sequence_number" = 1`;
    expect(rows.length).toBe(2);
    const idx = (await sql`select "indexname" from "pg_indexes" where "tablename" = 'messages' and "indexname" in ('messages_channel_sequence_idx', 'messages_channel_thread_sequence_idx')`) as unknown as Array<{ indexname: string }>;
    const names = idx.map((r) => r.indexname);
    expect(names).toContain("messages_channel_thread_sequence_idx");
    expect(names).not.toContain("messages_channel_sequence_idx");
  });

  it("THR-004: one thread per parent — unique index rejects the duplicate and create maps the race to the winner", async (ctx) => {
    if (connectionError) return ctx.skip();
    const sql = requireClient();
    const parentId = `p_${Date.now().toString(36)}`;
    await sql`insert into "messages" ("id", "channel_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${parentId}, ${CH}, 'u', 'U', '1', 'user', 'parent', 100, now())`;

    // DB constraint: a raw second insert on the same parent must 23505.
    await sql`insert into "threads" ("id", "channel_id", "parent_message_id", "created_by", "is_ephemeral", "status", "message_count", "last_activity_at", "created_at", "updated_at") values (${`t1_${parentId}`}, ${CH}, ${parentId}, 't', true, 'active', 0, now(), now(), now())`;
    let duplicateCode = "";
    try {
      await sql`insert into "threads" ("id", "channel_id", "parent_message_id", "created_by", "is_ephemeral", "status", "message_count", "last_activity_at", "created_at", "updated_at") values (${`t2_${parentId}`}, ${CH}, ${parentId}, 't', true, 'active', 0, now(), now(), now())`;
    } catch (err) {
      duplicateCode = (err as { code?: string }).code ?? "";
    }
    expect(duplicateCode).toBe("23505");

    // Service race: two concurrent creates both resolve to the same winner.
    const parent2 = `p2_${Date.now().toString(36)}`;
    await sql`insert into "messages" ("id", "channel_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${parent2}, ${CH}, 'u', 'U', '1', 'user', 'parent2', 101, now())`;
    const h = requireHandle();
    const [a, b] = await Promise.all([
      runWithDb(h as never, () => threadGate.create({ channelId: CH, parentMessageId: parent2, createdBy: "t" })),
      runWithDb(h as never, () => threadGate.create({ channelId: CH, parentMessageId: parent2, createdBy: "t" })),
    ]);
    const aId = (a as { thread?: { id?: string } }).thread?.id;
    const bId = (b as { thread?: { id?: string } }).thread?.id;
    expect(aId).toBeTruthy();
    expect(bId).toBe(aId);
    const count = await sql`select count(*)::int as n from "threads" where "parent_message_id" = ${parent2}`;
    expect(count[0].n).toBe(1);
  });

  it("THR-005: deleting a thread SET NULLs its replies instead of orphaning them", async (ctx) => {
    if (connectionError) return ctx.skip();
    const sql = requireClient();
    const h = requireHandle();
    const created = await runWithDb(h as never, () => threadGate.create({ channelId: CH, createdBy: "t" }));
    const threadId = (created as { thread: { id: string } }).thread.id;
    const replyId = `reply_${Date.now().toString(36)}`;
    await sql`insert into "messages" ("id", "channel_id", "thread_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${replyId}, ${CH}, ${threadId}, 'u', 'U', '1', 'user', 'reply', 200, now())`;
    const del = await runWithDb(h as never, () => threadGate.delete(threadId));
    expect((del as { deleted?: boolean }).deleted).toBe(true);
    const reply = await sql`select "thread_id" from "messages" where "id" = ${replyId}`;
    expect(reply.length).toBe(1);
    expect(reply[0].thread_id).toBe(null);
  });

  it("THR-006: guarded transitions — expired cannot resurrect; archivedAt stamped on every non-active move", async (ctx) => {
    if (connectionError) return ctx.skip();
    const h = requireHandle();
    const created = await runWithDb(h as never, () => threadGate.create({ channelId: CH, createdBy: "t" }));
    const id = (created as { thread: { id: string } }).thread.id;

    const archived = await runWithDb(h as never, () => threadGate.update(id, { status: "archived" }));
    expect((archived as { thread: { status: string } }).thread.status).toBe("archived");
    expect((archived as { thread: { archivedAt: unknown } }).thread.archivedAt).toBeTruthy();

    // archived -> expired is not in the map: refused.
    const bad = await runWithDb(h as never, () => threadGate.update(id, { status: "expired" }));
    expect((bad as { error?: string }).error).toBe("illegal_transition");

    const restored = await runWithDb(h as never, () => threadGate.update(id, { status: "active" }));
    expect((restored as { thread: { status: string } }).thread.status).toBe("active");

    const expired = await runWithDb(h as never, () => threadGate.update(id, { status: "expired" }));
    expect((expired as { thread: { status: string } }).thread.status).toBe("expired");
    expect((expired as { thread: { archivedAt: unknown } }).thread.archivedAt).toBeTruthy();

    const resurrect = await runWithDb(h as never, () => threadGate.update(id, { status: "active" }));
    expect((resurrect as { error?: string }).error).toBe("illegal_transition");
  });

  it("THR-007 (PG branch): archiveExpired flips stale actives once and reports 0 on the repeat tick", async (ctx) => {
    if (connectionError) return ctx.skip();
    const sql = requireClient();
    const h = requireHandle();
    const created = await runWithDb(h as never, () => threadGate.create({ channelId: CH, createdBy: "t", isEphemeral: true, ttlHours: 1 }));
    const id = (created as { thread: { id: string } }).thread.id;
    await sql`update "threads" set "expires_at" = now() - interval '1 minute' where "id" = ${id}`;

    const first = await runWithDb(h as never, () => threadGate.archiveExpired());
    expect(first).toBe(1);
    const row = await sql`select "status", "archived_at" from "threads" where "id" = ${id}`;
    expect(row[0].status).toBe("expired");
    expect(row[0].archived_at).not.toBe(null);

    const second = await runWithDb(h as never, () => threadGate.archiveExpired());
    expect(second).toBe(0);
  });

  it("getMessages cursor path binds safely on PG (was a raw-Date crash) and pages correctly", async (ctx) => {
    if (connectionError) return ctx.skip();
    const sql = requireClient();
    const h = requireHandle();
    const created = await runWithDb(h as never, () => threadGate.create({ channelId: CH, createdBy: "t" }));
    const id = (created as { thread: { id: string } }).thread.id;
    for (let i = 1; i <= 3; i++) {
      await sql`insert into "messages" ("id", "channel_id", "thread_id", "author_id", "author_name", "author_level", "author_type", "content", "sequence_number", "timestamp") values (${`m-${id}-${i}`}, ${CH}, ${id}, 'u', 'U', '1', 'user', ${`reply ${i}`}, ${i}, now() + ${`${i} seconds`}::interval)`;
    }
    const page1 = await runWithDb(h as never, () => threadGate.getMessages(id, { limit: 2 }));
    const p1 = page1 as { messages: Array<{ content: string }>; nextCursor: string | null };
    // Newest page first, chronological within the page (matches the port doc).
    expect(p1.messages.map((m) => m.content)).toEqual(["reply 2", "reply 3"]);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await runWithDb(h as never, () => threadGate.getMessages(id, { limit: 2, before: p1.nextCursor }));
    const p2 = page2 as { messages: Array<{ content: string }>; nextCursor: string | null };
    expect(p2.messages.map((m) => m.content)).toEqual(["reply 1"]);
    expect(p2.nextCursor).toBe(null);
  });
});

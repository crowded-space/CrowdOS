import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError,
} from "./messageService.js";
import { messages } from "../db/schema.js";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const CHANNEL_ID = `perf5-paginate-${randomUUID().slice(0, 8)}`;
const TOTAL = 120;
const BASE_TS = Date.UTC(2026, 0, 1);

describe.skipIf(!DATABASE_URL)("PERF-5 · keyset pagination page walk (real dev DB)", () => {
  let client: ReturnType<typeof postgres> | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  let connectionError = "";

  beforeAll(async () => {
    client = postgres(DATABASE_URL, { prepare: false, max: 5, idle_timeout: 5, connect_timeout: 5, onnotice: () => {} });
    try {
      await client`select 1`;
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
      return;
    }
    const table = (await client`select to_regclass('public.messages') as t`)[0]?.t;
    if (!table) {
      connectionError = "messages table missing — run db:bootstrap first";
      return;
    }
    db = drizzle(client);

    await client`delete from "channels" where "id" = ${CHANNEL_ID}`;
    await client`
      insert into "workspaces" ("id", "name", "owner_id", "status", "root_path")
      values ('default', 'Default Workspace', 'human_operator', 'ACTIVE', 'sandbox/default')
      on conflict ("id") do nothing
    `;
    await client`
      insert into "channels" ("id", "workspace_id", "name", "type", "created_by", "position")
      values (${CHANNEL_ID}, 'default', ${CHANNEL_ID}, 'standard', 'perf5-test', 0)
    `;
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      id: `perf5-${String(i + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
      workspaceId: "default",
      channelId: CHANNEL_ID,
      authorId: "perf5-user",
      authorName: "PERF5 Seeder",
      authorLevel: "1",
      authorType: "user" as const,
      content: `perf5 message #${i + 1}`,
      mentions: [],
      sequenceNumber: i + 1,
      timestamp: new Date(BASE_TS + (i + 1) * 60_000),
    }));
    await db.insert(messages).values(rows);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    try {
      if (!connectionError) {
        await client`delete from "channels" where "id" = ${CHANNEL_ID}`;
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  function requireDb() {
    if (!db) throw new Error(connectionError || "db unavailable");
    return db;
  }

  function seqs(page: { messages: any[] }): number[] {
    return page.messages.map((m) => m.sequenceNumber);
  }

  it("walks 120 seeded messages as pages of 50/50/20 with correct cursors and stable ordering", async (ctx) => {
    if (connectionError) {
      console.warn(`[PERF-5] Skipping: ${connectionError}`);
      ctx.skip();
      return;
    }
    requireDb();

    const page1 = await getChannelMessagesPage(CHANNEL_ID, false, {});
    expect(page1.messages).toHaveLength(50);
    expect(seqs(page1)).toEqual(Array.from({ length: 50 }, (_, i) => TOTAL - i));
    expect(page1.cursor).not.toBeNull();
    expect(page1.cursor!.before.seq).toBe(TOTAL - 49);

    const page2 = await getChannelMessagesPage(
      CHANNEL_ID,
      false,
      { before: { timestamp: new Date(page1.cursor!.before.timestamp), seq: page1.cursor!.before.seq } }
    );
    expect(page2.messages).toHaveLength(50);
    expect(seqs(page2)).toEqual(Array.from({ length: 50 }, (_, i) => TOTAL - 50 - i));
    expect(page2.cursor!.before.seq).toBe(TOTAL - 99);

    const page3 = await getChannelMessagesPage(
      CHANNEL_ID,
      false,
      { before: { timestamp: new Date(page2.cursor!.before.timestamp), seq: page2.cursor!.before.seq } }
    );
    expect(page3.messages).toHaveLength(20);
    expect(seqs(page3)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
    expect(page3.cursor).toBeNull();

    const seen = [...seqs(page1), ...seqs(page2), ...seqs(page3)].sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
  }, 30_000);

  it("keeps newest-first ordering stable within every page", async (ctx) => {
    if (connectionError) {
      ctx.skip();
      return;
    }
    requireDb();

    const page = await getChannelMessagesPage(CHANNEL_ID, false, { limit: 30 });
    const pairs = page.messages.map((m) => ({
      ts: new Date(m.timestamp).getTime(),
      seq: m.sequenceNumber,
    }));
    for (let i = 1; i < pairs.length; i++) {
      const prev = pairs[i - 1];
      const curr = pairs[i];
      expect(prev.ts > curr.ts || (prev.ts === curr.ts && prev.seq > curr.seq)).toBe(true);
    }
  });

  it("honors an explicit legacy-style limit param", async (ctx) => {
    if (connectionError) {
      ctx.skip();
      return;
    }
    requireDb();

    const page = await getChannelMessagesPage(CHANNEL_ID, false, { limit: 10 });
    expect(page.messages).toHaveLength(10);
    expect(seqs(page)[0]).toBe(TOTAL);
    expect(seqs(page)[9]).toBe(TOTAL - 9);
    expect(page.cursor!.before.seq).toBe(TOTAL - 9);
  });

  it("rejects malformed cursors and accepts well-formed ones through parseBeforeCursor", () => {
    expect(() => parseBeforeCursor("garbage")).toThrow(MalformedCursorError);
    expect(() => parseBeforeCursor("2026-01-01T00:00:00Z;")).toThrow(MalformedCursorError);
    expect(() => parseBeforeCursor(";12")).toThrow(MalformedCursorError);

    const parsed = parseBeforeCursor("2026-01-01T00:00:00.000Z;42");
    expect(parsed).toBeDefined();
    expect(parsed!.timestamp.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed!.seq).toBe(42);
    expect(parseBeforeCursor(undefined)).toBeUndefined();
  });

  it("exhausts the feed cleanly past the oldest message", async (ctx) => {
    if (connectionError) {
      ctx.skip();
      return;
    }
    requireDb();

    const beyond = await getChannelMessagesPage(CHANNEL_ID, false, {
      before: { timestamp: new Date(BASE_TS), seq: 1 },
    });
    expect(beyond.messages).toEqual([]);
    expect(beyond.cursor).toBeNull();
  });
});

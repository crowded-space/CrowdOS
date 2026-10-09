import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getChannelMessagesPage,
  parseBeforeCursor,
  MalformedCursorError,
  buildReplicaInsert,
  workspaceOfChannel,
  InvalidMessageInputError,
} from "./message-service.js";
import { messages } from "../db/schema.js";
import { messageGate } from "./message-gate.js";
import { channelGate } from "../channels/channel-gate.js";
import { threadGate } from "../threads/thread-gate.js";
import { localStoreDirsForTests, mutateJsonArray, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { env } from "../shared/config/env.js";
import { threadRoutes } from "../routes/threads.js";
import { validatorCompiler } from "../shared/core/validation.js";
import { EventBroker } from "../event-broker/event-broker-gate.js";
import { registerSocketServer } from "../shared/sockets/register-socket-server.js";
import { appendOutbox, readOutbox } from "../shared/core/outbox.js";
import { drainOutbox } from "../shared/core/workspace-sync.js";

// MSG-020: the outbox drain resolves its tenant handle through
// workspace-gate.getWorkspaceDb. This seam lets the replay test inject a
// recording PG handle for its fixture workspace only; every other workspace
// keeps the real resolution.
const msg020Seam = vi.hoisted(() => ({
  db: null as any,
  workspaceId: null as string | null,
}));
config({ path: new URL("../../.env", import.meta.url), quiet: true });

// MSG-010: the read gap-fill must resolve the SAME workspace-record DB handle
// (getWorkspaceDb) the write replica leg uses — never the ambient pool alone.
// This file-level mock keeps the real workspace gate and only injects a fake
// record-DB handle for the MSG-010 fixture workspace; every other caller
// (including the other suites in this file) delegates to the real module.
const msg010Seam = vi.hoisted(() => ({
  workspaceDb: null as { workspaceId: string; db: any } | null,
}));

vi.mock("../workspace/workspace-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/workspace-gate.js")>();
  return {
    ...actual,
    getWorkspaceDb: (async (workspaceId?: string | null) => {
      if (msg020Seam.workspaceId && workspaceId === msg020Seam.workspaceId && msg020Seam.db) {
        return { db: msg020Seam.db, source: "workspace" as const, workspaceId: workspaceId ?? null };
      }
      if (msg010Seam.workspaceDb && workspaceId === msg010Seam.workspaceDb.workspaceId) {
        return { db: msg010Seam.workspaceDb.db, source: "workspace" as const, workspaceId: workspaceId ?? null };
      }
      return actual.getWorkspaceDb(workspaceId);
    }) as unknown as typeof actual.getWorkspaceDb,
  };
});

// MSG-011: the messages domain only ever sees channels through the gate, so
// the port is the right seam to express "channel row appears after the first
// lookup". Everything else (create/list for the other suites) delegates to the
// real gate.
const msg011Seam = vi.hoisted(() => ({
  getOverride: null as null | ((id: string) => Promise<any>),
}));

vi.mock("../channels/channel-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/channel-gate.js")>();
  return {
    ...actual,
    channelGate: {
      ...actual.channelGate,
      get: (async (id: string) =>
        msg011Seam.getOverride ? msg011Seam.getOverride(id) : actual.channelGate.get(id)) as typeof actual.channelGate.get,
    },
  };
});

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
      insert into "channels" ("id", "workspace_id", "name", "type", "created_by", "position")
      values (${CHANNEL_ID}, 'default', ${CHANNEL_ID}, 'standard', 'perf5-test', 0)
    `;
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      id: `perf5-${String(i + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
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

    const page1 = await getChannelMessagesPage(CHANNEL_ID, {});
    expect(page1.messages).toHaveLength(50);
    expect(seqs(page1)).toEqual(Array.from({ length: 50 }, (_, i) => TOTAL - i));
    expect(page1.cursor).not.toBeNull();
    expect(page1.cursor!.before.seq).toBe(TOTAL - 49);

    const page2 = await getChannelMessagesPage(
      CHANNEL_ID,
      { before: { timestamp: new Date(page1.cursor!.before.timestamp), seq: page1.cursor!.before.seq } }
    );
    expect(page2.messages).toHaveLength(50);
    expect(seqs(page2)).toEqual(Array.from({ length: 50 }, (_, i) => TOTAL - 50 - i));
    expect(page2.cursor!.before.seq).toBe(TOTAL - 99);

    const page3 = await getChannelMessagesPage(
      CHANNEL_ID,
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

    const page = await getChannelMessagesPage(CHANNEL_ID, { limit: 30 });
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

    const page = await getChannelMessagesPage(CHANNEL_ID, { limit: 10 });
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

    const beyond = await getChannelMessagesPage(CHANNEL_ID, {
      before: { timestamp: new Date(BASE_TS), seq: 1 },
    });
    expect(beyond.messages).toEqual([]);
    expect(beyond.cursor).toBeNull();
  });
});

// ── MSG-001 · thread-aware uniqueness + targeted replica conflict ─────────

describe("MSG-001 · thread-aware message uniqueness", () => {
  it("keeps the unique index thread-aware, drops the channel-scoped one, and pins the replica conflict target to the primary key", () => {
    // (a) Migration 0025 is the persisted half of the fix: drop the
    // channel-scoped unique index, create the thread-aware one.
    const migrationSql = readFileSync(
      new URL("../db/migrations/0025_thread_aware_message_sequence.sql", import.meta.url),
      "utf8",
    );
    expect(migrationSql).toContain('DROP INDEX IF EXISTS "messages_channel_sequence_idx"');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "messages_channel_thread_sequence_idx"');
    expect(migrationSql).toContain('COALESCE("thread_id", \'\')');

    // (b) The drizzle schema mirrors the migration: no channel-scoped unique
    // index; a thread-aware unique index on
    // (channel_id, COALESCE(thread_id, ''), sequence_number).
    const indexes = getTableConfig(messages).indexes.map((idx: any) => idx.config);
    expect(indexes.find((c: any) => c.name === "messages_channel_sequence_idx")).toBeUndefined();
    const threadAware = indexes.find((c: any) => c.name === "messages_channel_thread_sequence_idx");
    expect(threadAware).toBeDefined();
    expect(threadAware!.unique).toBe(true);
    const cols = threadAware!.columns as any[];
    expect(cols).toHaveLength(3);
    expect(cols[0].name).toBe("channel_id");
    expect(cols[2].name).toBe("sequence_number");
    // Middle column is the COALESCE(thread_id, '') SQL expression, not a bare column.
    const midText = (cols[1].queryChunks ?? [])
      .map((c: any) => c?.name ?? (Array.isArray(c?.value) ? c.value.join("") : String(c?.value ?? "")))
      .join("");
    expect(midText.toLowerCase()).toContain("coalesce");
    expect(midText).toContain("thread_id");

    // (c) Replica insert targets ONLY the primary key. A bare ON CONFLICT DO
    // NOTHING swallowed any unique violation — including a
    // (channel|thread, sequence_number) collision — silently dropping the row
    // from PG; a same-id retry stays idempotent.
    const tx = drizzle({} as any);
    const row = {
      id: "msg-001-probe",
      channelId: "chan-001",
      workspaceId: null,
      threadId: "thread-001",
      authorId: "agent-001",
      authorName: "Agent",
      authorLevel: "1",
      authorType: "agent" as const,
      content: "probe",
      mentions: [],
      metadata: null,
      toolCalls: null,
      isInternalMonologue: false,
      sequenceNumber: 1,
      timestamp: new Date(),
    };
    const sqlText = new PgDialect().sqlToQuery((buildReplicaInsert(tx, row) as any).getSQL()).sql;
    expect(sqlText).toContain('on conflict ("id") do nothing');
    expect(sqlText).not.toMatch(/on conflict do nothing/);
  });
});

// ── MSG-004 · monologue/final pairing across page boundaries ─────────────

const MSG004_CHANNEL = "msg-004-boundary-channel";
const MSG004_AUTHOR = "msg-004-boundary-agent";

function boundaryRow(over: Record<string, unknown>) {
  return {
    channelId: MSG004_CHANNEL,
    workspaceId: "default",
    threadId: null,
    authorId: MSG004_AUTHOR,
    authorName: "Boundary Agent",
    authorLevel: "1",
    authorType: "agent",
    content: "",
    mentions: [],
    metadata: null,
    toolCalls: null,
    isInternalMonologue: false,
    sequenceNumber: 0,
    timestamp: new Date(0),
    ...over,
  };
}

/**
 * Fake PG handle for getChannelMessagesPage's `db` override. Emulates the two
 * query shapes the page path issues: the keyset page fetch (newest-first) and
 * the MSG-004 newer-context probe (oldest-first, limit 1). The cursor is
 * recovered from the rendered keyset parameters, so the fake needs no drizzle
 * where-clause evaluation.
 */
function fakeBoundaryDb(newestFirst: any[]) {
  let lastHead: any = null;
  return {
    query: {
      messages: {
        findMany: async (args: any) => {
          const [first] = args.orderBy(
            { timestamp: "timestamp", sequenceNumber: "sequenceNumber" },
            { desc: (c: string) => `desc:${c}`, asc: (c: string) => `asc:${c}` },
          );
          const { params } = new PgDialect().sqlToQuery(args.where);
          if (String(first).startsWith("desc")) {
            const cursorTs = params.find((p: unknown) => typeof p === "string" && !Number.isNaN(Date.parse(p as string)));
            const cursorSeq = params.find((p: unknown) => typeof p === "number");
            const rows = newestFirst
              .filter((r) => {
                if (cursorTs === undefined || cursorSeq === undefined) return true;
                const t = new Date(r.timestamp).getTime();
                const ct = Date.parse(cursorTs as string);
                return t < ct || (t === ct && r.sequenceNumber < (cursorSeq as number));
              })
              .slice(0, args.limit);
            lastHead = rows[0] ?? null;
            return rows;
          }
          if (!lastHead) return [];
          const headTs = new Date(lastHead.timestamp).getTime();
          const newer = newestFirst.filter((r) => {
            const t = new Date(r.timestamp).getTime();
            return t > headTs || (t === headTs && r.sequenceNumber > lastHead.sequenceNumber);
          });
          // Descending list: the immediately-newer row is the last match.
          return newer.slice(-1);
        },
      },
    },
  };
}

describe("MSG-004 · monologue/final pairing across page boundaries", () => {
  it("attaches the boundary monologue to its final and suppresses the synthetic row on the older page", async () => {
    // Writer order (thoughts persisted before the final): monologue m1 is
    // immediately OLDER than its final f1; the page boundary falls between
    // them. Without the fix: f1 renders bare on page 1 and page 2 grows a
    // synthetic monologue-m1 row. With the fix: f1 carries the monologue and
    // page 2 shows no synthetic.
    const db = fakeBoundaryDb([
      boundaryRow({ id: "f1", content: "Final answer", sequenceNumber: 2, timestamp: new Date(2000) }),
      boundaryRow({ id: "m1", content: "Deep thoughts", isInternalMonologue: true, sequenceNumber: 1, timestamp: new Date(1000) }),
      boundaryRow({ id: "x1", authorId: "u1", authorType: "user", authorName: "User", content: "older 1", sequenceNumber: 3, timestamp: new Date(500) }),
      boundaryRow({ id: "x2", authorId: "u1", authorType: "user", authorName: "User", content: "older 2", sequenceNumber: 4, timestamp: new Date(400) }),
    ]);

    const page1 = await getChannelMessagesPage(MSG004_CHANNEL, { limit: 1, db });
    expect(page1.messages.map((m: any) => m.id)).toEqual(["f1"]);
    expect(page1.messages[0].metadata?.monologue).toBe("Deep thoughts");
    expect(page1.cursor).not.toBeNull();

    const page2 = await getChannelMessagesPage(MSG004_CHANNEL, {
      limit: 1,
      before: { timestamp: new Date(page1.cursor!.before.timestamp), seq: page1.cursor!.before.seq },
      db,
    });
    expect(page2.messages.some((m: any) => String(m.id).startsWith("monologue-"))).toBe(false);
    expect(page2.messages.find((m: any) => m.id === "f1")).toBeUndefined();
  });

  it("keeps the synthetic Reasoning card for a genuinely in-flight monologue at the head page", async () => {
    // No final exists yet (m2 is the newest row overall): the head page must
    // keep surfacing in-flight reasoning as a synthetic card.
    const db = fakeBoundaryDb([
      boundaryRow({ id: "m2", authorId: "msg-004-inflight-agent", content: "Still thinking", isInternalMonologue: true, sequenceNumber: 5, timestamp: new Date(3000) }),
      boundaryRow({ id: "x3", authorId: "u1", authorType: "user", authorName: "User", content: "older", sequenceNumber: 4, timestamp: new Date(2500) }),
    ]);

    const page = await getChannelMessagesPage(MSG004_CHANNEL, { limit: 1, db });
    const synthetic = page.messages.find((m: any) => m.id === "monologue-msg-004-inflight-agent");
    expect(synthetic).toBeDefined();
    expect(synthetic!.content).toBe("*Reasoning completed*");
    expect(synthetic!.metadata?.monologue).toBe("Still thinking");
  });
});

// ── MSG-008 · structured tool-result status (no prefix guessing) ──────────

const MSG008_CHANNEL = "msg-008-tool-status-channel";

function toolRow(id: string, result: unknown, over: Record<string, unknown> = {}) {
  return boundaryRow({
    id,
    channelId: MSG008_CHANNEL,
    isInternalMonologue: true,
    toolCalls: [{ name: "probe", args: { q: "x" }, result, truncated: false, durationMs: 5, callId: null }],
    ...over,
  });
}

describe("MSG-008 · structured tool-result status", () => {
  it("marks {ok:false} and lowercase legacy error results as error, preserving structured output", async () => {
    // Structured failure: the old String() path rendered [object Object] and
    // the prefix heuristic then badged it success.
    const failPage = await getChannelMessagesPage(MSG008_CHANNEL, {
      limit: 10,
      db: fakeBoundaryDb([toolRow("m-fail", { ok: false, error: "boom" }, { sequenceNumber: 1, timestamp: new Date(1000) })]),
    });
    const failCard = failPage.messages.find((m: any) => m.id === "tool-m-fail-0");
    expect(failCard).toBeDefined();
    expect(failCard.toolExecution.status).toBe("error");
    // Structured result keeps its shape (JSON), never [object Object].
    expect(failCard.toolExecution.output).toBe(JSON.stringify({ ok: false, error: "boom" }));

    // Structured success stays success.
    const okPage = await getChannelMessagesPage(MSG008_CHANNEL, {
      limit: 10,
      db: fakeBoundaryDb([toolRow("m-ok", { ok: true, data: [1, 2] }, { sequenceNumber: 1, timestamp: new Date(1000) })]),
    });
    const okCard = okPage.messages.find((m: any) => m.id === "tool-m-ok-0");
    expect(okCard.toolExecution.status).toBe("success");
    expect(okCard.toolExecution.output).toBe(JSON.stringify({ ok: true, data: [1, 2] }));

    // Legacy string results keep prefix matching, lowercase included.
    const legacyPage = await getChannelMessagesPage(MSG008_CHANNEL, {
      limit: 10,
      db: fakeBoundaryDb([toolRow("m-legacy", "error: legacy failure", { sequenceNumber: 1, timestamp: new Date(1000) })]),
    });
    const legacyCard = legacyPage.messages.find((m: any) => m.id === "tool-m-legacy-0");
    expect(legacyCard.toolExecution.status).toBe("error");
  });
});

// ── MSG-009 · single-emit ownership for thread replies ───────────────────

describe("MSG-009 · one message:new per thread post", () => {
  it("emits exactly one message:new from the domain when a thread reply is posted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg009-"));
    const regDir = mkdtempSync(join(tmpdir(), "crowdos-msg009-reg-"));
    const prevUrl = env.DATABASE_URL;
    setLocalStoreDirForTests(dir);
    writeFileSync(join(regDir, "workspaces.json"), JSON.stringify({ workspaces: [] }), "utf8");
    setRegistryFilePathForTests(join(regDir, "workspaces.json"));
    (env as any).DATABASE_URL = undefined;

    const broker = new EventBroker();
    const emitted: any[] = [];
    broker.on("message:new", undefined, (event) => emitted.push(event));
    const httpServer = createServer();
    const io = registerSocketServer(httpServer, broker);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    try {
      const WS = "ws-msg009";
      const cat = await channelGate.createCategory({ name: "General", workspaceId: WS, createdBy: "test" });
      const ch = await channelGate.create(
        { name: "general", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
        undefined,
        WS,
      );
      const channelId = (ch as any).channel?.id ?? (ch as any).id;
      const created = await threadGate.create({ channelId, createdBy: "test" });
      const threadId = (created as any).thread.id as string;

      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      await threadRoutes(app);
      await app.ready();
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/threads/${threadId}/messages`,
          payload: { content: "hello thread", authorId: "u1", authorName: "User" },
        });
        expect(res.statusCode).toBe(201);

        // Exactly one message:new — the domain emit inside append. The old
        // route emitted a second one by hand; re-adding that emit makes this 2.
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload?.id).toBe(res.json().id);
      } finally {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      (env as any).DATABASE_URL = prevUrl;
      setRegistryFilePathForTests(null);
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(regDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── MSG-030 · trust boundary is the transport, not the domain ────────────

describe("MSG-030 · append persists caller-supplied authorship verbatim", () => {
  it("documents that author identity is a caller claim here; verification lives at the transport", async () => {
    // Trust model under test (see the appendMessage doc block and Messages.md
    // Gaps): messageGate.append is an INTERNAL domain API. authorId /
    // authorName / authorType are persisted verbatim, so any in-process
    // caller can claim agent or system authorship. The trust boundary is the
    // TRANSPORT: the socket path derives authorId from the verified socket
    // identity (SEC-2) and never persists client-claimed ids. This test pins
    // that documented boundary: if an in-domain actor check is ever added
    // (e.g. system rows gated behind an actor option), it must flip this test
    // deliberately instead of silently.
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg030-"));
    const prevUrl = env.DATABASE_URL;
    setLocalStoreDirForTests(dir);
    (env as any).DATABASE_URL = undefined;

    try {
      const channelId = `msg-030-${randomUUID().slice(0, 8)}`;
      // A caller claiming the system author that agent-errors.ts legitimately
      // uses. The domain cannot distinguish this from the real producer —
      // that is the boundary being documented, not a bug to fix here.
      const row = await messageGate.append({
        channelId,
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "stakeholder",
        authorType: "system",
        content: "claimed system authorship (in-process caller)",
      });

      // Verbatim persistence: no ownership check, no rewriting.
      expect((row as any).authorId).toBe("system");
      expect((row as any).authorName).toBe("System Warning");
      expect((row as any).authorType).toBe("system");

      // The row landed in the local truth tier unchanged (no transport in
      // the path to verify against).
      const lines = readFileSync(
        join(localStoreDirsForTests("default").crowdos, "messages", `${channelId}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].authorType).toBe("system");
      expect(lines[0].authorName).toBe("System Warning");
    } finally {
      (env as any).DATABASE_URL = prevUrl;
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
// ── MSG-010 · read gap-fill resolves the workspace-record DB handle ───────

const MSG010_CHANNEL = `msg-010-${randomUUID().slice(0, 8)}`;
const MSG010_WS = "ws-msg010";

describe("MSG-010 · read gap-fill uses the workspace-record handle", () => {
  it("returns workspace-DB history when the local log is empty (first open after migration)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg010-"));
    const regDir = mkdtempSync(join(tmpdir(), "crowdos-msg010-reg-"));
    setLocalStoreDirForTests(dir);
    // Workspace W has its own record DB; the local message log is empty.
    writeFileSync(
      join(regDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: MSG010_WS,
            name: "MSG-010 WS",
            icon: "",
            databaseUrl: "postgresql://u:p@msg010-ws/db",
            rootPath: ".",
            screenLockPinHash: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );
    setRegistryFilePathForTests(join(regDir, "workspaces.json"));

    try {
      // The channel row lives in W (so workspaceOfChannel resolves it), but no
      // local messages were ever written — the migration first-open case.
      await mutateJsonArray(
        "channels.json",
        (rows: any[]) => {
          rows.push({
            id: MSG010_CHANNEL,
            categoryId: null,
            workspaceId: MSG010_WS,
            folderPath: null,
            name: "general",
            type: "standard",
            createdBy: "msg010-test",
            position: 0,
            createdAt: new Date().toISOString(),
            archivedAt: null,
            archivedReason: null,
          });
        },
        MSG010_WS,
      );

      // ONLY the workspace-record handle has history. The ambient pool is not
      // configured at all (DATABASE_URL unset) — a gap-fill that consults it
      // alone yields the empty page (the MSG-010 bug).
      msg010Seam.workspaceDb = {
        workspaceId: MSG010_WS,
        db: fakeBoundaryDb([
          boundaryRow({ id: "msg010-h2", channelId: MSG010_CHANNEL, authorType: "user", authorId: "u1", authorName: "User", content: "history 2", sequenceNumber: 2, timestamp: new Date(2000) }),
          boundaryRow({ id: "msg010-h1", channelId: MSG010_CHANNEL, authorType: "user", authorId: "u1", authorName: "User", content: "history 1", sequenceNumber: 1, timestamp: new Date(1000) }),
        ]),
      };

      const page = await getChannelMessagesPage(MSG010_CHANNEL, {});
      expect(page.messages.map((m: any) => m.id)).toEqual(["msg010-h2", "msg010-h1"]);
      // The gap-fill is read-only: nothing was written back into the local log.
      expect(
        existsSync(join(localStoreDirsForTests(MSG010_WS).crowdos, "messages", `${MSG010_CHANNEL}.jsonl`)),
      ).toBe(false);
    } finally {
      msg010Seam.workspaceDb = null;
      setRegistryFilePathForTests(null);
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(regDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── MSG-011 · first-miss workspace lookup must not pin the channel ────────

const MSG011_WS = "ws-msg011";

describe("MSG-011 · no negative workspace cache", () => {
  it("files a message into the channel workspace when the channel resolves after the first lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg011-"));
    const regDir = mkdtempSync(join(tmpdir(), "crowdos-msg011-reg-"));
    setLocalStoreDirForTests(dir);
    writeFileSync(join(regDir, "workspaces.json"), JSON.stringify({ workspaces: [] }), "utf8");
    setRegistryFilePathForTests(join(regDir, "workspaces.json"));
    const prevUrl = env.DATABASE_URL;
    (env as any).DATABASE_URL = undefined;

    try {
      const unknownChannelId = `msg-011-${randomUUID().slice(0, 8)}`;
      // 1. The channel row is unreadable on the first lookup (not yet created,
      // or a transient gate error — both cited causes). The old negative cache
      // pinned this null for the rest of the process.
      msg011Seam.getOverride = async () => null;
      expect(await workspaceOfChannel(unknownChannelId)).toBeNull();

      // 2. The channel row becomes readable in ws-A (created later).
      const channelRow = { id: unknownChannelId, workspaceId: MSG011_WS, name: "general", type: "standard" };
      msg011Seam.getOverride = async (id: string) => (id === unknownChannelId ? channelRow : null);

      // The pre-miss must not have pinned the channel to "no workspace".
      expect(await workspaceOfChannel(unknownChannelId)).toBe(MSG011_WS);

      const row = await messageGate.append({
        channelId: unknownChannelId,
        authorId: "u1",
        authorName: "User",
        authorLevel: "1",
        authorType: "user",
        content: "hello after resolution",
      });
      expect((row as any).workspaceId).toBe(MSG011_WS);

      // The row landed in the channel's workspace scope, never the default.
      const wsFile = join(localStoreDirsForTests(MSG011_WS).crowdos, "messages", `${unknownChannelId}.jsonl`);
      expect(existsSync(wsFile)).toBe(true);
      const lines = readFileSync(wsFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.some((r: any) => r.id === (row as any).id)).toBe(true);
      expect(
        existsSync(join(localStoreDirsForTests("default").crowdos, "messages", `${unknownChannelId}.jsonl`)),
      ).toBe(false);
    } finally {
      msg011Seam.getOverride = null;
      (env as any).DATABASE_URL = prevUrl;
      setRegistryFilePathForTests(null);
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(regDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── MSG-020 · outbox replay repairs the PG sequence counter ──────────────

const MSG020_WS = "ws-msg020";
const MSG020_CHANNEL = "msg-020-chan";

/**
 * Recording PG handle for the outbox drain: captures every insert (message row
 * + counter repair) so the test can assert the replay issued the GREATEST
 * counter upsert. Mirrors only the shapes replayEntry + repairPgCounter use.
 */
function recordingReplayDb() {
  const calls: any[] = [];
  return {
    calls,
    insert: (_table: unknown) => ({
      values: (values: any) => {
        const rec: any = { values };
        calls.push(rec);
        return {
          onConflictDoNothing: async (opts?: any) => { rec.conflict = opts; },
          onConflictDoUpdate: async (opts?: any) => { rec.upsert = opts; },
        };
      },
    }),
    query: {
      categories: { findFirst: async () => null },
      channels: { findFirst: async () => null },
      agents: { findFirst: async () => null },
    },
  };
}

describe("MSG-020 · outbox replay repairs the PG sequence counter", () => {
  it("repairs channel_sequences during message replay so a PG-side allocate cannot reissue the seq", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg020-"));
    const regDir = mkdtempSync(join(tmpdir(), "crowdos-msg020-reg-"));
    setLocalStoreDirForTests(dir);
    writeFileSync(
      join(regDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: MSG020_WS,
            name: "MSG-020 WS",
            icon: "",
            databaseUrl: "postgresql://u:p@msg020-ws/db",
            rootPath: ".",
            screenLockPinHash: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );
    setRegistryFilePathForTests(join(regDir, "workspaces.json"));

    const db = recordingReplayDb();
    msg020Seam.workspaceId = MSG020_WS;
    msg020Seam.db = db;
    try {
      // A replica-leg failure queued this entry; the drain replays it later.
      await appendOutbox({
        workspaceId: MSG020_WS,
        entity: "message",
        op: "upsert",
        rowId: "msg-020-1",
        row: {
          id: "msg-020-1",
          channelId: MSG020_CHANNEL,
          workspaceId: MSG020_WS,
          sequenceNumber: 7,
          authorId: "u1",
          authorName: "User",
          authorLevel: "1",
          authorType: "user",
          content: "replayed after outage",
          timestamp: new Date().toISOString(),
        },
      });

      const drain = await drainOutbox(MSG020_WS);
      expect(drain.replayed).toBe(1);

      // 1. The row insert stays targeted at the PK (insert-ignore by id).
      expect(db.calls[0].values.id).toBe("msg-020-1");
      expect(db.calls[0].conflict).toEqual({ target: messages.id });

      // 2. The replay also repairs the counter (GREATEST upsert, same SQL as
      // repairPgCounter). Without this the PG-side allocator could reissue
      // seq 7 and the reissued row would be silently dropped above.
      expect(db.calls).toHaveLength(2);
      expect(db.calls[1].values.channelId).toBe(MSG020_CHANNEL);
      expect(db.calls[1].values.lastSeq).toBe(7);
      const rendered = new PgDialect().sqlToQuery(db.calls[1].upsert.set.lastSeq);
      expect(rendered.sql.toLowerCase()).toContain("greatest");
      expect(rendered.params).toContain(7);

      // Drained entries are acked (queue keeps moving).
      expect(await readOutbox(10)).toHaveLength(0);
    } finally {
      msg020Seam.workspaceId = null;
      msg020Seam.db = null;
      setRegistryFilePathForTests(null);
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(regDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── MSG-012 · AppendMessageInput validated at the domain boundary ─────────

describe("MSG-012 · append rejects malformed input before any write", () => {
  it("throws a typed rejection per missing required field and never writes locally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg012-"));
    const prevUrl = env.DATABASE_URL;
    setLocalStoreDirForTests(dir);
    (env as any).DATABASE_URL = undefined;

    const base = {
      channelId: `msg-012-${randomUUID().slice(0, 8)}`,
      authorId: "u1",
      authorName: "User",
      authorLevel: "1",
      authorType: "user",
      content: "valid content",
    };
    // One case per required field (the socket path used to destructure
    // content without checking it — MSG-012).
    const cases: Array<[string, Record<string, unknown>]> = [
      ["channelId", { ...base, channelId: "   " }],
      ["authorId", { ...base, authorId: "" }],
      ["authorName", { ...base, authorName: undefined }],
      ["authorType", { ...base, authorType: "robot" }],
      ["content", { ...base, content: undefined }],
    ];

    try {
      for (const [field, input] of cases) {
        const err = await messageGate.append(input as any).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(InvalidMessageInputError);
        expect((err as InvalidMessageInputError).code).toBe("MESSAGE_INVALID_INPUT");
        expect((err as InvalidMessageInputError).issues.map((i) => i.path)).toContain(field);
      }
      // Rejected BEFORE any write: no local message log exists at all.
      const messagesDir = join(localStoreDirsForTests("default").crowdos, "messages");
      expect(existsSync(messagesDir) ? readdirSync(messagesDir).length : 0).toBe(0);
    } finally {
      (env as any).DATABASE_URL = prevUrl;
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── MSG-018 · message:new is a local-commit event ─────────────────────────

const MSG018_WS = "ws-msg018";

describe("MSG-018 · replica failure still emits exactly one message:new", () => {
  it("fires once on local commit and queues the row for replay when the PG replica leg fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-msg018-"));
    const regDir = mkdtempSync(join(tmpdir(), "crowdos-msg018-reg-"));
    const prevUrl = env.DATABASE_URL;
    setLocalStoreDirForTests(dir);
    writeFileSync(
      join(regDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: MSG018_WS,
            name: "MSG-018 WS",
            icon: "",
            databaseUrl: "postgresql://u:p@msg018-ws/db",
            rootPath: ".",
            screenLockPinHash: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );
    setRegistryFilePathForTests(join(regDir, "workspaces.json"));
    (env as any).DATABASE_URL = undefined;

    const channelId = `msg-018-${randomUUID().slice(0, 8)}`;
    msg011Seam.getOverride = async (id: string) =>
      id === channelId ? { id: channelId, workspaceId: MSG018_WS, name: "general", type: "standard" } : null;

    // Failure injection: the workspace-record handle answers the floor read
    // and then throws on the replica transaction (dead replica).
    const fakeReplicaDb = {
      select: () => ({ from: () => ({ where: async () => [{ max: 0 }] }) }),
      transaction: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      },
    };
    msg010Seam.workspaceDb = { workspaceId: MSG018_WS, db: fakeReplicaDb };

    const broker = new EventBroker();
    const emitted: any[] = [];
    broker.on("message:new", undefined, (event) => emitted.push(event));

    try {
      const row = await messageGate.append(
        {
          channelId,
          authorId: "u1",
          authorName: "User",
          authorLevel: "1",
          authorType: "user",
          content: "replica down",
        },
        { broker },
      );
      const retry = await messageGate.append(
        {
          id: (row as any).id,
          channelId,
          workspaceId: MSG018_WS,
          authorId: "u1",
          authorName: "User",
          authorLevel: "1",
          authorType: "user",
          content: "retry must not replace committed row",
        },
        { broker },
      );
      expect(retry).toEqual(row);

      // (a) Local is the commit point: the row is in the local log...
      const wsFile = join(localStoreDirsForTests(MSG018_WS).crowdos, "messages", `${channelId}.jsonl`);
      const lines = readFileSync(wsFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.filter((r: any) => r.id === (row as any).id)).toHaveLength(1);
      expect(lines.find((r: any) => r.id === (row as any).id)?.sequenceNumber).toBe((row as any).sequenceNumber);

      // (b) ...and the failed replica leg queued a replay entry (no silent loss).
      const outbox = await readOutbox();
      expect(outbox.filter((e) => e.entity === "message" && e.rowId === (row as any).id)).toHaveLength(1);

      // (c) The documented contract: message:new is a LOCAL-COMMIT event —
      // exactly one emit even though the PG replica leg threw.
      expect(emitted).toHaveLength(1);
      expect(emitted[0].payload?.id).toBe((row as any).id);
    } finally {
      msg010Seam.workspaceDb = null;
      msg011Seam.getOverride = null;
      (env as any).DATABASE_URL = prevUrl;
      setRegistryFilePathForTests(null);
      setLocalStoreDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(regDir, { recursive: true, force: true });
    }
  }, 30_000);
});

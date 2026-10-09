import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { getChannelMessagesPage } from "./message-service.js";

// SYSMSG-001: the REST read shape must preserve system authorship. Server
// messages appended with authorType 'system' (e.g. agent-errors.ts emitting
// "System Warning" rows) previously collapsed to type 'agent' in
// mergeMessageRows, so the client rendered them as agent bubbles instead of
// the centered system line.

const SYSMSG_CHANNEL = "sysmsg-001-author-type-channel";

function sysmsgRow(over: Record<string, unknown>) {
  return {
    channelId: SYSMSG_CHANNEL,
    workspaceId: "default",
    threadId: null,
    authorId: "agent-1",
    authorName: "Agent One",
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
 * Fake PG handle for getChannelMessagesPage's `db` override, mirroring the
 * harness in message-pagination.test.ts: emulates the keyset page fetch
 * (newest-first) and the MSG-004 newer-context probe (oldest-first, limit 1).
 */
function fakeDb(newestFirst: any[]) {
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
          return newer.slice(-1);
        },
      },
    },
  };
}

describe("SYSMSG-001 · read shape preserves system authorship", () => {
  it("maps authorType to the render type: system -> system, user -> human, agent -> agent", async () => {
    const db = fakeDb([
      sysmsgRow({
        id: "sys-1",
        authorId: "system",
        authorName: "System Warning",
        authorType: "system",
        content: "Budget exceeded: swarm paused.",
        sequenceNumber: 3,
        timestamp: new Date(3000),
      }),
      sysmsgRow({
        id: "usr-1",
        authorId: "u1",
        authorName: "User",
        authorType: "user",
        content: "hello",
        sequenceNumber: 2,
        timestamp: new Date(2000),
      }),
      sysmsgRow({ id: "agt-1", content: "final answer", sequenceNumber: 1, timestamp: new Date(1000) }),
    ]);

    const page = await getChannelMessagesPage(SYSMSG_CHANNEL, { limit: 10, db });

    // Whole-object assertion: the merged read shape is exactly the row plus
    // the derived `type`, newest-first on the wire.
    expect(page.messages).toEqual([
      {
        id: "sys-1",
        type: "system",
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "1",
        authorType: "system",
        content: "Budget exceeded: swarm paused.",
        channelId: SYSMSG_CHANNEL,
        timestamp: new Date(3000),
        sequenceNumber: 3,
        mentions: [],
        metadata: undefined,
      },
      {
        id: "usr-1",
        type: "human",
        authorId: "u1",
        authorName: "User",
        authorLevel: "1",
        authorType: "user",
        content: "hello",
        channelId: SYSMSG_CHANNEL,
        timestamp: new Date(2000),
        sequenceNumber: 2,
        mentions: [],
        metadata: undefined,
      },
      {
        id: "agt-1",
        type: "agent",
        authorId: "agent-1",
        authorName: "Agent One",
        authorLevel: "1",
        authorType: "agent",
        content: "final answer",
        channelId: SYSMSG_CHANNEL,
        timestamp: new Date(1000),
        sequenceNumber: 1,
        mentions: [],
        metadata: undefined,
      },
    ]);
    expect(page.cursor).toBeNull();
  });
});

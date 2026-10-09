import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { messageGate } from "./message-gate.js";
import { appendJsonl, setLocalStoreDirForTests } from "../shared/core/local-file.js";

const WORKSPACE_ID = "ws-thread-page-local";
const CHANNEL_ID = "channel-thread-page-local";
const THREAD_ID = "thread-page-local";
let storeDir: string;

function threadMessage(id: string, timestamp: string, sequenceNumber: number, threadId: string | null) {
  return {
    id,
    channelId: CHANNEL_ID,
    threadId,
    workspaceId: WORKSPACE_ID,
    authorId: "author-1",
    authorName: "Author",
    authorLevel: "1",
    authorType: "user",
    content: id,
    mentions: [],
    metadata: null,
    toolCalls: null,
    isInternalMonologue: false,
    sequenceNumber,
    timestamp,
  };
}

function revived(row: ReturnType<typeof threadMessage>) {
  return { ...row, timestamp: new Date(row.timestamp) };
}

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "thread-page-local-"));
  setLocalStoreDirForTests(storeDir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(storeDir, { recursive: true, force: true });
});

describe("messageGate.getThreadPage Local pagination", () => {
  it("filters thread replies before applying the page limit and probe", async () => {
    const rows = [
      threadMessage("reply-1", "2026-01-01T00:00:01.000Z", 1, THREAD_ID),
      threadMessage("channel-2", "2026-01-01T00:00:02.000Z", 2, null),
      threadMessage("channel-3", "2026-01-01T00:00:03.000Z", 3, null),
      threadMessage("channel-4", "2026-01-01T00:00:04.000Z", 4, null),
      threadMessage("reply-2", "2026-01-01T00:00:05.000Z", 2, THREAD_ID),
      threadMessage("channel-6", "2026-01-01T00:00:06.000Z", 6, null),
      threadMessage("channel-7", "2026-01-01T00:00:07.000Z", 7, null),
      threadMessage("channel-8", "2026-01-01T00:00:08.000Z", 8, null),
      threadMessage("reply-3", "2026-01-01T00:00:09.000Z", 3, THREAD_ID),
    ];
    for (const row of rows) await appendJsonl(CHANNEL_ID, row, WORKSPACE_ID);

    const page1 = await messageGate.getThreadPage(THREAD_ID, {
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      limit: 1,
    });
    const page2 = await messageGate.getThreadPage(THREAD_ID, {
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      limit: 1,
      before: { timestamp: new Date(rows[8].timestamp), seq: rows[8].sequenceNumber },
    });
    const page3 = await messageGate.getThreadPage(THREAD_ID, {
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      limit: 1,
      before: { timestamp: new Date(rows[4].timestamp), seq: rows[4].sequenceNumber },
    });

    expect([page1, page2, page3]).toEqual([
      { messages: [revived(rows[8])], nextCursor: `${rows[8].timestamp};${rows[8].sequenceNumber}` },
      { messages: [revived(rows[4])], nextCursor: `${rows[4].timestamp};${rows[4].sequenceNumber}` },
      { messages: [revived(rows[0])], nextCursor: null },
    ]);
  });
});

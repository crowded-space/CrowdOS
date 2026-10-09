import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { appendJsonl, readJsonl, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { messageGate } from "./message-gate.js";

const dirs: string[] = [];
const timestamp = "2026-10-09T00:00:00.000Z";

afterEach(() => {
  setLocalStoreDirForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localFileStore() {
  const dir = mkdtempSync(join(tmpdir(), "crowdos-msg-detach-"));
  dirs.push(dir);
  setLocalStoreDirForTests(dir);
}

function row(id: string, channelId: string, threadId: string | null, workspaceId: string) {
  return {
    id, channelId, threadId, workspaceId, authorId: "u1", authorName: "User", authorLevel: "1",
    authorType: "user", content: id, mentions: [], metadata: null, toolCalls: null,
    isInternalMonologue: false, sequenceNumber: 1, timestamp,
  };
}

describe("MSG-032 · detach thread replies", () => {
  it("clears only replies in the specified channel and workspace Local log", async () => {
    localFileStore();
    await appendJsonl("detach-channel", row("reply-1", "detach-channel", "thread-1", "ws-one"), "ws-one");
    await appendJsonl("detach-channel", row("reply-2", "detach-channel", "thread-1", "ws-one"), "ws-one");
    await appendJsonl("detach-channel", row("other-thread", "detach-channel", "thread-2", "ws-one"), "ws-one");
    await appendJsonl("detach-channel", row("other-workspace", "detach-channel", "thread-1", "ws-two"), "ws-two");
    await appendJsonl("other-channel", row("other-channel-reply", "other-channel", "thread-1", "ws-one"), "ws-one");

    const detached = await messageGate.detachThreadReplies("thread-1", {
      channelId: "detach-channel",
      workspaceId: "ws-one",
    });

    expect(detached).toBe(2);
    expect(await readJsonl("detach-channel", "ws-one")).toEqual([
      { ...row("reply-1", "detach-channel", null, "ws-one"), sequenceNumber: 1 },
      { ...row("reply-2", "detach-channel", null, "ws-one"), sequenceNumber: 1 },
      row("other-thread", "detach-channel", "thread-2", "ws-one"),
    ]);
    expect(await readJsonl("detach-channel", "ws-two")).toEqual([
      row("other-workspace", "detach-channel", "thread-1", "ws-two"),
    ]);
    expect(await readJsonl("other-channel", "ws-one")).toEqual([
      row("other-channel-reply", "other-channel", "thread-1", "ws-one"),
    ]);
  });

  it("pins explicit DB updates to the requested thread, channel, and workspace", async () => {
    let where: unknown;
    const db = {
      update: () => ({
        set: () => ({
          where: (condition: unknown) => {
            where = condition;
            return { returning: async () => [{ id: "reply-1" }, { id: "reply-2" }] };
          },
        }),
      }),
    };

    const detached = await messageGate.detachThreadReplies("thread-1", {
      channelId: "detach-channel",
      workspaceId: "ws-one",
      db,
    });
    const query = new PgDialect().sqlToQuery(where as any);

    expect(detached).toBe(2);
    expect(query.sql).toContain('"thread_id"');
    expect(query.sql).toContain('"channel_id"');
    expect(query.sql).toContain('"workspace_id"');
    expect(query.params).toEqual(expect.arrayContaining(["thread-1", "detach-channel", "ws-one"]));
  });
});

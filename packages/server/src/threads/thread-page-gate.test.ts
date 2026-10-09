// THR-015 regression: the thread message page is a Messages-owned gate port.
//
// thread-service.ts used to reach into ../messages/message-local-store
// directly for the local-tier thread message-page read (check-gates flagged
// it). The read now goes through messageGate.getThreadPage, whose RAW shape
// keeps threadId — the merged channel-page shape drops it, so the port must
// not reuse that lossy shape.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { channelGate } from "../channels/channel-gate.js";
import { messageGate } from "../messages/message-gate.js";
import { threadGate } from "./thread-gate.js";

const SRC = fileURLToPath(new URL("..", import.meta.url)); // packages/server/src

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-thr015-"));
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function seedThreadWithReplies(workspaceId: string) {
  const cat = await channelGate.createCategory({ name: "General", workspaceId, createdBy: "test" });
  const ch = await channelGate.create(
    { name: "general", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
    undefined,
    workspaceId,
  );
  const channelId = (ch as any).channel?.id ?? (ch as any).id;
  const created = await threadGate.create({ channelId, createdBy: "test" });
  const threadId = (created as any).thread.id as string;
  for (const content of ["reply 1", "reply 2", "reply 3"]) {
    await messageGate.append({
      channelId,
      threadId,
      authorId: "u1",
      authorName: "User",
      authorLevel: "stakeholder",
      authorType: "user",
      content,
    });
  }
  return { channelId, threadId };
}

describe("THR-015 thread message page via the Messages gate port", () => {
  it("serves the local-tier page through messageGate.getThreadPage and keeps threadId", async () => {
    const { channelId, threadId } = await seedThreadWithReplies("ws-thr015");

    // Via the Threads gate (the switched call path): paged, oldest-first within
    // the page, cursor only while more rows remain.
    const page = (await threadGate.getMessages(threadId, { limit: 2 })) as any;
    expect(page.error).toBeUndefined();
    expect(page.messages.map((m: any) => m.content)).toEqual(["reply 2", "reply 3"]);
    // Raw shape: every row keeps its threadId (the merged channel page drops it).
    expect(page.messages.every((m: any) => m.threadId === threadId)).toBe(true);
    expect(page.nextCursor).toBeTruthy();

    const page2 = (await threadGate.getMessages(threadId, { limit: 2, before: page.nextCursor })) as any;
    expect(page2.messages.map((m: any) => m.content)).toEqual(["reply 1"]);
    expect(page2.messages.every((m: any) => m.threadId === threadId)).toBe(true);
    expect(page2.nextCursor).toBe(null);

    // The port is Messages-owned and directly callable by other domains.
    const direct = (await messageGate.getThreadPage(threadId, {
      channelId,
      workspaceId: "ws-thr015",
      limit: 10,
    })) as any;
    expect(direct.messages).toHaveLength(3);
    expect(direct.messages.every((m: any) => m.threadId === threadId)).toBe(true);
  });

  it("thread-service no longer imports message-local-store (gate lint regression)", () => {
    const src = readFileSync(join(SRC, "threads", "thread-service.ts"), "utf8");
    // The module specifier, not prose: a bare comment mention stays allowed.
    expect(src).not.toContain("message-local-store.js");
    expect(src).toContain("messageGate.getThreadPage");
  });
});

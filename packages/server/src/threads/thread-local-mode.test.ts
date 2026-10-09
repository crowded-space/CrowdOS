// THR-003: thread local tier works with no DATABASE_URL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readJsonl, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { channelGate } from "../channels/channel-gate.js";
import { messageGate } from "../messages/message-gate.js";
import * as threadLocalStore from "./thread-local-store.js";
import { localUpsertThread } from "./thread-local-store.js";
import { threadGate } from "./thread-gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-threads-local-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

async function createChannelsBeyondFirstPage(workspaceId: string) {
  let lastChannel: any;
  for (let position = 0; position <= 200; position += 1) {
    const result = await channelGate.create({
      name: `page-channel-${position}`,
      type: "standard",
      createdBy: "test",
      position,
    } as any, undefined, workspaceId);
    lastChannel = (result as any).channel;
    if (!lastChannel) throw new Error(`Could not create channel at position ${position}`);
  }

  const firstPage = await channelGate.list({ limit: 200, workspaceId });
  const last = firstPage[firstPage.length - 1] as any;
  const cursor = `${last.position}:${last.id}`;
  const secondPage = await channelGate.list({ limit: 200, cursor, workspaceId });
  expect(firstPage).toHaveLength(200);
  expect(secondPage.map((row: any) => row.id)).toEqual([lastChannel.id]);
  return lastChannel as { id: string };
}

describe("THR-003 thread local tier (no DATABASE_URL)", () => {
  it("does not expose default-scope threads when a workspace-scoped channel lookup misses", async () => {
    const channelId = "ch_missing_from_workspace";
    const timestamp = new Date("2026-10-09T00:00:00.000Z");
    const defaultThread = {
      id: "thr_default_scope",
      channelId,
      parentMessageId: null,
      rootMessageId: null,
      title: "default only",
      createdBy: "test",
      isEphemeral: false,
      status: "active",
      expiresAt: null,
      archivedAt: null,
      messageCount: 0,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspaceId: null,
    };
    await localUpsertThread(defaultThread, null);

    expect(await threadGate.list(channelId, { includeArchived: true })).toEqual([defaultThread]);
    expect(await threadGate.list(channelId, { includeArchived: true }, { workspaceId: "ws-local" })).toEqual([]);
  });

  it("applies keyset and numeric cursors to Local thread listings", async () => {
    const context = { workspaceId: "ws-local-cursors" };
    const cat = await channelGate.createCategory({ name: "Cursors", workspaceId: context.workspaceId, createdBy: "test" });
    const createdChannel = await channelGate.create(
      { name: "cursor-channel", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
      undefined,
      context.workspaceId,
    );
    const channelId = (createdChannel as any).channel?.id ?? (createdChannel as any).id;
    const lastActivityAt = new Date("2026-10-09T12:00:00.000Z");
    const rows = ["thr_z", "thr_m", "thr_a"].map((id) => ({
      id,
      channelId,
      parentMessageId: null,
      rootMessageId: null,
      title: null,
      createdBy: "test",
      isEphemeral: false,
      status: "active",
      expiresAt: null,
      archivedAt: null,
      messageCount: 0,
      lastActivityAt,
      createdAt: lastActivityAt,
      updatedAt: lastActivityAt,
      workspaceId: context.workspaceId,
    }));
    for (const row of rows) await localUpsertThread(row, context.workspaceId);

    const keysetPage = await threadGate.list(
      channelId,
      { limit: 1, cursor: `${lastActivityAt.toISOString()};thr_m` },
      context,
    );
    const offsetPage = await threadGate.list(channelId, { limit: 1, cursor: "1" }, context);

    expect(keysetPage.map((thread: any) => thread.id)).toEqual(["thr_a"]);
    expect(offsetPage.map((thread: any) => thread.id)).toEqual(["thr_m"]);
  });

  it("rejects a channel outside the caller's local workspace instead of writing to default scope", async () => {
    const cat = await channelGate.createCategory({ name: "Other", workspaceId: "ws-other", createdBy: "test" });
    const ch = await channelGate.create(
      { name: "other-channel", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
      undefined,
      "ws-other",
    );
    const channelId = (ch as any).channel?.id ?? (ch as any).id;

    const result = await threadGate.create(
      { channelId, createdBy: "test" },
      { workspaceId: "ws-local" },
    );

    expect(result).toEqual({ error: "channel_not_found" });
    expect(await threadGate.list(channelId, { includeArchived: true })).toEqual([]);
  });

  it("validates Local thread parents through Messages with exact channel scope", async () => {
    const context = { workspaceId: "ws-local-parent-validation" };
    const first = await channelGate.create({ name: "parent-first", createdBy: "test" } as any, undefined, context.workspaceId);
    const second = await channelGate.create({ name: "parent-second", createdBy: "test" } as any, undefined, context.workspaceId);
    const firstChannelId = (first as any).channel?.id ?? (first as any).id;
    const secondChannelId = (second as any).channel?.id ?? (second as any).id;
    const parent = await messageGate.append({
      channelId: firstChannelId,
      workspaceId: context.workspaceId,
      authorId: "u1",
      authorName: "User",
      authorLevel: "1",
      authorType: "user",
      content: "parent",
    });

    expect(await threadGate.create({
      channelId: firstChannelId,
      parentMessageId: "missing-parent",
      createdBy: "test",
    }, context)).toEqual({ error: "parent_not_found" });
    expect(await threadGate.create({
      channelId: secondChannelId,
      parentMessageId: parent.id,
      createdBy: "test",
    }, context)).toEqual({ error: "parent_not_found" });

    const created = await threadGate.create({
      channelId: firstChannelId,
      parentMessageId: parent.id,
      createdBy: "test",
    }, context) as any;
    const duplicate = await threadGate.create({
      channelId: firstChannelId,
      parentMessageId: parent.id,
      createdBy: "test",
    }, context) as any;
    expect(duplicate.thread.id).toBe(created.thread.id);
    expect(duplicate.created).toBe(false);
  });

  it("propagates channel page failures while resolving a Local channel scope", async () => {
    const context = { workspaceId: "ws-create-channel-page-failure" };
    const failure = new Error("channel page failed during create");
    const listSpy = vi.spyOn(channelGate, "list").mockRejectedValue(failure);

    try {
      await expect(threadGate.create({ channelId: "ch_missing", createdBy: "test" }, context)).rejects.toBe(failure);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("propagates channel page failures while resolving a Local thread scope", async () => {
    const context = { workspaceId: "ws-get-channel-page-failure" };
    const failure = new Error("channel page failed during get");
    const listSpy = vi.spyOn(channelGate, "list").mockRejectedValue(failure);

    try {
      await expect(threadGate.get("thr_missing", context)).rejects.toBe(failure);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("propagates Local thread-store read failures while resolving a Local thread scope", async () => {
    const context = { workspaceId: "ws-get-thread-store-failure" };
    const channel = await channelGate.create({ name: "thread-store-failure", createdBy: "test" } as any, undefined, context.workspaceId);
    const channelId = (channel as any).channel?.id ?? (channel as any).id;
    const failure = new Error("thread store read failed during get");
    const getSpy = vi.spyOn(threadLocalStore, "localGetThread").mockRejectedValue(failure);

    try {
      await expect(threadGate.get("thr_missing", context)).rejects.toBe(failure);
    } finally {
      getSpy.mockRestore();
    }
    expect(channelId).toBeTruthy();
  });

  it("keeps missing Local channels and threads as expected results", async () => {
    const context = { workspaceId: "ws-missing-local-results" };

    expect(await threadGate.create({ channelId: "ch_missing", createdBy: "test" }, context)).toEqual({ error: "channel_not_found" });
    expect(await threadGate.get("thr_missing", context)).toBeUndefined();
  });

  it("resolves Local threads when their channel is beyond the first channel page", async () => {
    const context = { workspaceId: "ws-late-thread" };
    const channel = await createChannelsBeyondFirstPage(context.workspaceId);
    const created = await threadGate.create({ channelId: channel.id, createdBy: "test" }, context) as any;
    const thread = created.thread;

    expect(created).toMatchObject({ thread: { channelId: channel.id } });
    expect(await threadGate.list(channel.id, { includeArchived: true }, context)).toEqual([thread]);
    expect(await threadGate.get(thread.id, context)).toEqual(thread);

    await threadGate.incrementCount(thread.id, context);
    expect(await threadGate.get(thread.id, context)).toMatchObject({ id: thread.id, messageCount: 1 });
  }, 15_000);

  it("sweeps expired Local threads on channels beyond the first channel page", async () => {
    const context = { workspaceId: "ws-late-expiry" };
    const channel = await createChannelsBeyondFirstPage(context.workspaceId);
    const expiredAt = new Date(Date.now() - 60_000);
    const thread = {
      id: "thr_late_expired",
      channelId: channel.id,
      parentMessageId: null,
      rootMessageId: null,
      title: null,
      createdBy: "test",
      isEphemeral: true,
      status: "active",
      expiresAt: expiredAt,
      archivedAt: null,
      messageCount: 0,
      lastActivityAt: expiredAt,
      createdAt: expiredAt,
      updatedAt: expiredAt,
      workspaceId: context.workspaceId,
    };
    await localUpsertThread(thread, context.workspaceId);

    expect(await threadGate.archiveExpired(context)).toBe(1);
    expect(await threadGate.get(thread.id, context)).toMatchObject({
      id: thread.id,
      channelId: channel.id,
      status: "expired",
      workspaceId: context.workspaceId,
    });
  }, 15_000);

  it("propagates channel page failures from a Local expiry sweep", async () => {
    const context = { workspaceId: "ws-expiry-channel-failure" };
    const failure = new Error("channel page failed");
    const listSpy = vi.spyOn(channelGate, "list").mockRejectedValue(failure);

    try {
      await expect(threadGate.archiveExpired(context)).rejects.toBe(failure);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("propagates Local store write failures from an expiry sweep", async () => {
    const context = { workspaceId: "ws-expiry-store-failure" };
    const channel = await channelGate.create({ name: "expiry-store-failure", createdBy: "test" } as any, undefined, context.workspaceId);
    const channelId = (channel as any).channel?.id ?? (channel as any).id;
    const expiredAt = new Date(Date.now() - 60_000);
    await localUpsertThread({
      id: "thr_expiry_store_failure",
      channelId,
      parentMessageId: null,
      rootMessageId: null,
      title: null,
      createdBy: "test",
      isEphemeral: true,
      status: "active",
      expiresAt: expiredAt,
      archivedAt: null,
      messageCount: 0,
      lastActivityAt: expiredAt,
      createdAt: expiredAt,
      updatedAt: expiredAt,
      workspaceId: context.workspaceId,
    }, context.workspaceId);
    const failure = new Error("thread store write failed");
    const upsertSpy = vi.spyOn(threadLocalStore, "localUpsertThread").mockRejectedValue(failure);

    try {
      await expect(threadGate.archiveExpired(context)).rejects.toBe(failure);
    } finally {
      upsertSpy.mockRestore();
    }
  });

  it("creates, lists, updates, and messages a thread locally", async () => {
    const context = { workspaceId: "ws-local" };
    const cat = await channelGate.createCategory({ name: "General", workspaceId: "ws-local", createdBy: "test" });
    const ch = await channelGate.create({ name: "general", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any, undefined, "ws-local");
    const channelId = (ch as any).channel?.id ?? (ch as any).id;
    expect(channelId).toBeTruthy();

    const created = await threadGate.create({ channelId, createdBy: "test" }, context);
    expect((created as any).thread?.id).toMatch(/^thr_/);

    const listed = await threadGate.list(channelId, undefined, context);
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.length).toBe(1);

    const id = (created as any).thread.id;
    const updated = await threadGate.update(id, { title: "hello" }, context);
    expect((updated as any).thread?.title).toBe("hello");

    // active->expired is allowed; expired->active (resurrection) is not.
    await threadGate.update(id, { status: "expired" }, context);
    const illegal = await threadGate.update(id, { status: "active" }, context);
    expect((illegal as any).error).toBe("illegal_transition");

    const archived = await threadGate.update(id, { status: "archived" }, context);
    expect((archived as any).thread?.status).toBe("archived");
  });

  it("preserves Local replies as channel messages when deleting their thread", async () => {
    const context = { workspaceId: "ws-local-delete-thread" };
    const category = await channelGate.createCategory({ name: "Delete", workspaceId: context.workspaceId, createdBy: "test" });
    const createdChannel = await channelGate.create(
      { name: "delete-thread", createdBy: "test", categoryId: (category as any).id ?? (category as any).category?.id } as any,
      undefined,
      context.workspaceId,
    );
    const channelId = (createdChannel as any).channel?.id ?? (createdChannel as any).id;
    const created = await threadGate.create({ channelId, createdBy: "test" }, context) as any;
    const threadId = created.thread.id as string;

    const reply = await messageGate.append({
      channelId,
      threadId,
      workspaceId: context.workspaceId,
      authorId: "u1",
      authorName: "User",
      authorLevel: "1",
      authorType: "user",
      content: "survives deletion",
    });

    expect(await threadGate.delete(threadId, context)).toEqual({ deleted: true });
    expect(await threadGate.get(threadId, context)).toBeUndefined();
    expect(await readJsonl(channelId, context.workspaceId)).toEqual([
      expect.objectContaining({ id: reply.id, content: "survives deletion", threadId: null }),
    ]);
    const page = await messageGate.getChannelMessagesPage(channelId, { limit: 10 });
    expect(page.messages).toEqual([expect.objectContaining({
      id: reply.id,
      content: "survives deletion",
    })]);
  });

  // THR-003 completeness: get-by-id and the thread message page must serve the
  // local store too (get used to fall through to the PG branch and throw
  // DATABASE_URL-not-set in DB-less mode).
  it("serves get and getMessages from the local tier", async () => {
    const context = { workspaceId: "ws-local" };
    const cat = await channelGate.createCategory({ name: "General", workspaceId: "ws-local", createdBy: "test" });
    const ch = await channelGate.create(
      { name: "general", createdBy: "test", categoryId: (cat as any).id ?? (cat as any).category?.id } as any,
      undefined,
      "ws-local",
    );
    const channelId = (ch as any).channel?.id ?? (ch as any).id;
    const created = await threadGate.create({ channelId, createdBy: "test" }, context);
    const id = (created as any).thread.id as string;

    const got = await threadGate.get(id, context);
    expect((got as any)?.id).toBe(id);
    expect((got as any)?.channelId).toBe(channelId);

    await messageGate.append({
      channelId,
      threadId: id,
      authorId: "u1",
      authorName: "User",
      authorLevel: "stakeholder",
      authorType: "user",
      content: "local reply",
    });
    const page = await threadGate.getMessages(id, { limit: 10 }, context);
    expect((page as any).error).toBeUndefined();
    expect((page as any).messages).toHaveLength(1);
    expect((page as any).messages[0].content).toBe("local reply");
  });
});

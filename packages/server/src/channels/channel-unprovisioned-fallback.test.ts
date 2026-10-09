// Stale-BYODB fallback: a tenant PG handle whose schema was never provisioned
// (missing relations, 42P01/42703) degrades to the local tier instead of 500.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { isSchemaMismatchError, withStoreFallback, resolveTier, isUrlReachable } from "../shared/config/database.js";
import { channelGate } from "./channel-gate.js";
import { messageGate } from "../messages/message-gate.js";

const missingTable = (rel: string) =>
  Object.assign(new Error(`relation "${rel}" does not exist`), { code: "42P01" });
// drizzle wraps the driver error: SQLSTATE lives on `cause`.
const wrapped = (rel: string) =>
  Object.assign(new Error(`Failed query: select from "${rel}"`), { cause: missingTable(rel) });
const throwingHandle = (rel: string) => ({
  query: new Proxy({}, { get: () => ({ findFirst: async () => { throw wrapped(rel); }, findMany: async () => { throw wrapped(rel); } }) }),
  delete: () => ({ where: () => ({ returning: async () => { throw wrapped(rel); } }) }),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-unprovisioned-"));
  setLocalStoreDirForTests(dir);
  return () => { setLocalStoreDirForTests(null); rmSync(dir, { recursive: true, force: true }); };
});

describe("isSchemaMismatchError", () => {
  it("matches 42P01/42703 top-level and nested in cause", () => {
    expect(isSchemaMismatchError(missingTable("messages"))).toBe(true);
    expect(isSchemaMismatchError(wrapped("channels"))).toBe(true);
    expect(isSchemaMismatchError(Object.assign(new Error("x"), { code: "42703" }))).toBe(true);
  });
  it("rejects connection errors, plain errors, and non-objects", () => {
    expect(isSchemaMismatchError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isSchemaMismatchError(new Error("boom"))).toBe(false);
    expect(isSchemaMismatchError(null)).toBe(false);
    expect(isSchemaMismatchError("42P01")).toBe(false);
  });
});

describe("unprovisioned tenant handle falls back to local", () => {
  it("lists, gets, and deletes channels locally", async () => {
    const ws = "ws-unprov-" + Date.now();
    const cat: any = await channelGate.createCategory({ name: "General", workspaceId: ws, createdBy: "t", position: 0 });
    const created: any = await channelGate.create({ name: "general", type: "standard", createdBy: "t", categoryId: cat.id, position: 0 } as any, undefined, ws);
    const id = created.channel.id as string;
    const bad = throwingHandle("channels");
    const list: any[] = await channelGate.list({ workspaceId: ws, db: bad });
    expect(list.map((r) => r.id)).toContain(id);
    const got: any = await channelGate.get(id, bad);
    expect(got?.id).toBe(id);
    const del: any = await channelGate.remove(id, bad);
    expect(del?.deleted).toBe(true);
    expect(await channelGate.get(id)).toBeNull();
  });

  it("serves the message page locally", async () => {
    const ws = "ws-unprov-msg-" + Date.now();
    const cat: any = await channelGate.createCategory({ name: "General", workspaceId: ws, createdBy: "t", position: 0 });
    const created: any = await channelGate.create({ name: "chat", type: "standard", createdBy: "t", categoryId: cat.id, position: 0 } as any, undefined, ws);
    const id = created.channel.id as string;
    await messageGate.append({ channelId: id, authorId: "u1", authorName: "U", authorType: "user", content: "hello", workspaceId: ws } as any);
    const page: any = await messageGate.getChannelMessagesPage(id, { db: throwingHandle("messages") });
    expect(page.messages.length).toBeGreaterThan(0);
  });

  it("withStoreFallback degrades the PG gap-fill and marks the outage window", async () => {
    const url = "postgres://stale-unprov:5432/nodb";
    // Local tier is empty, so the PG gap-fill runs, hits the missing relation,
    // and the call degrades to the (empty) local value while marking the URL.
    const out = await withStoreFallback({ databaseUrl: url }, async () => { throw wrapped("messages"); }, async () => null);
    expect(out).toBeNull();
    expect(isUrlReachable(url)).toBe(false);
    expect(resolveTier({ databaseUrl: url }).tier).toBe("local");
  });
});

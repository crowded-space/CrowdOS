// C3 local-first: channel/category/message/agent file stores work with no PG.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { localStoreDirsForTests, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

// True no-DB simulation: unset the import-time env singleton so the REAL tier
// resolution (not a mock predicate) takes the local path. Restored afterwards.
// NOTE: mocking database.js predicates does NOT affect dualWrite internals —
// ES live bindings resolve to the real module scope.
const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { channelGate } from "./channel-gate.js";
import { messageGate } from "../messages/message-gate.js";
import { agentRegistry } from "../agents/agent-service.js";
import { localSeedDefaultAgent } from "../agents/agent-local-store.js";
import { resolveChannelMount } from "../channel-mounts/channel-mount-service.js";

let dir: string;

function seedLocalChannelRows(workspaceId: string, rows: any[]): void {
  const { crowdos } = localStoreDirsForTests(workspaceId);
  mkdirSync(crowdos, { recursive: true });
  writeFileSync(join(crowdos, "channels.json"), JSON.stringify(rows), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-localmode-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("C3 slice 2 · local workspace chat primitives (no DATABASE_URL)", () => {
  it("seeds category + channel + agent and resolves the default agent", async () => {
    const cat = await channelGate.createCategory({
      name: "General", workspaceId: "ws-local", createdBy: "system", position: 0,
    });
    expect(cat.id).toBeTruthy();
    const created = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
      undefined,
      "ws-local",
    );
    expect("channel" in created).toBe(true);

    const agent = await localSeedDefaultAgent();
    expect(agent.name).toBe("default-assistant");
    expect(agent.status).toBe("idle");

    // Seed is idempotent.
    const again = await localSeedDefaultAgent();
    expect(again.id).toBe(agent.id);

    const roster = await agentRegistry.list({ isTemplate: false });
    expect(roster.map((a) => a.name)).toContain("default-assistant");
  });

  it("appends messages with gap-free sequences and pages newest-first", async () => {
    const cat = await channelGate.createCategory({
      name: "General", workspaceId: "ws-local", createdBy: "system", position: 0,
    });
    const created = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
    );
    const channelId = (created as any).channel.id;

    for (let i = 1; i <= 3; i++) {
      const msg = await messageGate.append({
        channelId, authorId: "user-1", authorName: "Tester", authorLevel: "stakeholder",
        authorType: "user", content: `hello ${i}`,
      });
      expect(msg.sequenceNumber).toBe(i);
    }

    const page = await messageGate.getChannelMessagesPage(channelId, { limit: 2 });
    expect(page.messages).toHaveLength(2);
    expect(page.cursor).not.toBeNull();
    const older = await messageGate.getChannelMessagesPage(channelId, {
      limit: 2,
      before: { timestamp: new Date(page.cursor!.before.timestamp), seq: page.cursor!.before.seq },
    });
    expect(older.messages).toHaveLength(1);
    expect(older.cursor).toBeNull();
  });

  it("agent status flips survive a re-read (local setStatus)", async () => {
    const agent = await localSeedDefaultAgent();
    await agentRegistry.setStatus(agent.id, "working", {});
    expect((await agentRegistry.getById(agent.id))?.status).toBe("working");
    await agentRegistry.setStatus(agent.id, "idle", {});
    expect((await agentRegistry.getById(agent.id))?.status).toBe("idle");
  });

  it("category delete cascades to its channels (PG parity)", async () => {
    const cat = await channelGate.createCategory({
      name: "Temp", workspaceId: "ws-local", createdBy: "system", position: 0,
    });
    await channelGate.create(
      { name: "tempchan", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
    );
    expect(await channelGate.removeCategory(cat.id)).toBe(true);
    expect(await channelGate.list()).toHaveLength(0);
  });

  it("mount resolution honors channel replace semantics on clamped fs", async () => {
    const cat = await channelGate.createCategory({
      name: "General", workspaceId: "ws-local", createdBy: "system", position: 0,
    });
    const created = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: cat.id, position: 0 } as any,
      undefined,
      "ws-local",
    );
    const channelId = (created as any).channel.id;
    const mount = await resolveChannelMount(channelId);
    // No folderPath anywhere and no registry workspace row: honest none.
    expect(mount.source).toBe("none");
    expect(mount.workspaceId).toBe("ws-local");
  });

  it("duplicate-name guard is workspace-scoped and list honors the tenant scope", async () => {
    // Regression (2026-09-25 audit): the dup check scanned ALL workspaces, so
    // a null-category channel named "general" in ws-a blocked creating one in
    // ws-b, and an unscoped list served another workspace's channels.
    const first = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-a",
    );
    expect("channel" in first).toBe(true);

    const second = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-b",
    );
    expect("channel" in second).toBe(true);

    // Same workspace + same name still collides.
    const third = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-a",
    );
    expect((third as any).error).toBe("duplicate_name");

    const scopedA = await channelGate.list({ workspaceId: "ws-a" });
    expect(scopedA).toHaveLength(1);
    const scopedB = await channelGate.list({ workspaceId: "ws-b" });
    expect(scopedB).toHaveLength(1);
  });
});

describe("channel list cursor pagination", () => {
  it("continues keyset pages after more than 200 local channels and keeps numeric offsets", async () => {
    const workspaceId = "ws-channel-pages";
    const created = Array.from({ length: 400 }, (_, position) => ({
      id: `local-page-${String(position).padStart(3, "0")}`,
      categoryId: null,
      workspaceId,
      folderPath: null,
      name: `page-${position}`,
      type: "standard",
      createdBy: "system",
      position,
      createdAt: new Date(0).toISOString(),
      archivedAt: null,
      archivedReason: null,
    }));
    seedLocalChannelRows(workspaceId, created);

    const project = (rows: any[]) => rows.map(({ id, name, position }) => ({ id, name, position }));
    const firstPage = await channelGate.list({ limit: 200, workspaceId });
    expect(project(firstPage)).toEqual(project(created.slice(0, 200)));

    const last = created[199];
    const secondPage = await channelGate.list({
      limit: 200,
      cursor: `${last.position}:${last.id}`,
      workspaceId,
    });
    expect(project(secondPage)).toEqual(project(created.slice(200, 400)));

    const offsetPage = await channelGate.list({ limit: 100, cursor: "250", workspaceId });
    expect(project(offsetPage)).toEqual(project(created.slice(250, 350)));

    await expect(channelGate.list({ limit: 100, cursor: "10001", workspaceId })).rejects.toThrow(
      "Numeric channel offsets are limited to 10000",
    );
  });
});

// ─── Guard-parity regressions (fix-channels 2026-10-07) ─────────────────
describe("guard parity: rename / case / archived / category / seed", () => {
  it("rename-into-existing is rejected; rename-to-same-name is allowed (CHN-001)", async () => {
    await channelGate.create(
      { name: "alpha", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-r",
    );
    const beta = await channelGate.create(
      { name: "beta", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-r",
    );
    const betaId = (beta as any).channel.id;

    const clash = await channelGate.update(betaId, { name: "alpha" } as any);
    expect((clash as any).error).toBe("duplicate_name");

    const same = await channelGate.update(betaId, { name: "beta" } as any);
    expect((same as any).channel?.name).toBe("beta");
  });

  it("case-variant duplicate is rejected (CHN-002)", async () => {
    await channelGate.create(
      { name: "General", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-case",
    );
    const dup = await channelGate.create(
      { name: "general", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-case",
    );
    expect((dup as any).error).toBe("duplicate_name");
  });

  it("archived names are reusable: archive then recreate succeeds (CHN-003, local tier)", async () => {
    const first = await channelGate.create(
      { name: "temp", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-arch",
    );
    await channelGate.update((first as any).channel.id, { type: "archived" } as any);
    // Archived rows stay hidden from listings...
    expect(await channelGate.list({ workspaceId: "ws-arch" })).toHaveLength(0);
    // ...and the name is free again on the local tier.
    const again = await channelGate.create(
      { name: "temp", type: "standard", createdBy: "system", categoryId: null, position: 0 } as any,
      undefined,
      "ws-arch",
    );
    expect("channel" in again).toBe(true);
  });

  it("duplicate category create returns a union instead of throwing (CHN-006/006b)", async () => {
    await channelGate.createCategory({ name: "General", workspaceId: "ws-cat", createdBy: "system" });
    const dup = await channelGate.createCategory({ name: "general", workspaceId: "ws-cat", createdBy: "system" });
    expect((dup as any).error).toBe("duplicate_name");
  });

  it("concurrent duplicate category creates leave exactly one row (CHN-006)", async () => {
    // The dup check runs INSIDE the mutate lock, so the second racer sees the
    // first row and loses with a union instead of pushing a duplicate.
    const results = await Promise.all([
      channelGate.createCategory({ name: "Race", workspaceId: "ws-race", createdBy: "system" }),
      channelGate.createCategory({ name: "Race", workspaceId: "ws-race", createdBy: "system" }),
    ]);
    const ok = results.filter((r: any) => !("error" in r));
    const dupes = results.filter((r: any) => (r as any).error === "duplicate_name");
    expect(ok).toHaveLength(1);
    expect(dupes).toHaveLength(1);
  });

  it("a cross-workspace parent category is rejected (CHN-007)", async () => {
    const catB = await channelGate.createCategory({ name: "Foreign", workspaceId: "ws-b", createdBy: "system" });
    const res = await channelGate.create(
      { name: "leak", type: "standard", createdBy: "system", categoryId: catB.id, position: 0 } as any,
      undefined,
      "ws-a",
    );
    expect((res as any).error).toBe("category");
  });

  it("seedLocalPresets creates General/#general and is idempotent (CHN-020 gate port)", async () => {
    const seeded = await channelGate.seedLocalPresets("ws-seed");
    expect(seeded.category.name).toBe("General");
    expect(seeded.channel.name).toBe("general");
    const again = await channelGate.seedLocalPresets("ws-seed");
    expect(again.category.id).toBe(seeded.category.id);
    expect(again.channel.id).toBe(seeded.channel.id);
  });
});

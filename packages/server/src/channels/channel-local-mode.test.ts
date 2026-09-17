// C3 local-first: channel/category/message/agent file stores work with no PG.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config/database.js")>();
  return { ...actual, isDatabaseConfigured: () => false };
});

import { channelGate } from "./channel-gate.js";
import { messageGate } from "../messages/message-gate.js";
import { agentRegistry } from "../agents/agent-service.js";
import { localSeedDefaultAgent } from "../agents/agent-local-store.js";
import { resolveChannelMount } from "../channel-mounts/channel-mount-service.js";

let dir: string;

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
});

// §6-8 channel pins: local round-trip through the gate with no DATABASE_URL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

import { channelGate } from "./channel-gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-settings-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("Channel settings pins (§6-8, local-first)", () => {
  it("returns null when nothing is pinned", async () => {
    expect(await channelGate.getSettings("chan-missing")).toBeNull();
  });

  it("upserts and reads back pins", async () => {
    const first = await channelGate.updateSettings("chan-1", {
      pinnedRuntime: "coding",
      activeAgentId: "agent-owl",
      defaultAgentId: "agent-raven",
    });
    expect("settings" in first).toBe(true);
    const got = await channelGate.getSettings("chan-1");
    expect(got).toMatchObject({ pinnedRuntime: "coding", activeAgentId: "agent-owl", defaultAgentId: "agent-raven" });
  });

  it("patches one pin and clears with null", async () => {
    await channelGate.updateSettings("chan-1", { pinnedRuntime: "coding" });
    await channelGate.updateSettings("chan-1", { activeAgentId: "agent-owl" });
    const patched = await channelGate.getSettings("chan-1");
    expect(patched).toMatchObject({ pinnedRuntime: "coding", activeAgentId: "agent-owl", defaultAgentId: null });
    await channelGate.updateSettings("chan-1", { pinnedRuntime: null });
    expect((await channelGate.getSettings("chan-1"))?.pinnedRuntime).toBeNull();
  });

  it("rejects an unknown pinned runtime", async () => {
    const res = await channelGate.updateSettings("chan-1", { pinnedRuntime: "swarm-ultimate" });
    expect("error" in res).toBe(true);
  });
});

describe("§30 channel settings are workspace-scoped", () => {
  it("two workspaces with the same channel id keep independent settings", async () => {
    // Same channel id, two workspaces — the exact collision a channelId-only
    // key could not represent (PK is now (channelId, workspaceId)).
    await channelGate.updateSettings(
      "ch-general",
      { pinnedRuntime: "coding", activeAgentId: "agent-owl" },
      undefined,
      "ws-a",
    );
    await channelGate.updateSettings(
      "ch-general",
      { pinnedRuntime: "research", activeAgentId: "agent-raven" },
      undefined,
      "ws-b",
    );

    const a = await channelGate.getSettings("ch-general", undefined, "ws-a");
    const b = await channelGate.getSettings("ch-general", undefined, "ws-b");

    expect(a).toMatchObject({ channelId: "ch-general", workspaceId: "ws-a", pinnedRuntime: "coding", activeAgentId: "agent-owl" });
    expect(b).toMatchObject({ channelId: "ch-general", workspaceId: "ws-b", pinnedRuntime: "research", activeAgentId: "agent-raven" });
  });

  it("a workspace-scoped write never leaks into another workspace", async () => {
    await channelGate.updateSettings("ch-x", { pinnedRuntime: "coding" }, undefined, "ws-a");
    // Workspace B has no row for this channel yet.
    expect(await channelGate.getSettings("ch-x", undefined, "ws-b")).toBeNull();
    // Clearing in A does not touch B (B has nothing to clear) and A is cleared.
    await channelGate.updateSettings("ch-x", { pinnedRuntime: null }, undefined, "ws-a");
    expect((await channelGate.getSettings("ch-x", undefined, "ws-a"))?.pinnedRuntime).toBeNull();
  });

  it("defaults to the documented unscoped scope when none is given", async () => {
    // No explicit scope and no resolvable channel row (local mode, no DB) →
    // the "default" placeholder, so the legacy call shape keeps working.
    await channelGate.updateSettings("ch-orphan", { pinnedRuntime: "agentic" });
    const row = await channelGate.getSettings("ch-orphan");
    expect(row).toMatchObject({ channelId: "ch-orphan", workspaceId: "default", pinnedRuntime: "agentic" });
  });
});

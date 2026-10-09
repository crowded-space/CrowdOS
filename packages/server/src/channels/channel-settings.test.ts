// §6-8 channel pins: local round-trip through the gate with no DATABASE_URL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(row).toMatchObject({ channelId: "ch-orphan", workspaceId: "default", pinnedRuntime: "agentic" }); // gate permissive; route enforces CHN-012
    
  });
});

// CHN-011: an explicit db handle pins PG first (was: local won even with an
// override, unlike every other op). Local stays the fallback.
describe("CHN-011: db override pins PG first for settings reads", () => {
  it("returns the PG row over an existing local row", async () => {
    await channelGate.updateSettings("ch-db", { pinnedRuntime: "coding" }, undefined, "ws-db");
    const fakeDb = {
      query: {
        channelSettings: {
          findFirst: async () => ({
            channelId: "ch-db", workspaceId: "ws-db", pinnedRuntime: "research",
            activeAgentId: null, defaultAgentId: null, updatedAt: new Date(),
          }),
        },
      },
    };
    const got = await channelGate.getSettings("ch-db", fakeDb, "ws-db");
    expect(got?.pinnedRuntime).toBe("research");
  });

  it("falls back to the local row when the handle has no PG row", async () => {
    await channelGate.updateSettings("ch-db2", { pinnedRuntime: "coding" }, undefined, "ws-db");
    const fakeDb = { query: { channelSettings: { findFirst: async () => null } } };
    const got = await channelGate.getSettings("ch-db2", fakeDb, "ws-db");
    expect(got?.pinnedRuntime).toBe("coding");
  });
});

// CHN-010: an unresolved scope degrades to the documented default LOUDLY
// (was: silent misfiling), so operators can see the fallback in logs.
describe("CHN-010: unresolved scope warns before falling back to default", () => {
  it("emits the scope warning once when the channel row is unresolvable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await channelGate.updateSettings("ch-no-row", { pinnedRuntime: "coding" });
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => m.includes("settings scope") && m.includes("ch-no-row") && m.includes("default"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

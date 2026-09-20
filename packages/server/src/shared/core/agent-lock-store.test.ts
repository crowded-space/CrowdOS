// §12 / §30 durable + workspace-scoped agent locks.
// Proves the four properties the in-process Map could not hold:
//   (a) lockIn survives a simulated restart (fresh module graph, same disk),
//   (b) lockOut removes the lock durably,
//   (c) two DIFFERENT workspaces sharing the SAME channel id never see each
//       other's locks, and
//   (d) clearAll stays workspace-scoped and durable.
//
// The store dir is set through CROWDOS_LOCALSTORE_DIR (read at call time)
// rather than setLocalStoreDirForTests, because vi.resetModules() — the
// simulated restart — resets the module-level test override with it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let prevLocalStoreDir: string | undefined;

/**
 * Channel -> workspace fixture. The lock store resolves a channel's workspace
 * through the Channels gate, so the test fakes the gate module before importing
 * the store (vi.resetModules gives a fresh module graph = simulated restart).
 */
const channelWorkspace = new Map<string, string | null>();

vi.mock("../../channels/channel-gate.js", () => ({
  channelGate: {
    get: async (id: string) => {
      if (!channelWorkspace.has(id)) return null;
      return { id, workspaceId: channelWorkspace.get(id) };
    },
  },
}));

/** Fresh module graph = simulated process restart; disk is the only carry-over. */
async function freshStore() {
  vi.resetModules();
  return import("./agent-lock-store.js");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-locks-"));
  prevLocalStoreDir = process.env.CROWDOS_LOCALSTORE_DIR;
  process.env.CROWDOS_LOCALSTORE_DIR = dir;
  channelWorkspace.clear();
});

afterEach(() => {
  if (prevLocalStoreDir === undefined) delete process.env.CROWDOS_LOCALSTORE_DIR;
  else process.env.CROWDOS_LOCALSTORE_DIR = prevLocalStoreDir;
  channelWorkspace.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe("§12 durable agent locks (file-backed, workspace-scoped)", () => {
  it("(a) lockIn survives a simulated restart", async () => {
    channelWorkspace.set("ch-shared", "ws-a");

    const first = await freshStore();
    await first.agentLockStore.lockIn("agent-owl", "ch-shared");
    expect(await first.agentLockStore.isLockedIn("agent-owl", "ch-shared")).toBe(true);

    // Simulated restart: brand-new module instance, same localstore dir.
    const second = await freshStore();
    expect(await second.agentLockStore.isLockedIn("agent-owl", "ch-shared")).toBe(true);
    expect(await second.agentLockStore.getLockedChannelsForAgent("agent-owl", "ws-a")).toEqual(["ch-shared"]);
  });

  it("(b) lockOut removes the lock durably", async () => {
    channelWorkspace.set("ch-shared", "ws-a");
    const first = await freshStore();
    await first.agentLockStore.lockIn("agent-owl", "ch-shared");
    await first.agentLockStore.lockOut("agent-owl", "ch-shared");
    expect(await first.agentLockStore.isLockedIn("agent-owl", "ch-shared")).toBe(false);

    const second = await freshStore();
    expect(await second.agentLockStore.isLockedIn("agent-owl", "ch-shared")).toBe(false);
    expect(await second.agentLockStore.getLockedChannelsForAgent("agent-owl", "ws-a")).toEqual([]);
  });

  it("(c) the same channel id in two workspaces does not leak locks", async () => {
    // Workspace A owns a channel literally named "ch-shared".
    channelWorkspace.set("ch-shared", "ws-a");
    const storeA = (await freshStore()).agentLockStore;
    await storeA.lockIn("agent-owl", "ch-shared");
    expect(await storeA.isLockedIn("agent-owl", "ch-shared")).toBe(true);

    // Same channel id now resolves to workspace B — its scope file is distinct.
    channelWorkspace.set("ch-shared", "ws-b");
    const storeB = (await freshStore()).agentLockStore;
    expect(await storeB.isLockedIn("agent-owl", "ch-shared")).toBe(false);
    expect(await storeB.getLockedChannelsForAgent("agent-owl", "ws-b")).toEqual([]);
    // Workspace A's lock row is still on disk, untouched by workspace B.
    expect(readFileSync(join(dir, "locks", "ws-a", "locks.json"), "utf8")).toContain("ch-shared:agent-owl");
    // Workspace B never wrote a lock file at all (a read-only scope creates
    // nothing) — the strongest possible form of "no leak".
    expect(existsSync(join(dir, "locks", "ws-b", "locks.json"))).toBe(false);
  });

  it("(d) clearAll is workspace-scoped and durable", async () => {
    channelWorkspace.set("ch-a", "ws-a");
    channelWorkspace.set("ch-b", "ws-b");
    const store = (await freshStore()).agentLockStore;
    await store.lockIn("agent-owl", "ch-a");
    await store.lockIn("agent-raven", "ch-b");

    await store.clearAll("ws-a");
    expect(await store.getLockedChannelsForAgent("agent-owl", "ws-a")).toEqual([]);
    // Workspace B is unaffected by workspace A's clear.
    expect(await store.isLockedIn("agent-raven", "ch-b")).toBe(true);

    const restarted = (await freshStore()).agentLockStore;
    expect(await restarted.getLockedChannelsForAgent("agent-owl", "ws-a")).toEqual([]);
    expect(await restarted.isLockedIn("agent-raven", "ch-b")).toBe(true);
  });

  it("unresolvable channels fall back to the documented unscoped scope", async () => {
    // No channelWorkspace entry: the gate returns null (unknown channel).
    const mod = await freshStore();
    await mod.agentLockStore.lockIn("agent-owl", "ch-unknown");
    expect(await mod.agentLockStore.scopeForChannel("ch-unknown")).toBe(mod.UNSCOPED_WORKSPACE);
    expect(await mod.agentLockStore.isLockedIn("agent-owl", "ch-unknown")).toBe(true);
    expect(await mod.agentLockStore.getLockedChannelsForAgent("agent-owl", mod.UNSCOPED_WORKSPACE)).toEqual(["ch-unknown"]);
    expect(readFileSync(join(dir, "locks", "__unscoped__", "locks.json"), "utf8")).toContain("ch-unknown:agent-owl");
  });

  it("one lock file per workspace, keyed <channelId>:<agentId>", async () => {
    channelWorkspace.set("ch-1", "ws-a");
    const mod = await freshStore();
    await mod.agentLockStore.lockIn("agent-owl", "ch-1");
    await mod.agentLockStore.lockIn("agent-raven", "ch-1");
    const raw = JSON.parse(readFileSync(mod.agentLockStore.pathForWorkspace("ws-a"), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["ch-1:agent-owl", "ch-1:agent-raven"]);
    expect(raw["ch-1:agent-owl"].locked).toBe(true);
    expect(typeof raw["ch-1:agent-owl"].lockedAt).toBe("string");
    const rows = await mod.agentLockStore.listAll("ws-a");
    expect(rows.map((r) => r.agentId).sort()).toEqual(["agent-owl", "agent-raven"]);
  });
});

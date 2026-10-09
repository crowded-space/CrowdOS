import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { isTestStoreDir, setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { channelGate } from "../channels/channel-gate.js";
import { maintenanceProcessor } from "./maintenance-worker.js";
import { threadGate } from "../threads/thread-gate.js";

let storeDir: string;
const prevDatabaseUrl = env.DATABASE_URL;
const prevWorkspaceDir = process.env.WORKSPACE_DIR;
const prevRegistryFile = process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;

function stamp() {
  return new Date().toISOString();
}

function record(id: string) {
  return {
    id, name: id, icon: "x", databaseUrl: "", rootPath: join(storeDir, id),
    screenLockPinHash: null, createdAt: stamp(), updatedAt: stamp(),
  };
}

function expireLocalThread(workspaceId: string, channelId: string, threadId: string) {
  const file = join(storeDir, workspaceId, "vfs", ".crowdos", "threads", channelId + ".json");
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.id === threadId);
    if (!row) {
      const files = existsSync(join(storeDir, workspaceId, "vfs", ".crowdos", "threads"))
        ? "present" : "missing";
      throw new Error("thread row missing; threads dir " + files);
    }
  row.expiresAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, JSON.stringify(rows, null, 2));
}

beforeAll(() => {
  storeDir = mkdtempSync(join(tmpdir(), "crowdos-mixed-expire-"));
  process.env.WORKSPACE_DIR = storeDir;
  process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = join(storeDir, "workspaces.json");
  setLocalStoreDirForTests(storeDir);
  setRegistryFilePathForTests(join(storeDir, "workspaces.json"));
  // Mixed-mode trigger only: the URL value is never dialed because the test
  // stubs every database seam it exercises.
  process.env.DATABASE_URL = "postgresql://mixed-mode:5432/main";
  (env as any).DATABASE_URL = process.env.DATABASE_URL;
});

afterAll(() => {
  setLocalStoreDirForTests(null);
  setRegistryFilePathForTests(null);
  if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = prevWorkspaceDir;
  if (prevRegistryFile === undefined) delete process.env.CROWDOS_WORKSPACE_REGISTRY_FILE;
  else process.env.CROWDOS_WORKSPACE_REGISTRY_FILE = prevRegistryFile;
  (env as any).DATABASE_URL = prevDatabaseUrl;
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;
  rmSync(storeDir, { recursive: true, force: true });
});

describe("thread-expire mixed-mode sweep", () => {
  it("sweeps a local-only workspace while the ambient database exists", { timeout: 20_000 }, async () => {
    const ws = "ws-mixed-local";
    writeFileSync(
      join(storeDir, "workspaces.json"),
      JSON.stringify({ workspaces: [record(ws)] }),
    );
    const cat: any = await channelGate.createCategory({ name: "General", workspaceId: ws, createdBy: "t" });
    mkdirSync(join(storeDir, ws, "vfs", ".crowdos", "threads"), { recursive: true });
    const created: any = await channelGate.create(
      { name: "general", createdBy: "t", categoryId: cat.id ?? cat.category?.id, position: 0 } as any,
      undefined, ws,
    );
    const channelId = (created.channel?.id ?? created.id) as string;
    const thread: any = await threadGate.create({ channelId, createdBy: "t", isEphemeral: true, ttlHours: 1 }, { workspaceId: ws });
    expireLocalThread(ws, channelId, thread.thread.id);

    // The ambient pool points at an unreachable mixed-mode URL, so fail only
    // the ambient handle; tier resolution and the registry-backed local-only
    // workspace stay real, and the sweep must still reach that workspace.
    expect(isTestStoreDir()).toBe(true);
    const workspace = await import("../workspace/workspace-gate.js");
    const database = await import("../shared/config/database.js");
    const fanout = vi.spyOn(workspace, "forEachWorkspaceDb").mockResolvedValue(undefined);
    const ambientDb = vi.spyOn(database, "getDb").mockImplementation(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    });
    const threads = await import("../threads/thread-gate.js");
    const sweepSpy = vi.spyOn(threads.threadGate, "archiveExpired");
    try {
      await expect(
        maintenanceProcessor({ name: "thread-expire", data: { kind: "thread-expire" } } as never),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(fanout).toHaveBeenCalled();
      const scopes = sweepSpy.mock.calls.map((call) => (call[0] as any)?.workspaceId ?? null);
      expect(scopes).toContain(ws);
      expect(await threadGate.get(thread.thread.id, { workspaceId: ws })).toMatchObject({ status: "expired" });
    } finally {
      fanout.mockRestore();
      ambientDb.mockRestore();
      sweepSpy.mockRestore();
    }
  });
});

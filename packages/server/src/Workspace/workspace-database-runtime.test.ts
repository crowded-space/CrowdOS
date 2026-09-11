import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const endMocks: Array<ReturnType<typeof vi.fn>> = [];
const factoryMock = vi.fn((url: string) => {
  const end = vi.fn(async () => {});
  endMocks.push(end);
  // Minimal postgres-js client surface: drizzle() reads .options at wrap time.
  return { url, end, options: { parsers: {}, serializers: {} } };
});

vi.mock("postgres", () => ({
  default: (url: string) => factoryMock(url),
}));

import {
  closeAllWorkspaceDatabases,
  closeWorkspaceDatabase,
  forEachWorkspaceDb,
  getWorkspaceDb,
  getWorkspaceDbPoolStats,
  __resetWorkspaceDbPoolsForTests,
} from "./workspace-database-runtime.js";
import { clearWorkspaceEnvCache, readWorkspaceDatabaseUrl } from "./workspace-database.js";
import { setRegistryFilePathForTests } from "./workspace-registry.js";

const GLOBAL_URL = "postgresql://global:u@localhost:5432/main";

beforeEach(() => {
  __resetWorkspaceDbPoolsForTests();
  factoryMock.mockClear();
  endMocks.length = 0;
  process.env.DATABASE_URL = GLOBAL_URL;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CROWDOS_WS_")) delete process.env[key];
  }
  delete process.env.CROWDOS_WS_DB_MAX_POOLS;
  delete process.env.CROWDOS_WS_DB_IDLE_MS;
});

afterEach(() => {
  __resetWorkspaceDbPoolsForTests();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CROWDOS_WS_")) delete process.env[key];
  }
  delete process.env.CROWDOS_WS_DB_MAX_POOLS;
  delete process.env.CROWDOS_WS_DB_IDLE_MS;
});

describe("getWorkspaceDb", () => {
  it("falls back to the global pool without an id", async () => {
    const resolved = await getWorkspaceDb(null);
    expect(resolved.source).toBe("global");
    expect(resolved.workspaceId).toBeNull();
    expect(getWorkspaceDbPoolStats()).toEqual([]);
  });

  it("falls back to global when the workspace has no URL", async () => {
    const resolved = await getWorkspaceDb("ws_nodb");
    expect(resolved.source).toBe("global");
    expect(factoryMock).not.toHaveBeenCalled();
  });

  it("opens a workspace pool and reuses it", async () => {
    process.env.CROWDOS_WS_WS_A1_DATABASE_URL = "postgresql://w:pw@wshost:5433/wdb";
    const first = await getWorkspaceDb("ws_a1");
    const second = await getWorkspaceDb("ws_a1");
    expect(first.source).toBe("workspace");
    expect(second.db).toBe(first.db);
    expect(factoryMock).toHaveBeenCalledTimes(1);
    expect(factoryMock).toHaveBeenCalledWith(expect.stringContaining("@wshost:5433/wdb"));
  });

  it("rotates the pool when the URL changes", async () => {
    process.env.CROWDOS_WS_WS_A1_DATABASE_URL = "postgresql://w:pw@wshost/db1";
    const first = await getWorkspaceDb("ws_a1");
    process.env.CROWDOS_WS_WS_A1_DATABASE_URL = "postgresql://w:pw@wshost/db2";
    const second = await getWorkspaceDb("ws_a1");
    expect(second.db).not.toBe(first.db);
    expect(factoryMock).toHaveBeenCalledTimes(2);
    expect(endMocks[0]).toHaveBeenCalled();
  });

  it("closes a single pool and closes all pools", async () => {
    process.env.CROWDOS_WS_WS_A1_DATABASE_URL = "postgresql://w:pw@h1/db";
    process.env.CROWDOS_WS_WS_B2_DATABASE_URL = "postgresql://w:pw@h2/db";
    await getWorkspaceDb("ws_a1");
    await getWorkspaceDb("ws_b2");
    expect(getWorkspaceDbPoolStats()).toHaveLength(2);

    await closeWorkspaceDatabase("ws_a1");
    expect(getWorkspaceDbPoolStats().map((s) => s.workspaceId)).toEqual(["ws_b2"]);

    await closeAllWorkspaceDatabases();
    expect(getWorkspaceDbPoolStats()).toEqual([]);
    expect(endMocks.every((m) => m.mock.calls.length >= 1)).toBe(true);
  });

  it("evicts the least-recently-used pool at the cap", async () => {
    process.env.CROWDOS_WS_DB_MAX_POOLS = "2";
    process.env.CROWDOS_WS_WS_1_DATABASE_URL = "postgresql://w:pw@h1/db";
    process.env.CROWDOS_WS_WS_2_DATABASE_URL = "postgresql://w:pw@h2/db";
    process.env.CROWDOS_WS_WS_3_DATABASE_URL = "postgresql://w:pw@h3/db";
    await getWorkspaceDb("ws_1");
    await getWorkspaceDb("ws_2");
    await getWorkspaceDb("ws_3");
    const ids = getWorkspaceDbPoolStats().map((s) => s.workspaceId).sort();
    expect(ids).toEqual(["ws_2", "ws_3"]);
  });

  it("exposes no secrets in pool stats", async () => {
    process.env.CROWDOS_WS_WS_A1_DATABASE_URL = "postgresql://w:s3cret-pw@h/db";
    await getWorkspaceDb("ws_a1");
    expect(JSON.stringify(getWorkspaceDbPoolStats())).not.toContain("s3cret");
  });
});

describe("readWorkspaceDatabaseUrl", () => {
  it("prefers process.env and reads the .env from disk otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsread-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, 'CROWDOS_WS_WS_D1_DATABASE_URL="postgresql://u:p@diskhost/diskdb"\n');

    expect(await readWorkspaceDatabaseUrl("ws_d1", { envPath })).toBe("postgresql://u:p@diskhost/diskdb");

    process.env.CROWDOS_WS_WS_D1_DATABASE_URL = "postgresql://u:p@envhost/envdb";
    expect(await readWorkspaceDatabaseUrl("ws_d1", { envPath })).toBe("postgresql://u:p@envhost/envdb");
    delete process.env.CROWDOS_WS_WS_D1_DATABASE_URL;
  });

  it("picks up rewrites via the mtime cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsread-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, 'CROWDOS_WS_WS_D2_DATABASE_URL="postgresql://u:p@host-one/db"\n');
    expect(await readWorkspaceDatabaseUrl("ws_d2", { envPath })).toContain("host-one");

    writeFileSync(envPath, 'CROWDOS_WS_WS_D2_DATABASE_URL="postgresql://u:p@host-two-longer/db"\n');
    clearWorkspaceEnvCache(envPath);
    expect(await readWorkspaceDatabaseUrl("ws_d2", { envPath })).toContain("host-two-longer");
  });

  it("returns null when nothing is assigned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsread-"));
    expect(await readWorkspaceDatabaseUrl("ws_missing", { envPath: join(dir, ".env") })).toBeNull();
  });
});

describe("forEachWorkspaceDb", () => {
  const stamp = () => new Date().toISOString();
  function writeRegistry(dir: string, records: Array<Record<string, unknown>>) {
    const file = join(dir, "workspaces.json");
    writeFileSync(file, JSON.stringify({ workspaces: records }));
    setRegistryFilePathForTests(file);
  }
  function record(id: string, databaseUrl: string): Record<string, unknown> {
    return { id, name: id, icon: "x", databaseUrl, rootPath: join(tmpdir(), id), screenLockPinHash: null, createdAt: stamp(), updatedAt: stamp() };
  }

  afterEach(() => {
    setRegistryFilePathForTests(null);
  });

  it("visits global plus every configured workspace, skipping dead ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsforeach-"));
    writeRegistry(dir, [
      record("ws_f1", "postgresql://u:p@h1/db1"),
      record("ws_f2", "postgresql://u:p@h2/db2"),
      record("ws_f3", ""),
    ]);
    const visited: Array<string | null> = [];
    await forEachWorkspaceDb(async (_db, workspaceId) => {
      if (workspaceId === "ws_f1") throw new Error("dead db");
      visited.push(workspaceId);
    });
    // Global first, dead ws_f1 skipped without stopping ws_f2, empty URL skipped.
    expect(visited[0]).toBeNull();
    expect(visited).toContain("ws_f2");
    expect(visited).not.toContain("ws_f1");
    expect(visited).not.toContain("ws_f3");
  });
});

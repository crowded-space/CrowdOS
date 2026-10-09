import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeWorkspaceDatabaseUrl,
  parseWorkspaceDatabaseUrl,
  provisionWorkspaceDatabase,
  removeWorkspaceDatabaseEnv,
  upsertWorkspaceDatabaseEnv,
  withProvisionLock,
  workspaceDatabaseEnvKey,
  WORKSPACE_RESET_DROP_TABLES,
} from "./workspace-database.js";
import { setRegistryFilePathForTests, tierContextFor } from "./workspace-registry.js";
import { resolveTier } from "../shared/config/database.js";

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// WS-003: the flush drop-list must cover every table the migrations create.
// A hardcoded list that drifts leaves tables behind, so re-provision fails
// with "relation already exists" and memory rows survive a flush.
describe("WORKSPACE_RESET_DROP_TABLES coverage (WS-003)", () => {
  it("covers every CREATE TABLE in db/migrations (journal-drift guard)", () => {
    const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
    const created = new Set<string>();
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([a-z_]+)"/g)) {
        created.add(match[1]);
      }
      // A migration may drop a table again (0011/0019) — that is fine to drop.
      for (const match of sql.matchAll(/DROP TABLE IF EXISTS "([a-z_]+)"/g)) {
        created.delete(match[1]);
      }
    }
    const missing = [...created].filter((t) => !WORKSPACE_RESET_DROP_TABLES.includes(t));
    expect(missing).toEqual([]);
    // The journal itself must be reset so the next provision re-runs 0000.
    expect(WORKSPACE_RESET_DROP_TABLES).toContain("__drizzle_migrations");
  });
});

// WS-004: a record whose dbSync state is conflict is attached to an unrelated
// database. tierContextFor must resolve it local-only so resolveTier never
// yields "dual" and the write path's replica leg is never entered (no PG insert).
describe("tierContextFor conflict quarantine (WS-004)", () => {
  let regDir: string;
  let regFile: string;

  const baseRecord = {
    id: "ws_conflict01",
    name: "Conflict WS",
    icon: "💼",
    databaseUrl: "postgresql://u:p@unrelated-host:5432/other",
    rootPath: ".",
    screenLockPinHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    regDir = mkdtempSync(join(tmpdir(), "crowdos-wsreg-"));
    regFile = join(regDir, "workspaces.json");
    setRegistryFilePathForTests(regFile);
  });

  afterEach(() => {
    setRegistryFilePathForTests(null);
    rmSync(regDir, { recursive: true, force: true });
  });

  function writeRegistry(record: Record<string, unknown>) {
    writeFileSync(regFile, JSON.stringify({ workspaces: [record] }), "utf8");
  }

  it("resolves a conflict-state record to the local tier (replica leg never entered)", async () => {
    writeRegistry({
      ...baseRecord,
      dbSync: { dbWorkspaceId: "ws_unrelated", state: "conflict", updatedAt: "2026-01-02T00:00:00.000Z" },
    });
    const ctx = await tierContextFor("ws_conflict01");
    expect(ctx.storagePreference).toBe("local");
    expect(ctx.databaseUrl ?? null).toBeNull();
    const { tier, url } = resolveTier(ctx);
    expect(tier).toBe("local");
    expect(url).toBeNull();
  });

  it("keeps a paired record dual (the quarantine is conflict-specific)", async () => {
    writeRegistry({
      ...baseRecord,
      dbSync: { dbWorkspaceId: "ws_conflict01", state: "paired", updatedAt: "2026-01-02T00:00:00.000Z" },
    });
    const ctx = await tierContextFor("ws_conflict01");
    const { tier, url } = resolveTier(ctx);
    expect(tier).toBe("dual");
    expect(url).toBe(baseRecord.databaseUrl);
  });
});

describe("workspaceDatabaseEnvKey", () => {
  it("builds a stable, env-safe key", () => {
    expect(workspaceDatabaseEnvKey("ws_a1b2c3d4")).toBe("CROWDOS_WS_WS_A1B2C3D4_DATABASE_URL");
  });

  it("sanitizes hostile ids", () => {
    const key = workspaceDatabaseEnvKey("ws-1\nEVIL=1");
    expect(key).toMatch(/^CROWDOS_WS_[A-Z0-9_]+_DATABASE_URL$/);
    expect(key).not.toContain("\n");
  });
});

describe("parseWorkspaceDatabaseUrl", () => {
  it("accepts postgres urls and extracts the descriptor", () => {
    const parsed = parseWorkspaceDatabaseUrl("postgresql://alice:s3cret@db.internal:5433/appdb");
    expect(parsed.host).toBe("db.internal");
    expect(parsed.port).toBe(5433);
    expect(parsed.database).toBe("appdb");
  });

  it("rejects non-postgres schemes", () => {
    expect(() => parseWorkspaceDatabaseUrl("mysql://u:p@host/db")).toThrow(/postgres/);
  });

  it("rejects control characters (env injection)", () => {
    expect(() => parseWorkspaceDatabaseUrl("postgresql://u:p@host/db\nEVIL=1")).toThrow(/control/);
  });

  it("rejects empty values", () => {
    expect(() => parseWorkspaceDatabaseUrl("   ")).toThrow(/empty/);
  });
});

describe("describeWorkspaceDatabaseUrl", () => {
  it("keeps no secret material", () => {
    const descriptor = describeWorkspaceDatabaseUrl("postgresql://alice:s3cret@db.internal/appdb");
    expect(descriptor.configured).toBe(true);
    expect(descriptor.host).toBe("db.internal");
    expect(descriptor.schemaReady).toBe(false);
    expect(JSON.stringify(descriptor)).not.toContain("s3cret");
  });

  it("carries the provisioning hint", () => {
    expect(describeWorkspaceDatabaseUrl("postgresql://u:p@h/db", true).schemaReady).toBe(true);
  });
});

describe("provisionWorkspaceDatabase", () => {
  it("rejects malformed URLs before touching the network", async () => {
    await expect(provisionWorkspaceDatabase("not-a-url")).rejects.toThrow(/Invalid workspace database URL/);
    await expect(provisionWorkspaceDatabase("mysql://u:p@host/db")).rejects.toThrow(/postgres/);
  });
});

describe("withProvisionLock", () => {
  it("serializes concurrent provisions for the same database", async () => {
    const order: string[] = [];
    const url = "postgresql://u:p@samehost:5432/db";
    await Promise.all([
      withProvisionLock(url, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
      }),
      withProvisionLock(url, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("propagates errors without wedging later provisions", async () => {
    const url = "postgresql://u:p@flaky:5432/db";
    await expect(
      withProvisionLock(url, async () => {
        throw new Error("migrate boom");
      }),
    ).rejects.toThrow("migrate boom");
    let ran = false;
    await withProvisionLock(url, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("workspace .env persistence", () => {
  it("upserts, replaces, preserves siblings, and removes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsdb-"));
    const envPath = join(dir, ".env");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(envPath, 'PORT=12077\nDATABASE_URL=postgresql://keep:me@localhost:5432/main\n');

    const key = await upsertWorkspaceDatabaseEnv("ws_test01", "postgresql://u:p@host:5432/db1", { envPath });
    expect(key).toBe("CROWDOS_WS_WS_TEST01_DATABASE_URL");
    let content = readFileSync(envPath, "utf8");
    expect(content).toContain("DATABASE_URL=postgresql://keep:me@localhost:5432/main");
    expect(content).toContain(`${key}="postgresql://u:p@host:5432/db1"`);

    await upsertWorkspaceDatabaseEnv("ws_test01", "postgresql://u:p2@host:5432/db2", { envPath });
    content = readFileSync(envPath, "utf8");
    expect(content.match(new RegExp(`^${key}=`, "gm"))?.length).toBe(1);
    expect(content).not.toContain("db1");

    await removeWorkspaceDatabaseEnv("ws_test01", { envPath });
    content = readFileSync(envPath, "utf8");
    expect(content).not.toContain(key);
    expect(content).toContain("DATABASE_URL=postgresql://keep:me@localhost:5432/main");
  });

  it("quotes values that contain comment/expansion characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsdb-"));
    const envPath = join(dir, ".env");
    await upsertWorkspaceDatabaseEnv("ws_q1", "postgresql://u:p%23a%21ss@host/db", { envPath });
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain('CROWDOS_WS_WS_Q1_DATABASE_URL="postgresql://u:p%23a%21ss@host/db"');
  });

  it("serializes concurrent upserts without losing keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-wsdb-"));
    const envPath = join(dir, ".env");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(envPath, "PORT=12077\n");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertWorkspaceDatabaseEnv(`ws_race${i}`, `postgresql://u:p@host${i}/db`, { envPath }),
      ),
    );
    const content = readFileSync(envPath, "utf8");
    for (let i = 0; i < 8; i++) {
      expect(content).toContain(`CROWDOS_WS_WS_RACE${i}_DATABASE_URL=`);
    }
    expect(content).toContain("PORT=12077");
  });
});

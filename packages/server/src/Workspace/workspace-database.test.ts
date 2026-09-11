import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeWorkspaceDatabaseUrl,
  parseWorkspaceDatabaseUrl,
  provisionWorkspaceDatabase,
  removeWorkspaceDatabaseEnv,
  upsertWorkspaceDatabaseEnv,
  withProvisionLock,
  workspaceDatabaseEnvKey,
} from "./workspace-database.js";

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
    writeFileSync(envPath, 'PORT=3001\nDATABASE_URL=postgresql://keep:me@localhost:5432/main\n');

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
    writeFileSync(envPath, "PORT=3001\n");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertWorkspaceDatabaseEnv(`ws_race${i}`, `postgresql://u:p@host${i}/db`, { envPath }),
      ),
    );
    const content = readFileSync(envPath, "utf8");
    for (let i = 0; i < 8; i++) {
      expect(content).toContain(`CROWDOS_WS_WS_RACE${i}_DATABASE_URL=`);
    }
    expect(content).toContain("PORT=3001");
  });
});

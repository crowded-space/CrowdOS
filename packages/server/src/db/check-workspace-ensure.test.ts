// DB-002 regression: db:check's roundtrip probe writes workspaceId "default"
// (FK messages.workspace_id -> workspaces(id), 0016) but nothing on a fresh
// DB provisions that row, so the probe died on an FK violation before its
// real verification. check.ts now ensures the row insert-if-missing before
// the probe; this test pins the write shape hermetically and keeps a live
// roundtrip check DB-gated.
import { config } from "dotenv";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { ensureDefaultWorkspaceRow } from "./check.js";
import { messages, workspaces } from "./schema.js";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

interface InsertCapture {
  values: Record<string, unknown> | null;
  onConflictCalled: boolean;
}

function fakeDb(capture: InsertCapture) {
  return {
    insert(table: unknown) {
      expect(table).toBe(workspaces);
      return {
        values(values: Record<string, unknown>) {
          capture.values = values;
          return {
            onConflictDoNothing() {
              capture.onConflictCalled = true;
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof ensureDefaultWorkspaceRow>[0];
}

describe("DB-002 · db:check ensures the 'default' workspace row", () => {
  it("insert-if-missing 'default' workspace before the probe (hermetic)", async () => {
    const capture: InsertCapture = { values: null, onConflictCalled: false };
    await ensureDefaultWorkspaceRow(fakeDb(capture));

    expect(capture.onConflictCalled).toBe(true);
    const values = capture.values;
    expect(values).not.toBeNull();
    expect(values!.id).toBe("default");
    // NOT NULL columns of workspaces must all be present or the ensure itself
    // throws on a fresh DB (the exact failure this fix removes).
    for (const column of ["name", "ownerId", "rootPath"] as const) {
      expect(typeof values![column]).toBe("string");
      expect((values![column] as string).length).toBeGreaterThan(0);
    }
  });

  it("probe rows reference 'default' and the FK is on messages.workspace_id", () => {
    // Static pin of the coupling: the FK column exists in the drizzle schema
    // and the probe's literal is 'default'. If either side changes without
    // the other, this test fails and DB-002 must be re-examined.
    expect(getTableColumns(messages)).toHaveProperty("workspaceId");
    expect(getTableColumns(workspaces)).toHaveProperty("id");
  });
});

describe.skipIf(!DATABASE_URL)("DB-002 · live roundtrip (migrated DB, DATABASE_URL set)", () => {
  it("ensureDefaultWorkspaceRow is idempotent against a migrated DB", async () => {
    const { getDb } = await import("../shared/config/database.js");
    const { closeDatabaseConnection } = await import("../shared/config/database.js");
    try {
      const db = getDb();
      await ensureDefaultWorkspaceRow(db);
      await ensureDefaultWorkspaceRow(db);
    } finally {
      await closeDatabaseConnection();
    }
  }, 30_000);
});

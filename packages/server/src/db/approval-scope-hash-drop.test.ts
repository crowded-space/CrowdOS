// DB-004 regression: approval_requests.scope_hash + its index are dead
// (0012 added them; schema.ts / approval-repository.ts read only `scope`) and
// migration 0028 drops both. approval_grants.scope_hash is live and stays.
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { getTableColumns } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalGrants, approvalRequests } from "./schema.js";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const migrationSql = readFileSync(
  new URL("./migrations/0028_drop-approval-requests-scope-hash.sql", import.meta.url),
  "utf8",
);
const originalSql = readFileSync(
  new URL("./migrations/0012_workspace_mounts_threads_approvals.sql", import.meta.url),
  "utf8",
);

describe("DB-004 · dead approval_requests.scope_hash is dropped by 0028", () => {
  it("drizzle schema keeps only scope (no scopeHash) on approval_requests", () => {
    const columns = getTableColumns(approvalRequests);
    expect(columns).toHaveProperty("scope");
    expect(columns).not.toHaveProperty("scopeHash");
  });

  it("approval_grants.scope_hash (live, different table) is untouched", () => {
    expect(getTableColumns(approvalGrants)).toHaveProperty("scopeHash");
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n"))
      .join("\n");
    expect(statements).not.toMatch(/approval_grants/);
  });

  it("0028 drops the index then the column, both idempotently", () => {
    expect(migrationSql).toMatch(/DROP INDEX IF EXISTS "approval_requests_scope_hash_idx"/);
    expect(migrationSql).toMatch(/ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "scope_hash"/);
    expect(migrationSql.indexOf("DROP COLUMN")).toBeGreaterThan(migrationSql.indexOf("DROP INDEX"));
  });

  it("0012 stays frozen: original ADD COLUMN / INDEX pair still present", () => {
    expect(originalSql).toMatch(/ADD COLUMN IF NOT EXISTS "scope_hash" text/);
    expect(originalSql).toMatch(/CREATE INDEX IF NOT EXISTS "approval_requests_scope_hash_idx"/);
  });
});

describe.skipIf(!DATABASE_URL)("DB-004 · live DB checks (migrated, DATABASE_URL set)", () => {
  let client: ReturnType<typeof postgres> | null = null;
  let connectionError = "";

  beforeAll(async () => {
    client = postgres(DATABASE_URL, {
      prepare: false,
      max: 2,
      idle_timeout: 5,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      await client`select 1`;
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
    }
  }, 15_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("approval_requests has no scope_hash column / index after migrate; approval_grants keeps its own", async (ctx) => {
    if (connectionError) {
      console.warn(`[DB-004] Skipping live check: DATABASE_URL unreachable — ${connectionError}`);
      ctx.skip();
      return;
    }
    const columns = await client!`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'approval_requests'
    `;
    const names = columns.map((r) => r.column_name as string);
    expect(names).toContain("scope");
    expect(names).not.toContain("scope_hash");

    const indexes = await client!`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'approval_requests'
    `;
    expect(indexes.map((r) => r.indexname as string)).not.toContain("approval_requests_scope_hash_idx");

    const grants = await client!`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'approval_grants'
    `;
    expect(grants.map((r) => r.column_name as string)).toContain("scope_hash");
  });

  it("0028 statements are re-runnable (migration idempotency)", async (ctx) => {
    if (connectionError) {
      ctx.skip();
      return;
    }
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    // Apply twice inside a transaction, then roll back: proves re-runnability
    // without mutating the dev DB out-of-band from the migration journal.
    await client!
      .begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
        for (const statement of statements) await tx.unsafe(statement);
        throw new Error("__rollback_after_idempotency_check__");
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "__rollback_after_idempotency_check__") return;
        throw err;
      });
  });
});

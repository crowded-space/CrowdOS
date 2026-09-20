// §17 local-first truth direction (CrowdOS.md §17-18).
//
// The calibration audit flagged the absence of any test asserting the TRUTH
// DIRECTION of the persistence tier. These tests are that assertion: they pin
// which tier is written first, which tier is read first, and what happens to
// the caller when the replica leg fails.
//
// Method: spy on the PG tier and assert call order relative to the local tier,
// rather than asserting on incidental implementation details.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../core/local-file.js";
import { dualWrite, withStoreFallback } from "./database.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-truth-"));
  setLocalStoreDirForTests(dir);
});

afterEach(() => {
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("§17 write order - local is the commit point", () => {
  it("calls the local write BEFORE the PG replica write", async () => {
    const order: string[] = [];
    await dualWrite({
      ctx: { workspaceId: "ws-order", databaseUrl: "postgresql://u:p@h/db", storagePreference: "default" },
      entity: "channel",
      op: "upsert",
      id: "c-order",
      row: { id: "c-order" },
      pgWrite: async () => { order.push("pg"); },
      localWrite: async () => { order.push("local"); return "local-row" as any; },
    });
    expect(order).toEqual(["local", "pg"]);
  });

  it("returns the local result even when the replica leg throws (logic class)", async () => {
    const result = await dualWrite({
      ctx: { workspaceId: "ws-logic", databaseUrl: "postgresql://u:p@h/db", storagePreference: "default" },
      entity: "channel",
      op: "upsert",
      id: "c-logic",
      row: { id: "c-logic" },
      pgWrite: async () => { throw Object.assign(new Error("null value in column"), { code: "23502" }); },
      localWrite: async () => "committed-locally" as any,
    });
    expect(result).toBe("committed-locally");
  });

  it("never writes the replica when the local commit fails", async () => {
    const pgWrite = vi.fn(async () => {});
    await expect(
      dualWrite({
        ctx: { workspaceId: "ws-fail", databaseUrl: "postgresql://u:p@h/db", storagePreference: "default" },
        entity: "channel",
        op: "upsert",
        id: "c-fail",
        row: { id: "c-fail" },
        pgWrite,
        localWrite: async () => { throw new Error("ENOSPC: no space left on device"); },
      }),
    ).rejects.toThrow("ENOSPC");
    expect(pgWrite).not.toHaveBeenCalled();
  });
});

describe("§17 read order - local answers first, PG is a gap-filler", () => {
  const ctx = { workspaceId: "ws-read", databaseUrl: "postgresql://u:p@h/db", storagePreference: "default" };

  it("returns the local rows without consulting PG when local has content", async () => {
    const dbOp = vi.fn(async () => ["pg-row"]);
    const out = await withStoreFallback(ctx, dbOp, async () => ["local-row"]);
    expect(out).toEqual(["local-row"]);
    expect(dbOp).not.toHaveBeenCalled();
  });

  it("consults PG only when the local tier has no rows for the query", async () => {
    const dbOp = vi.fn(async () => ["pg-row"]);
    const out = await withStoreFallback(ctx, dbOp, async () => []);
    expect(out).toEqual(["pg-row"]);
    expect(dbOp).toHaveBeenCalledTimes(1);
  });

  it("does not write PG rows back into the local tier (pull stays explicit)", async () => {
    const localOp = vi.fn(async () => [] as unknown[]);
    await withStoreFallback(ctx, async () => ["pg-row"], localOp);
    // Exactly one local read, and no follow-up local write is possible through
    // this helper - convergence into the local tier is workspace-sync job.
    expect(localOp).toHaveBeenCalledTimes(1);
  });

  it("a local-tier throw is rescued by a successful PG read", async () => {
    const out = await withStoreFallback(ctx, async () => ["pg-row"], async () => { throw new Error("local store corrupt"); });
    expect(out).toEqual(["pg-row"]);
  });

  it("a local-tier throw with PG down surfaces the LOCAL error (truth tier wins)", async () => {
    await expect(
      withStoreFallback(
        ctx,
        async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
        async () => { throw new Error("local store corrupt"); },
      ),
    ).rejects.toThrow("local store corrupt");
  });

  it("a PG read failure degrades to the (empty) local answer, not an error", async () => {
    const out = await withStoreFallback(
      ctx,
      async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
      async () => [],
    );
    expect(out).toEqual([]);
  });

  it("forced-local tier never touches PG", async () => {
    const dbOp = vi.fn(async () => ["pg-row"]);
    const out = await withStoreFallback(
      { workspaceId: "ws-forced", databaseUrl: "postgresql://u:p@h/db", storagePreference: "local" },
      dbOp,
      async () => ["local-row"],
    );
    expect(out).toEqual(["local-row"]);
    expect(dbOp).not.toHaveBeenCalled();
  });
});

// ART-5 regression guard (fix-artifacts-micro-4-5).
// purgeExpired must delete in bounded batches (max 500 ids per statement)
// instead of one unbounded DELETE, so a large expired backlog cannot pin locks
// for an unbounded statement. Hermetic: the DB boundary is faked (select ids ->
// delete those ids); no DATABASE_URL or live PG needed.
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prevDatabaseUrl = process.env.DATABASE_URL;
  // Fallback for any real-module path: client construction is lazy, no I/O.
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/crowdos_artifacts_fix_test";
  return {
    prevDatabaseUrl,
    remaining: [] as string[],
    lastBatch: [] as string[],
    deleteBatchSizes: [] as number[],
  };
});

vi.mock("../shared/config/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/config/database.js")>();
  const fakeDb = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (n: number) => {
            h.lastBatch = h.remaining.slice(0, n);
            return h.lastBatch.map((id) => ({ id }));
          },
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: async (_cond: unknown) => {
        h.deleteBatchSizes.push(h.lastBatch.length);
        const gone = new Set(h.lastBatch);
        h.remaining = h.remaining.filter((id) => !gone.has(id));
        h.lastBatch = [];
        return [];
      },
    }),
  };
  return { ...actual, getDb: () => fakeDb };
});

import { artifactsGate } from "./artifacts-gate.js";

afterAll(() => {
  if (h.prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = h.prevDatabaseUrl;
});

describe("artifacts purge - ART-5 bounded batches", () => {
  it("drains a 1200-row backlog in <=500-id delete statements", async () => {
    h.remaining = Array.from({ length: 1200 }, (_, i) => "art_" + i);
    h.deleteBatchSizes = [];
    const purged = await artifactsGate.purgeExpired(new Date("2026-01-01"));
    expect(purged).toBe(1200);
    expect(h.remaining).toHaveLength(0);
    expect(h.deleteBatchSizes).toHaveLength(3);
    expect(h.deleteBatchSizes.every((n) => n > 0 && n <= 500)).toBe(true);
  });

  it("is a no-op when nothing is expired", async () => {
    h.remaining = [];
    h.deleteBatchSizes = [];
    const purged = await artifactsGate.purgeExpired(new Date("2026-01-01"));
    expect(purged).toBe(0);
    expect(h.deleteBatchSizes).toEqual([]);
  });
});

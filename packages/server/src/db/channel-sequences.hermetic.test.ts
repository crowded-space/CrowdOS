// DB-010: hermetic coverage for the channel-sequence allocator contract.
//
// The DB-2 concurrency suite (channel-sequences.concurrency.test.ts) needs a
// real DATABASE_URL and is skipped in checkouts without one, leaving the db
// area with zero executing tests locally. This file pins the pure contract
// without a database:
//   1. allocateSequence issues exactly ONE round trip (the atomic
//      INSERT ... ON CONFLICT DO UPDATE RETURNING upsert) — no SELECT-MAX+1.
//   2. The upsert seeds a legacy channel from MAX(messages.sequence_number)
//      and advances by the requested count.
//   3. bigint text results are converted to numbers (postgres-js returns
//      bigint as string; the Number() conversion is load-bearing for callers).
//   4. A returning-less result is a loud error, never a silent undefined.
//   5. local-first (C3): with no DATABASE_URL and no client, the file counter
//      is used and PG is never touched.
//
// The concurrency invariant itself (20 parallel allocations -> contiguous
// 1..20, zero 23505) stays integration-gated on DATABASE_URL in CI; this file
// covers what can be asserted hermetically, and test 5 runs in exactly the
// no-DATABASE_URL checkouts DB-010 describes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDatabaseConfigured } from "../shared/config/database.js";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { allocateSequence } from "../shared/core/sequence-number.js";

interface capturedQuery {
  sqlText: string;
  params: unknown[];
}

/** Minimal SQL client capturing the exact statement allocateSequence builds. */
function capturingClient(rows: Array<{ last_seq: string | number }>) {
  const captured: capturedQuery[] = [];
  const client = {
    execute: async (query: SQL) => {
      const built = query.toQuery({
        casing: new CasingCache(),
        escapeName: (name: string) => `"${name}"`,
        escapeParam: (index: number) => `$${index + 1}`,
        escapeString: (value: string) => `'${value}'`,
      });
      captured.push({ sqlText: built.sql, params: built.params });
      return rows;
    },
  };
  return { client, captured };
}

describe("DB-010 · allocateSequence hermetic contract", () => {
  it("issues ONE atomic upsert round trip with the channel id and count", async () => {
    const { client, captured } = capturingClient([{ last_seq: "7" }]);

    const result = await allocateSequence("ch-one", 3, client);

    expect(result).toBe(7);
    expect(captured).toHaveLength(1);
    const { sqlText, params } = captured[0]!;
    expect(sqlText).toContain('insert into "channel_sequences"');
    expect(sqlText).toContain('on conflict ("channel_id") do update');
    expect(sqlText).toContain('returning "last_seq"');
    // Single round trip: the previous SELECT-MAX+1 shape needed two statements
    // plus a retry loop; the upsert must contain exactly one insert.
    expect(sqlText.match(/insert into/gi)).toHaveLength(1);
    // The seed reads MAX(messages.sequence_number) so legacy channels keep
    // their numbering; the advance adds the requested count.
    expect(sqlText).toContain("max");
    expect(sqlText).toContain("messages");
    expect(params).toContain("ch-one");
    expect(params).toContain(3);
  });

  it("returns bigint text results as numbers (postgres-js string shape)", async () => {
    const { client } = capturingClient([{ last_seq: "9007199254740991" }]);
    const result = await allocateSequence("ch-big", 1, client);
    expect(typeof result).toBe("number");
    expect(result).toBe(9007199254740991);
  });

  it("throws loudly when the upsert returns no row", async () => {
    const { client } = capturingClient([]);
    await expect(allocateSequence("ch-empty", 1, client)).rejects.toThrow(
      /allocateSequence\(ch-empty, 1\) returned no row/,
    );
  });
});

describe("DB-010 · allocateSequence local-first fallback", () => {
  // Runs in the no-DATABASE_URL checkouts DB-010 describes; with a URL
  // configured (CI) the PG path is covered by the concurrency suite instead.
  const databaseConfigured = isDatabaseConfigured();
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db010-seq-"));
    setLocalStoreDirForTests(dir);
  });

  afterEach(() => {
    setLocalStoreDirForTests(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it.skipIf(databaseConfigured)(
    "allocates from the file counter without a client (bump-first, gaps OK)",
    async () => {
      const first = await allocateSequence("ch-local");
      const second = await allocateSequence("ch-local");
      expect(first).toBe(1);
      expect(second).toBe(2);

      const batch = await allocateSequence("ch-local", 5);
      expect(batch).toBe(7);
    },
  );
});


#!/usr/bin/env tsx
/**
 * SPEC 04 one-shot backfill: TEXT embedding (JSON array) -> embedding_vec.
 * Idempotent: only touches rows with embedding set and embedding_vec NULL,
 * so re-running reports embedded:0. Dimension mismatches and unparsable rows
 * are logged and skipped, never written.
 * Usage: npm run db:backfill-embeddings --workspace @community-agent/server
 */
import { closeDatabaseConnection, getSqlClient } from "../src/Shared/config/database.ts";

// Pinned by migration 0012; a dimensions change needs a new migration.
const DIMS = 1536;
const BATCH = 500;

interface BackfillRow {
  id: string;
  embedding: string;
}

function parseVec(raw: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== DIMS) return null;
  if (!parsed.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return parsed as number[];
}

async function main(): Promise<void> {
  const sql = getSqlClient();
  let embedded = 0;
  let skipped = 0;
  let mismatched = 0;

  for (;;) {
    const rows = (await sql`
      SELECT id, embedding FROM agent_memory_notes
      WHERE embedding IS NOT NULL AND embedding_vec IS NULL
      LIMIT ${BATCH}
    `) as unknown as BackfillRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const vec = parseVec(row.embedding);
      if (!vec) {
        mismatched++;
        console.warn(`[backfill] skip ${row.id}: unparsable or dim-mismatched TEXT embedding`);
        continue;
      }
      try {
        await sql`
          UPDATE agent_memory_notes SET embedding_vec = ${JSON.stringify(vec)}::vector
          WHERE id = ${row.id} AND embedding_vec IS NULL
        `;
        embedded++;
      } catch (err) {
        skipped++;
        console.warn(`[backfill] skip ${row.id}: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      }
    }
  }

  console.log(`[backfill] done: embedded=${embedded} mismatched=${mismatched} skipped=${skipped}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection();
  });

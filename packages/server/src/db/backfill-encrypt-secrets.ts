import { pathToFileURL } from "node:url";

import { config as loadEnv } from "dotenv";
loadEnv();

import { eq } from "drizzle-orm";

import { closeDatabaseConnection, getDb } from "../shared/config/database.js";
import {
  embeddingModelProfiles,
  generationModelProfiles,
  indexingModelProfiles,
  modelModules,
  mcpServers,
} from "./schema.js";
import { encrypt, isEncrypted } from "../shared/core/secret-box.js";
import { redactLogPayload } from "../shared/core/redact.js";

interface ColumnStat {
  table: string;
  column: string;
  scanned: number;
  alreadyEncrypted: number;
  plaintextFound: number;
  encryptedNow: number;
}

const APPLY = process.argv.includes("--apply");

// DB-001: --apply is meaningless without a key — encrypt() no-ops and the old
// counter still reported success. The gate below refuses that mode; this helper
// is also used for the dry-run key status line.
export function hasEncryptionKey(source: Record<string, string | undefined> = process.env): boolean {
  return Boolean(source.CREDENTIALS_ENCRYPTION_KEY?.trim());
}

export async function backfillApiKeyColumn(
  table: string,
  rows: { id: string; apiKey: string | null }[],
  persist: (id: string, sealed: string) => Promise<void>,
  apply: boolean = APPLY
): Promise<ColumnStat> {
  const stat: ColumnStat = { table, column: "api_key", scanned: rows.length, alreadyEncrypted: 0, plaintextFound: 0, encryptedNow: 0 };

  for (const row of rows) {
    if (!row.apiKey) continue;
    if (isEncrypted(row.apiKey)) {
      stat.alreadyEncrypted++;
      continue;
    }
    stat.plaintextFound++;
    if (apply) {
      const sealed = encrypt(row.apiKey);
      // DB-001: only persist/count when the stored value actually changes —
      // without a key encrypt() returns the input unchanged, so an
      // unconditional encryptedNow++ was a false success signal.
      if (sealed === row.apiKey) continue;
      await persist(row.id, sealed);
      stat.encryptedNow++;
    }
  }
  return stat;
}

async function main(): Promise<void> {
  // DB-001: fail fast before touching the DB — an --apply run without the key
  // would write nothing and still print "Encrypted N row(s)".
  if (APPLY && !hasEncryptionKey()) {
    console.error(redactLogPayload({
      stage: "backfill-secrets",
      mode: "apply",
      status: "skipped-no-key",
      msg: "CREDENTIALS_ENCRYPTION_KEY is not set; refusing --apply (no value would change). Set the key and re-run.",
    }));
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const stats: ColumnStat[] = [];

  console.log(redactLogPayload({ stage: "backfill-secrets", mode: APPLY ? "apply" : "dry-run" }));

  stats.push(await backfillApiKeyColumn(
    "model_modules",
    await db.select({ id: modelModules.id, apiKey: modelModules.apiKey }).from(modelModules),
    (id, sealed) => db.update(modelModules).set({ apiKey: sealed, updatedAt: new Date() }).where(eq(modelModules.id, id)).then(() => {})
  ));

  stats.push(await backfillApiKeyColumn(
    "generation_model_profiles",
    await db.select({ id: generationModelProfiles.id, apiKey: generationModelProfiles.apiKey }).from(generationModelProfiles),
    (id, sealed) => db.update(generationModelProfiles).set({ apiKey: sealed, updatedAt: new Date() }).where(eq(generationModelProfiles.id, id)).then(() => {})
  ));

  stats.push(await backfillApiKeyColumn(
    "embedding_model_profiles",
    await db.select({ id: embeddingModelProfiles.id, apiKey: embeddingModelProfiles.apiKey }).from(embeddingModelProfiles),
    (id, sealed) => db.update(embeddingModelProfiles).set({ apiKey: sealed, updatedAt: new Date() }).where(eq(embeddingModelProfiles.id, id)).then(() => {})
  ));

  stats.push(await backfillApiKeyColumn(
    "indexing_model_profiles",
    await db.select({ id: indexingModelProfiles.id, apiKey: indexingModelProfiles.apiKey }).from(indexingModelProfiles),
    (id, sealed) => db.update(indexingModelProfiles).set({ apiKey: sealed, updatedAt: new Date() }).where(eq(indexingModelProfiles.id, id)).then(() => {})
  ));

  const mcpRows = await db.select({ id: mcpServers.id, envVars: mcpServers.envVars }).from(mcpServers);
  const mcpStat: ColumnStat = { table: "mcp_servers", column: "env_vars", scanned: mcpRows.length, alreadyEncrypted: 0, plaintextFound: 0, encryptedNow: 0 };
  for (const row of mcpRows) {
    const entries = Object.entries(row.envVars ?? {});
    if (entries.length === 0) continue;
    let touched = false;
    for (const [, v] of entries) {
      if (!v) continue;
      if (isEncrypted(v)) {
        mcpStat.alreadyEncrypted++;
        continue;
      }
      mcpStat.plaintextFound++;
      touched = true;
    }
    if (touched && APPLY) {
      const sealedMap = Object.fromEntries(entries.map(([k, v]) => [k, v ? encrypt(v) : v]));
      const changed = entries.some(([k, v]) => Boolean(v) && sealedMap[k] !== v);
      if (changed) {
        await db.update(mcpServers).set({ envVars: sealedMap, updatedAt: new Date() }).where(eq(mcpServers.id, row.id));
        mcpStat.encryptedNow++;
      }
    }
  }
  stats.push(mcpStat);

  for (const s of stats) {
    console.log(redactLogPayload({ stage: "backfill-secrets", table: s.table, column: s.column, scanned: s.scanned, alreadyEncrypted: s.alreadyEncrypted, plaintext: s.plaintextFound, encryptedNow: s.encryptedNow }));
  }

  const totalPlaintext = stats.reduce((acc, s) => acc + s.plaintextFound, 0);
  if (!APPLY) {
    const keyPresent = hasEncryptionKey();
    console.log(redactLogPayload({
      stage: "backfill-secrets",
      keyStatus: keyPresent ? "present" : "missing",
      msg: !keyPresent
        ? "DRY RUN: CREDENTIALS_ENCRYPTION_KEY is not set — --apply will refuse to run until the key is configured."
        : totalPlaintext > 0
          ? `DRY RUN: ${totalPlaintext} credential value(s) would be encrypted. Re-run with --apply to write envelopes.`
          : "DRY RUN: nothing to encrypt.",
    }));
  } else {
    console.log(redactLogPayload({ stage: "backfill-secrets", msg: `Done. Encrypted ${stats.reduce((a, s) => a + s.encryptedNow, 0)} row(s)/map(s).` }));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabaseConnection();
    });
}

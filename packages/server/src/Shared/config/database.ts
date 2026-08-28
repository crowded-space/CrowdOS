import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "./env.js";
import * as schema from "../../db/schema.js";

let sqlClient: postgres.Sql | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Configure it before using the database layer.");
  }

  return env.DATABASE_URL;
}

export function getSqlClient(): postgres.Sql {
  if (!sqlClient) {
    sqlClient = postgres(requireDatabaseUrl(), {
      prepare: false,
      max: 20,
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      onnotice: () => {},
    });
  }

  return sqlClient;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getSqlClient(), {
      schema,
    });
  }

  return dbInstance;
}

type DbInstance = ReturnType<typeof getDb>;

/** Transaction client handed to withTransaction callbacks. */
export type DbTx = Parameters<Parameters<DbInstance["transaction"]>[0]>[0];

/** Either the standalone pool-backed db or an in-flight transaction. */
export type DbLike = DbInstance | DbTx;

/**
 * DB-2: run `fn` inside a single postgres transaction; any thrown error rolls
 * back every write performed through the provided client.
 */
export async function withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

export async function ensurePgVectorExtension(): Promise<void> {
  const sql = getSqlClient();

  try {
    await sql`create extension if not exists vector`;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "23505" || error.code === "42710")
    ) {
      return;
    }

    throw error;
  }
}

export async function closeDatabaseConnection(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
  }
}

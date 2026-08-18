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

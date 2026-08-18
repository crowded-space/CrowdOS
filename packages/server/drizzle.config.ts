import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before running Drizzle commands.");
}

export default defineConfig({
  out: "./src/db/migrations",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});

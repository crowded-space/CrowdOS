// Copies drizzle SQL migrations into dist (tsc only emits .ts -> .js).
// Keeps the Electron first-run fork (dist/db/bootstrap.js) on the same
// migration set as src. Run as part of `npm run build`.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
cpSync(join(here, "..", "src", "db", "migrations"), join(here, "..", "dist", "db", "migrations"), {
  recursive: true,
});
console.log("[copy-migrations] src/db/migrations -> dist/db/migrations");

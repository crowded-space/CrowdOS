// Embedded Fastify backend (QUEUE_MODE=inline, loopback-only).
//
// Hosts the API + worker inline in the Electron main process via the
// side-effect-free `buildServer()` factory from
// `packages/server/src/create-app.ts`, then `start()` listens on
// 127.0.0.1 and `stop()` owns graceful shutdown.
//
// Why NOT a static `import ... from "@crowdspace/server/..."` here:
// cross-workspace TS imports are awkward and a packaged Electron build may
// not ship the server source at all. We therefore resolve the factory with
// a path-agnostic dynamic import and fall back to a no-op handle so the
// main-process wiring (single-instance lock, shutdown hook) keeps working.
//
// DB URL handling: pass-through via env — this module never assigns
// `process.env.DATABASE_URL`. The desktop shell must set it before calling.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface EmbeddedBackendOptions {
  port: number;
  databaseUrl: string;
}

export interface EmbeddedBackendHandle {
  port: number;
  stop(): Promise<void>;
}

export async function startEmbeddedBackend(
  opts: EmbeddedBackendOptions,
): Promise<EmbeddedBackendHandle> {
  if (!Number.isInteger(opts.port) || opts.port <= 0) {
    throw new Error("startEmbeddedBackend: opts.port must be a positive integer");
  }
  if (!opts.databaseUrl || opts.databaseUrl.trim().length === 0) {
    throw new Error("startEmbeddedBackend: opts.databaseUrl must be non-empty");
  }
  // NOTE: databaseUrl is validated only — the connection string itself flows
  // through process.env (owned by the desktop shell), never assigned here.

  const fileCandidates: string[] = [
    join(__dirname, "..", "..", "..", "server", "dist", "create-app.js"),
    join(__dirname, "..", "..", "server", "dist", "create-app.js"),
  ];
  try {
    const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
    if (resources) fileCandidates.push(join(resources, "server", "dist", "create-app.js"));
  } catch {}

  const candidates: string[] = [];
  for (const p of fileCandidates) {
    if (existsSync(p)) {
      candidates.push(pathToFileURL(p).href);
    }
  }
  candidates.push(
    "@crowdspace/server/dist/create-app.js",
    "../../../server/dist/create-app.js",
    "../../server/dist/create-app.js",
  );

  let mod: any = null;
  const failures: string[] = [];
  for (const spec of candidates) {
    try {
      // Variable specifier avoids static module resolution; a failure just
      // means this build has no embeddable server (e.g. packaged) → no-op.
      mod = await import(/* @vite-ignore */ spec);
      if (mod?.buildServer) break;
      failures.push(`${spec}: loaded but no buildServer export`);
      mod = null;
    } catch (err) {
      failures.push(`${spec}: ${(err as Error)?.message ?? String(err)}`.slice(0, 200));
      mod = null;
    }
  }
  if (!mod?.buildServer) {
    // ponytail: surface per-candidate reasons — a bare "unavailable" caused
    // a blind live-test failure (every reason was swallowed here).
    const detail = failures.slice(0, 3).join(" | ");
    console.error(`[embedded-backend] server factory unavailable — ${detail}`);
    throw new Error(`[embedded-backend] server factory unavailable — ${detail}`);
  }

  try {
    const built = await mod.buildServer({ host: "127.0.0.1", port: opts.port, queueMode: "inline" });
    const addr = await built.start();
    const actualPort = typeof addr?.port === "number" ? addr.port : opts.port;
    return {
      port: actualPort,
      stop: async (): Promise<void> => {
        await built.stop();
      },
    };
  } catch (err) {
    console.error("[embedded-backend] failed to start embedded server:", (err as Error)?.message ?? err);
    throw err;
  }
}

import { fork } from "node:child_process";
import { existsSync } from "node:fs";

// First-run database migration for the desktop shell.
//
// Reuses the existing server one-shot script (`db/bootstrap.ts` → compiled
// `db/bootstrap.js`, which applies drizzle migrations + pgvector + seed and
// then exits). It auto-runs main() on import, so it must NEVER be imported —
// it is forked as a child process with the desktop DATABASE_URL.
//
// Zero-Auth note: the local Postgres is trusted (loopback-only, single user);
// no extra credentials are introduced here.
export interface EnsureDatabaseOptions {
  databaseUrl: string;
  /** Absolute candidate paths for compiled db/bootstrap.js (first hit wins). */
  bootstrapCandidates: string[];
  timeoutMs?: number;
}

export type EnsureDatabaseResult =
  | { status: "migrated" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const DEFAULT_TIMEOUT_MS = 120_000;

export async function ensureDatabase(opts: EnsureDatabaseOptions): Promise<EnsureDatabaseResult> {
  if (!opts.databaseUrl || opts.databaseUrl.trim().length === 0) {
    return { status: "skipped", reason: "DATABASE_URL is empty" };
  }
  const target = opts.bootstrapCandidates.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  if (!target) {
    return {
      status: "skipped",
      reason: "server bootstrap bundle not found (run npm run db:push manually)",
    };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<EnsureDatabaseResult>((resolve) => {
    let done = false;
    const finish = (r: EnsureDatabaseResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child: ReturnType<typeof fork>;
    // ponytail: fork() under Electron uses the Electron binary as execPath;
    // ELECTRON_RUN_AS_NODE makes the child behave as plain Node so the
    // one-shot migrate+seed script runs identically in dev and packaged.
    // Stderr tail is captured so the next failure is self-explaining.
    const stderrTail: string[] = [];
    try {
      child = fork(target, [], {
        env: { ...process.env, DATABASE_URL: opts.databaseUrl, ELECTRON_RUN_AS_NODE: "1" },
        silent: true,
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk.toString());
        while (stderrTail.join("").length > 2048) stderrTail.shift();
      });
    } catch (err) {
      finish({ status: "failed", reason: `fork failed: ${(err as Error)?.message ?? String(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore — child already gone
      }
      finish({ status: "failed", reason: `migration timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ status: "failed", reason: `migration process error: ${err?.message ?? String(err)}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ status: "migrated" });
      else {
        const tail = stderrTail.join("").trim().slice(-500);
        finish({
          status: "failed",
          reason: `bootstrap exited with code ${code ?? "unknown"}${tail ? ` — ${tail}` : " (is Postgres 16 running on 127.0.0.1?)"}`,
        });
      }
    });
  });
}

// Debug launcher for the CrowdOS desktop shell (Windows-first).
//
// `npm run dev --workspace @crowdspace/desktop` (or `npm run dev:electron`
// from the repo root):
//   1. compiles main/preload (tsc emit + esbuild bundle -> dist/),
//   2. starts the vite renderer (:22077) unless it is already up,
//   3. launches Electron with CROWDOS_DEV=1 (loads vite, not the bundle) and
//      --inspect for main-process debugging.
//
// Debugging:
//   - Main:  chrome://inspect -> configure 127.0.0.1:9229 (override with
//     ELECTRON_INSPECT=0 to disable, =<port> for a base port; a taken port
//     falls back upward automatically).
//   - Renderer: DevTools auto-open (CROWDOS_DEVTOOLS=0 to disable).
//   - Backend:  [embedded-backend]/Fastify logs in this console;
//     desktop file log at <userData>/logs/desktop.log via crowdos:log:write.
//
// Dependency-free (node:child_process / fetch only). Exits non-zero when the
// build fails, vite never comes up, or Electron is not installed.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const ROOT = join(DESKTOP, "..", "..");

// Load root .env so DATABASE_URL and server environment variables are available
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // ignore
  }
}
const VITE_URL = process.env.VITE_URL ?? "http://127.0.0.1:22077";
const INSPECT = process.env.ELECTRON_INSPECT ?? "9229";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
// Windows: .cmd shims cannot be spawned without a shell (spawn EINVAL).
const USE_SHELL = process.platform === "win32";

const children = new Set();
function track(child) {
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function shutdown(signal) {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      // ignore — already gone
    }
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function runOnce(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(cmd, args, { cwd, stdio: "inherit", shell: USE_SHELL }));
    child.on("error", (err) => reject(new Error(`spawn failed: ${cmd} ${args.join(" ")}: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function viteUp() {
  try {
    const res = await fetch(VITE_URL, { signal: AbortSignal.timeout(2000) });
    await res.arrayBuffer().catch(() => null);
    return true;
  } catch {
    return false;
  }
}

async function waitForVite(timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    if (await viteUp()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`vite renderer never came up at ${VITE_URL} (started one, still down after 60s)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --inspect port: a taken port kills the Electron launch outright, so probe
// first and fall back (9229 -> 9239). ELECTRON_INSPECT=0 disables inspecting.
async function pickInspectPort() {
  if (INSPECT === "0") return null;
  const wanted = Number(INSPECT);
  const base = Number.isInteger(wanted) && wanted > 0 ? wanted : 9229;
  for (let port = base; port < base + 11; port += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      await res.arrayBuffer().catch(() => null);
    } catch {
      return port; // nothing listening -> free for the inspector
    }
  }
  return null;
}

async function main() {
  // 1. Compile pi-core + server + main/preload so all dists exist
  // (pi-core first: server dist imports it at runtime under plain Node).
  await runOnce(NPM, ["run", "build", "--workspace", "@crowdspace/pi-core"], ROOT);
  await runOnce(NPM, ["run", "build", "--workspace", "@crowdspace/server"], ROOT);
  await runOnce(NPM, ["run", "build"], DESKTOP);

  // 2. Server API: embedded in Electron by default on :12077.
  let apiChild = null;
  if (process.env.START_STANDALONE_API === "1") {
    try {
      const probe = await fetch("http://127.0.0.1:12077/api/observability/stats", {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      if (probe && probe.status < 500) {
        console.log("[dev-electron] reusing server API at http://127.0.0.1:12077");
      } else {
        console.log("[dev-electron] starting server API (:12077)…");
        apiChild = track(
          spawn(NPM, ["run", "dev:api"], {
            cwd: ROOT,
            stdio: "inherit",
            shell: USE_SHELL,
            env: { ...process.env },
          }),
        );
      }
    } catch {
      // ignore
    }
  } else {
    console.log("[dev-electron] server backend will run embedded in Electron on http://127.0.0.1:12077");
  }

  // 3. Renderer: reuse a running vite, else start one on port 22077 (killed with Electron).
  let viteChild = null;
  if (await viteUp()) {
    console.log(`[dev-electron] reusing vite renderer at ${VITE_URL}`);
  } else {
    console.log("[dev-electron] starting vite renderer (:22077)…");
    viteChild = track(
      spawn(NPM, ["run", "dev", "--workspace", "@crowdspace/client", "--", "--port", "22077"], {
        cwd: ROOT,
        stdio: "inherit",
        shell: USE_SHELL,
        env: {
          ...process.env,
          VITE_BACKEND_PORT: "12077",
          BACKEND_PORT: "12077",
          CROWDOS_DEV: "1",
        },
      }),
    );
    viteChild.on("exit", (code) => {
      console.error(`[dev-electron] vite exited with code ${code ?? "unknown"} — stopping.`);
      shutdown("SIGTERM");
      process.exitCode = 1;
    });
    await waitForVite();
  }

  // 4. Electron (. = packages/desktop, main = dist/main/index.js).
  const inspectPort = await pickInspectPort();
  const inspectArgs = inspectPort === null ? [] : [`--inspect=${inspectPort}`];
  console.log(
    `[dev-electron] launching Electron (CROWDOS_DEV=1${inspectPort === null ? ", inspector off" : `, --inspect=${inspectPort}`})…`,
  );
  const localBin = join(
    DESKTOP,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  const electronBin = existsSync(localBin)
    ? localBin
    : (process.platform === "win32" ? "electron.cmd" : "electron");
  const electron = track(
    spawn(electronBin, [...inspectArgs, "."], {
      cwd: DESKTOP,
      stdio: "inherit",
      shell: USE_SHELL,
      env: {
        ...process.env,
        CROWDOS_DEV: "1",
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? "0",
      },
    }),
  );
  const code = await new Promise((resolve) => electron.on("exit", resolve));
  if (viteChild) {
    try {
      viteChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  if (apiChild) {
    try {
      apiChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  process.exitCode = typeof code === "number" ? code : 0;
}

main().catch((err) => {
  console.error(`[dev-electron] ${err?.message ?? err}`);
  if (String(err?.message ?? "").includes("electron")) {
    console.error("[dev-electron] is Electron installed? Run: npm install");
  }
  shutdown("SIGTERM");
  process.exit(1);
});

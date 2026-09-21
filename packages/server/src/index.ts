// ─── Dev entry (`npm run dev`) — thin wrapper over the single factory ──
// All HTTP/socket wiring lives in create-app.ts buildServer() (the same
// factory the desktop embedded backend uses): tenant routing, auth/PIN,
// rate limits, local-mode guards, timers, and background filesystem bootstrap.
// This file only handles dev-process concerns: config init, listen,
// bootstrap-key seeding, and signal shutdown. Do NOT add routes/hooks here.

import { env, initConfig } from "./shared/config/env.js";
import { buildServer } from "./create-app.js";
import { authGate } from "./shared/auth/auth-gate.js";
import { installProcessGuards } from "./shared/core/process-guards.js";

// Install before anything else can schedule detached work (config init,
// filesystem bootstrap, reindex timers, outbox drains). See process-guards.ts for why a
// local-first app logs-and-continues instead of exiting.
installProcessGuards({ role: "server" });

try {
  initConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const built = await buildServer({
  host: "0.0.0.0",
  port: env.PORT,
});

// Graceful shutdown (P0-3 durability) — stop accepting work, release leases, close DB/sockets.
let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  built.app.log.info(`Received ${signal}, initiating graceful shutdown...`);
  try {
    await built.stop();
    built.app.log.info("Graceful shutdown complete. Exiting.");
    process.exit(0);
  } catch (err) {
    built.app.log.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

try {
  // buildServer.start() listens first, then settles filesystem bootstrap in
  // the background (readiness via built.isReady()).
  await built.start();

  // SEC-1: guarantee an admin API key exists so strict default-deny is operable.
  try {
    await authGate.seedBootstrapAdminKey();
  } catch (error) {
    built.app.log.error(
      `Failed to seed bootstrap admin key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
} catch (error) {
  built.app.log.error(error);
  process.exit(1);
}

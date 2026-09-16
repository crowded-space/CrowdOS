import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "crypto";

import { env } from "./shared/config/env.js";
import { EventBroker } from "./event-broker/event-broker-gate.js";
import { setSharedBroker } from "./event-broker/event-broker-gate.js";
import { setupErrorHandler } from "./shared/core/errors.js";
import { validatorCompiler } from "./shared/core/validation.js";
import { registerRoutes } from "./routes/index.js";
import { registerRateLimit } from "./routes/rate-limit.js";
import { registerSocketServer } from "./shared/sockets/register-socket-server.js";
import { initRuntime } from "./runtime/runtime-gate.js";
import { getDb, closeDatabaseConnection } from "./shared/config/database.js";
import { workspaces } from "./db/schema.js";
import { LocalVFS } from "./vfs/vfs-gate.js";
import * as path from "node:path";
import { authGate } from "./shared/auth/auth-gate.js";
import { startBudgetReconciler } from "./shared/core/token-tracker.js";
import { initConfig } from "./shared/config/env.js";

try {
  initConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// Initialize Fastify with advanced, structured logging and correlation IDs — redact secrets (P0-2)
const app = Fastify({
  logger: {
    level: "info",
    serializers: {
      req(request) {
        const headers = (request.headers || {}) as Record<string, unknown>;
        const safeHeaders: Record<string, unknown> = { ...headers };
        for (const k of Object.keys(safeHeaders)) {
          if (/authorization|api[_-]?key|secret|token|cookie/i.test(k)) safeHeaders[k] = "[REDACTED]";
        }
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
          id: request.id,
          headers: safeHeaders,
        };
      },
    },
  },
  genReqId(req) {
    const correlationId = req.headers["x-correlation-id"] || req.headers["x-request-id"];
    return Array.isArray(correlationId)
      ? correlationId[0]
      : (correlationId as string) || randomUUID();
  },
  requestIdHeader: "x-correlation-id",
});

// Set up request schema Zod compiler
app.setValidatorCompiler(validatorCompiler);

// Register CORS middleware — allowlist from env (never origin:true in production)
const allowedOrigins = env.CLIENT_ORIGIN.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow non-browser (no origin) and explicit allowlist; block others
    if (!origin) {
      cb(null, true);
      return;
    }
    if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
      cb(null, true);
      return;
    }
    // In dev, allow localhost variations if configured origin is localhost
    const isLocalhost = origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
    if (isLocalhost && allowedOrigins.some((o) => o.includes("localhost") || o.includes("127.0.0.1"))) {
      cb(null, true);
      return;
    }
    cb(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-correlation-id", "x-request-id"],
});

// Set up custom error handler (catches Zod validation & other errors cleanly)
setupErrorHandler(app);

// Authentication gate (P0-1) — enforced server-side, not frontend assumptions
app.addHook("onRequest", authGate.requireAuth);

// SEC-5: global per-key HTTP rate limiting. Registered after the auth hook so
// keyGenerator sees request.identity; root-level onRequest hooks run before
// the limiter's route-level onRequest hooks.
await registerRateLimit(app);

// Register all REST routes
await app.register(registerRoutes);

const eventBroker = new EventBroker();
setSharedBroker(eventBroker);
initRuntime();
// QUE-2: when QUEUE_MODE=bullmq, local maintenance timers are replaced by
// BullMQ repeatable jobs (runs/maintenance). API skips timers and never
// opens a Redis connection except via optional health probe.
const queueMode = (process.env.QUEUE_MODE ?? "inline").trim().toLowerCase();
const isBullMqApi = queueMode === "bullmq";
if (!isBullMqApi) {
  startBudgetReconciler();
  try {
    const { runsGate } = await import("./runs/runs-gate.js");
    await (runsGate as unknown as { startRunOrphanSweeper: (b: unknown) => Promise<void> }).startRunOrphanSweeper(eventBroker);
  } catch {}
} else {
  app.log.info("[Queue] bullmq mode — local sweep timers suppressed (repeatables cover them)");
}
// APR-1: approval TTL sweeper (default-deny resumes-as-denied). Runs locally in
// inline mode; in bullmq mode the same sweep is also available as a repeatable,
// but local timer is still started here because approvals are synchronous pauses
// not queued — cheap idempotent DB poll every 30s.
try {
  const { startApprovalSweeper } = await import("./approvals/approval-sweeper.js");
  startApprovalSweeper(eventBroker);
} catch {}
const io = registerSocketServer(app.server, eventBroker);

// Auto-initialize VFS folders for every workspace on server startup
async function bootstrapWorkspaces(logger: any) {
  try {
    const db = getDb();
    
    // 1. Fetch all active or created workspaces in DB
    const allWorkspaces = await db.select().from(workspaces).execute();
    logger.info(`Found ${allWorkspaces.length} workspaces in database for VFS bootstrapping.`);

    const sandboxRoot = path.join(process.cwd(), "sandbox");

    for (const ws of allWorkspaces) {
      logger.info(`Bootstrapping VFS for workspace: ${ws.name} (${ws.id})...`);
      const vfs = new LocalVFS({
        workspaceId: ws.id,
        workspaceRoot: ws.rootPath,
        actorId: ws.ownerId || "system",
      });
      await vfs.initialize();
      logger.info(`Successfully initialized VFS for workspace: ${ws.id}`);
    }

    // 2. Also ensure default workspace VFS is fully bootstrapped — actor derived from system, not hard-coded human_operator (P0-1)
    logger.info("Bootstrapping default developer workspace VFS...");
    const systemActor = process.env.SYSTEM_ACTOR_ID || "system";
    const defaultVfs = new LocalVFS({
      workspaceId: "default",
      workspaceRoot: path.join(sandboxRoot, "default"),
      actorId: systemActor,
    });
    await defaultVfs.initialize();
    logger.info("Successfully initialized default developer workspace VFS.");

  } catch (error) {
    logger.error(`Error bootstrapping workspaces on startup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const host = "0.0.0.0";

// Graceful shutdown (P0-3 durability) — stop accepting work, release leases, close DB/sockets
let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  app.log.info(`Received ${signal}, initiating graceful shutdown...`);
  try {
    // 1. Stop accepting new socket connections
    io.engine.close();
    // 2. Close Fastify (stop HTTP)
    await app.close();
    // 3. Close database connections
    await closeDatabaseConnection();
    app.log.info("Graceful shutdown complete. Exiting.");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

try {
  // Initialize workspaces prior to listening for requests
  await bootstrapWorkspaces(app.log);

  // SEC-1: guarantee an admin API key exists so strict default-deny is operable.
  try {
    await authGate.seedBootstrapAdminKey();
  } catch (error) {
    app.log.error(`Failed to seed bootstrap admin key: ${error instanceof Error ? error.message : String(error)}`);
  }

  await app.listen({
    host,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "crypto";

import { env } from "./Shared/config/env.js";
import { EventBroker } from "./EventBroker/eventBrokerGate.js";
import { setupErrorHandler } from "./Shared/core/errors.js";
import { validatorCompiler } from "./Shared/core/validation.js";
import { registerRoutes } from "./routes/index.js";
import { registerSocketServer } from "./Shared/sockets/registerSocketServer.js";
import { initRuntime } from "./runtime/index.js";
import { getDb } from "./Shared/config/database.js";
import { workspaces } from "./db/schema.js";
import { LocalVFS } from "./vfs/local-vfs.js";
import * as path from "node:path";

// Initialize Fastify with advanced, structured logging and correlation IDs
const app = Fastify({
  logger: {
    level: "info",
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
          id: request.id,
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

// Register CORS middleware
await app.register(cors, {
  origin: true,
});

// Set up custom error handler (catches Zod validation & other errors cleanly)
setupErrorHandler(app);

// Register all REST routes
await app.register(registerRoutes);

const eventBroker = new EventBroker();
initRuntime();
registerSocketServer(app.server, eventBroker);

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

    // 2. Also ensure default workspace VFS is fully bootstrapped
    logger.info("Bootstrapping default developer workspace VFS...");
    const defaultVfs = new LocalVFS({
      workspaceId: "default",
      workspaceRoot: path.join(sandboxRoot, "default"),
      actorId: "human_operator",
    });
    await defaultVfs.initialize();
    logger.info("Successfully initialized default developer workspace VFS.");

  } catch (error) {
    logger.error(`Error bootstrapping workspaces on startup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const host = "0.0.0.0";

try {
  // Initialize workspaces prior to listening for requests
  await bootstrapWorkspaces(app.log);

  await app.listen({
    host,
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

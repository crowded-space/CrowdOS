import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "crypto";
import * as path from "node:path";

import { env } from "./shared/config/env.js";
import { EventBroker } from "./event-broker/event-broker-gate.js";
import { setSharedBroker } from "./event-broker/event-broker-gate.js";
import { setupErrorHandler } from "./shared/core/errors.js";
import { validatorCompiler } from "./shared/core/validation.js";
import { registerRoutes } from "./routes/index.js";
import { registerRateLimit } from "./routes/rate-limit.js";
import { registerSocketServer } from "./shared/sockets/register-socket-server.js";
import { initRuntime } from "./runtime/runtime-gate.js";
import { runWithDb, closeDatabaseConnection } from "./shared/config/database.js";
import { closeAllWorkspaceDatabases, listWorkspaceRecords, getWorkspaceDb, getWorkspacePinHash, getWorkspaceRecord } from "./workspace/workspace-gate.js";
import { LocalVFS } from "./vfs/vfs-gate.js";
import { pinGate, isWorkspaceManagementPath } from "./shared/auth/pin-gate.js";
import { authGate } from "./shared/auth/auth-gate.js";
import { startBudgetReconciler } from "./shared/core/token-tracker.js";
import { runsGate } from "./runs/runs-gate.js";
import { startApprovalSweeper } from "./approvals/approval-sweeper.js";
import { queueGate } from "./queue/queue-gate.js";
import { eventsGate } from "./events/events-gate.js";
import { installProcessGuards } from "./shared/core/process-guards.js";

export interface BuildServerOptions {
  host?: string;
  port?: number;
  clientOrigin?: string;
  workspaceDir?: string;
  queueMode?: "inline" | "bullmq";
  skipTimers?: boolean;
  skipListen?: boolean;
}

export interface BuiltServer {
  app: any;
  io: any;
  eventBroker: any;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  /** M5 listen-first: true once background VFS bootstrap has settled. */
  isReady(): boolean;
}

// Auto-initialize VFS folders for every workspace on server startup.
// workspaceDir overrides the sandbox root (opts.workspaceDir ?? WORKSPACE_DIR ?? <cwd>/sandbox).
async function bootstrapWorkspaces(logger: any, workspaceDir: string) {
  try {
    // Read registered workspaces from local registry (Zero-DB boot compliant)
    const allWorkspaces = await listWorkspaceRecords();
    logger.info(`Found ${allWorkspaces.length} workspaces in registry for VFS bootstrapping.`);

    const sandboxRoot = workspaceDir;

    // M5: bounded concurrency — serial await per workspace blocked listen.
    const initOne = async (ws: { id: string; name: string; rootPath?: string }) => {
      logger.info(`Bootstrapping VFS for workspace: ${ws.name} (${ws.id})...`);
      const vfs = new LocalVFS({
        workspaceId: ws.id,
        workspaceRoot: ws.rootPath || path.join(sandboxRoot, ws.id),
        actorId: "system",
      });
      await vfs.initialize();
      logger.info(`Successfully initialized VFS for workspace: ${ws.id}`);
    };
    for (let i = 0; i < allWorkspaces.length; i += 4) {
      await Promise.allSettled(allWorkspaces.slice(i, i + 4).map((ws) => initOne(ws)));
    }

    // 2. Also ensure default workspace VFS is fully bootstrapped — actor derived from system, not hard-coded human_operator (P0-1)
    logger.info("Bootstrapping default developer workspace VFS...");
    const systemActor = process.env.SYSTEM_ACTOR_ID || "system";
    const defaultVfs = new LocalVFS({
      workspaceId: "default",
      workspaceRoot: path.join(sandboxRoot, "default"),
      actorId: systemActor,
    });
    await Promise.allSettled([defaultVfs.initialize()]);
    logger.info("Successfully initialized default developer workspace VFS.");
  } catch (error) {
    logger.error(`Error bootstrapping workspaces on startup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function buildServer(opts?: BuildServerOptions): Promise<BuiltServer> {
  // ── Process crash guards (installed by EVERY boot path) ────────────────
  // index.ts and worker.ts install these at their own entry points, but the
  // desktop shell and any other embedder import THIS factory directly and
  // never touch those files — so the guard belongs here too. Idempotent, and
  // skipped under test so vitest keeps ownership of rejection reporting.
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    installProcessGuards({ role: process.env.DESKTOP_MODE === "1" ? "desktop" : "server" });
  }

  // Resolve queue mode first so downstream readers (queueGate/socket timers
  // which read process.env.QUEUE_MODE) agree with the factory choice.
  const rawQueueMode =
    opts?.queueMode ??
    (process.env.QUEUE_MODE as string | undefined) ??
    (env as unknown as { QUEUE_MODE?: unknown }).QUEUE_MODE ??
    "inline";
  const queueModeNorm = String(rawQueueMode).trim().toLowerCase();
  const isBullMqApi = queueModeNorm === "bullmq";
  if (opts?.queueMode) {
    process.env.QUEUE_MODE = opts.queueMode;
  }

  const resolvedWorkspaceDir =
    opts?.workspaceDir ??
    process.env.WORKSPACE_DIR ??
    path.join(process.cwd(), "sandbox");

  // Initialize Fastify with advanced, structured logging and correlation IDs — redact secrets (P0-2)
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: "warn",
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


  // Support JSON payloads sent with text/plain Content-Type
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch {
      done(null, body);
    }
  });

  // Set up request schema Zod compiler
  app.setValidatorCompiler(validatorCompiler);

  // Register CORS middleware — allowlist from opts.clientOrigin ?? env (never origin:true in production).
  // Desktop loopback (http://127.0.0.1:*) is always allowed for the embedded backend.
  const clientOriginRaw = opts?.clientOrigin ?? env.CLIENT_ORIGIN;
  const allowedOrigins = String(clientOriginRaw)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // ponytail: precompute per-boot (no startsWith/includes/some per request)
  const allowedOriginSet = new Set(allowedOrigins);
  const configuredLoopback = allowedOrigins.some((o) => o.includes("localhost") || o.includes("127.0.0.1"));

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow non-browser (no origin) and explicit allowlist; block others
      if (!origin) {
        cb(null, true);
        return;
      }
      // Desktop packaged renderer loads from file:// and fetches the
      // loopback backend with `Origin: null`. Accept it only for the
      // embedded desktop backend (DESKTOP_MODE=1, loopback-only listener).
      if (origin === "null" && process.env.DESKTOP_MODE === "1") {
        cb(null, true);
        return;
      }
      if (allowedOriginSet.has(origin)) {
        cb(null, true);
        return;
      }
      // Embedded/desktop loopback: always allow 127.0.0.1 variations.
      if (origin.startsWith("http://127.0.0.1:")) {
        cb(null, true);
        return;
      }
      // In dev, allow localhost variations if configured origin is localhost
      if (configuredLoopback && origin.startsWith("http://localhost:")) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-pin", "x-api-key", "x-correlation-id", "x-request-id", "x-workspace-id"],
  });

  // Set up custom error handler (catches Zod validation & other errors cleanly)
  setupErrorHandler(app);

  // Fastify request decorators for dynamic tenant database routing
  app.decorateRequest("db", null);
  app.decorateRequest("workspaceId", null);
  app.decorateRequest("dbError", null);

  // Dynamic tenant routing: resolve workspace DB via x-workspace-id header.
  // Fail closed: a requested workspace with no resolvable database gets a
  // 503 here, never silently serves another database's rows downstream.
  // Workspace-management paths resolve best-effort (portal must work DB-less).
  // The downstream lifecycle runs inside runWithDb so every bare getDb() in
  // the request path (routes AND services without explicit overrides)
  // resolves to the tenant handle — callback-style done() is what carries
  // the AsyncLocalStorage context forward; an async hook would drop it.
  app.addHook("onRequest", (request: any, _reply, done) => {
    const wsIdHeader = request.headers["x-workspace-id"];
    const wsId = Array.isArray(wsIdHeader) ? wsIdHeader[0] : wsIdHeader;
    if (!wsId || typeof wsId !== "string" || !wsId.trim()) {
      done();
      return;
    }
    const trimmedWsId = wsId.trim();
    request.workspaceId = trimmedWsId;
    const dbOptional = isWorkspaceManagementPath(String(request.url || "").split("?")[0]);
    // ponytail: watchdog converts any resolution stall into a visible 503 —
    // a request must never hang silently in this hook. Settled flag guards
    // against double-done.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn();
    };
    const watchdog = setTimeout(() => {
      settle(() =>
        done(
          Object.assign(
            new Error(`Workspace database resolution timed out for workspace ${trimmedWsId}.`),
            { statusCode: 503, code: "WORKSPACE_DB_OFFLINE", suggestion: "The workspace database is unreachable; the app keeps serving local files where possible. Check the database connection or switch the workspace to Local-first storage." },
          ),
        ),
      );
    }, 25_000);
    watchdog.unref?.();
    const fail = (message: string): void => {
      settle(() => {
        if (dbOptional) {
          request.dbError = message;
          done();
          return;
        }
        done(
          Object.assign(new Error(message), {
            statusCode: 503,
            code: "WORKSPACE_DB_OFFLINE",
            suggestion: "The workspace database is unreachable; the app keeps serving local files where possible. Check the database connection or switch the workspace to Local-first storage.",
          }),
        );
      });
    };
    void getWorkspaceDb(trimmedWsId).then(
      async (wsDb) => {
        if (wsDb.source !== "workspace") {
          if (dbOptional) {
            settle(() => done());
            return;
          }
          // C3 local-first: registry-only workspaces (no DB URL) stay usable
          // for local paths; PG-backed routes degrade honestly downstream.
          try {
            const record = await getWorkspaceRecord(trimmedWsId);
            if (record && !record.databaseUrl?.trim()) {
              request.db = null;
              settle(() => done());
              return;
            }
          } catch {}
          fail(`Workspace database is not configured for workspace ${trimmedWsId}.`);
          return;
        }
        request.db = wsDb.db;
        settle(() => runWithDb(wsDb.db, done));
      },
      async (err: any) => {
        // C3: DATABASE_URL unset + registry-only workspace = local mode, not 503 here.
        try {
          const record = await getWorkspaceRecord(trimmedWsId);
          if (record && !record.databaseUrl?.trim()) {
            request.db = null;
            settle(() => done());
            return;
          }
        } catch {}
        fail(err?.message || `Workspace database is unreachable for workspace ${trimmedWsId}.`);
      },
    );
  });

  // Dual-boot honesty: PG-only surfaces degrade with explicit codes in local
  // tier instead of raw 500s. Registered after the tenant hook so workspaceId
  // is already resolved for per-workspace preference checks.
  try {
    const { registerLocalModeGuard } = await import("./shared/core/local-mode-guard.js");
    await registerLocalModeGuard(app);
  } catch {}

  // Local screenlock PIN — explicit opt-in (global LOCAL_PIN env and/or per-
  // workspace screenlock PIN). When nothing is configured the gate is disabled
  // and all requests pass; there is no insecure default PIN.
  pinGate.setWorkspacePinResolver((wsId) => getWorkspacePinHash(wsId));
  app.addHook("onRequest", pinGate.requirePin);

  // ── SEC-1 auth gate, MOUNTED (CrowdOS §19) ─────────────────────────────
  // requireAuth is a strict default-deny API-key check, but it was previously
  // registered on nothing, so every route was effectively unauthenticated while
  // the code advertised a gate. A default-deny gate that is never mounted is a
  // liability, not a control. It is registered globally here, after the tenant
  // and PIN hooks so request.workspaceId is resolved before identity is set.
  //
  // Trust model (§19 is a single-user local app): a keyless request from a
  // LOOPBACK peer is trusted, exactly as the socket handshake already trusts a
  // keyless loopback connection (shared/sockets/socket-auth.ts). The embedded
  // desktop backend listens on loopback only, so it keeps working keylessly;
  // every non-loopback caller must present a valid key. Exemptions below are the
  // pre-key portal/discovery surface the client needs to enumerate workspaces.
  app.addHook("onRequest", authGate.requireAuthMounted);

  // Rate limiting (per-IP, pin-independent)
  await registerRateLimit(app);

  // Register all REST routes
  await app.register(registerRoutes);

  const eventBroker = new EventBroker();
  setSharedBroker(eventBroker);
  // ── §29 local event log (single append hook) ───────────────────────────
  // One `onAny` subscriber owns persistence for the whole process, exactly as
  // the retired durable_events dual-write did: producers emit, the log decides
  // what is durable. Registered here (the factory every boot path uses —
  // index.ts dev, desktop embedded backend, tests) so no call site appends by
  // hand. Classification (ephemeral `message:stream`, channelId required) and
  // the append itself are owned by the Events domain; this line only wires it.
  // Fire-and-forget: local log lag must never block or fail live delivery.
  eventBroker.onAny((event) => eventsGate.recordDetached(event));
  initRuntime();
  // QUE-2: when QUEUE_MODE=bullmq, local maintenance timers are replaced by
  // BullMQ repeatable jobs (runs/maintenance). API skips timers and never
  // opens a Redis connection except via optional health probe.
  // P1a: inline starts sweepers + orphan sweeper + approval sweeper; bullmq
  // suppresses all local sweep timers; skipTimers suppresses regardless.
  const skipTimers = opts?.skipTimers ?? false;
  if (!skipTimers && !isBullMqApi) {
    startBudgetReconciler();
    try {
      await (runsGate as unknown as { startRunOrphanSweeper: (b: unknown) => Promise<void> }).startRunOrphanSweeper(eventBroker);
    } catch {}
    try {
      startApprovalSweeper(eventBroker);
    } catch {}
    // Dual-boot: drain the local→PG outbox while any database is reachable.
    // Replay ops are idempotent by construction, so a worker-side drain (when
    // one exists) can safely overlap. Success doubles as a health proof.
    try {
      const { drainOutbox } = await import("./shared/core/workspace-sync.js");
      const outboxTimer = setInterval(() => {
        void drainOutbox(null).catch((err) => app.log.warn({ err }, "Notice: outbox drain tick failed"));
      }, 30_000);
      outboxTimer.unref?.();
    } catch {}
  } else if (isBullMqApi) {
    // Single owner = worker: API never runs local sweep timers in bullmq
    // mode; the maintenance worker owns orphan/maintenance sweeps via
    // repeatables. If Redis is down the worker can't run, leaving zero
    // sweeps — log-and-alert instead of failing silently.
    app.log.info("[Queue] bullmq mode — local sweep timers suppressed (single owner = worker via repeatables)");
    try {
      const health = await Promise.race([
        queueGate.healthCheck(),
        new Promise<{ connected: boolean }>((resolve) => {
          const t = setTimeout(() => resolve({ connected: false }), 2000);
          t.unref?.();
        }),
      ]);
      if (!health.connected) {
        app.log.error("[Queue] bullmq mode — Redis unavailable, orphan/maintenance sweeps have no owner until the worker connects (single owner = worker)");
      }
    } catch (err) {
      app.log.error({ err }, "[Queue] bullmq mode — sweep ownership probe failed (Redis check)");
    }
  } else {
    app.log.info("[Server] local sweep timers skipped via skipTimers");
  }
  const io = registerSocketServer(app.server, eventBroker);

  const resolvedHost = opts?.host ?? "127.0.0.1";
  const resolvedPort = opts?.port ?? env.PORT;

  let stopped = false;
  // M5 listen-first: never block listen on VFS bootstrap; background it and
  // expose readiness so /health can gate on it. skipListen (tests) keeps the
  // old synchronous order for determinism.
  let vfsReady = false;
  async function start(): Promise<{ host: string; port: number }> {
    if (opts?.skipListen) {
      await bootstrapWorkspaces(app.log, resolvedWorkspaceDir);
      vfsReady = true;
      return { host: resolvedHost, port: resolvedPort };
    }
    try {
      await app.listen({ host: resolvedHost, port: resolvedPort });
    } catch (error) {
      app.log.error(error);
      throw error;
    }
    void bootstrapWorkspaces(app.log, resolvedWorkspaceDir).then(
      () => {
        vfsReady = true;
      },
      () => {
        vfsReady = true;
      },
    );
    const addr = app.server.address();
    if (addr && typeof addr === "object") {
      return { host: resolvedHost, port: (addr as { port: number }).port };
    }
    return { host: resolvedHost, port: resolvedPort };
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      (io as unknown as { engine?: { close?: () => void } })?.engine?.close?.();
    } catch {}
    try {
      await app.close();
    } catch {}
    try {
      await closeDatabaseConnection();
    } catch {}
    try {
      await closeAllWorkspaceDatabases();
    } catch {}
  }

  return { app, io, eventBroker, start, stop, isReady: () => vfsReady };
}

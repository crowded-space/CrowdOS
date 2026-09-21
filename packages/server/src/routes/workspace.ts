import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, closeDatabaseConnection } from "../shared/config/database.js";
import { localModeDegraded } from "../shared/core/local-mode-guard.js";
import { env } from "../shared/config/env.js";
import { workspaces, workspaceSettings } from "../db/schema.js";
import {
  listWorkspaces,
  getWorkspaceRecord,
  getWorkspaceDescriptor,
  saveWorkspaceRecord,
  removeWorkspaceRecord,
  testWorkspaceDatabaseConnection,
  provisionWorkspaceDatabase,
  withProvisionLock,
  seedWorkspacePresets,
  resetWorkspaceDatabase,
  parseWorkspaceDatabaseUrl,
  getWorkspaceDb,
  closeWorkspaceDatabase,
  getScreenLockStatus,
  setScreenLockPin,
  clearScreenLockPin,
  type WorkspaceRecord,
} from "../workspace/workspace-gate.js";

const updateSettingsSchema = z.object({
  globalSoftCap: z.number().int().min(0).optional(),
});

const budgetUpdateSchema = z.object({
  globalSoftCap: z.number().int().min(0).optional(),
  perProviderBudget: z.record(
    z.string(),
    z.object({
      softCap: z.number().int().min(0),
      used: z.number().int().min(0).optional(),
      resetPeriod: z.enum(["daily", "weekly", "monthly", "never"]),
      lastResetAt: z.string().optional(),
    })
  ).optional(),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required").max(100),
  icon: z.string().trim().min(1).max(50).optional().default("💼"),
  // C3 local-first (§17-18): DB is optional. Absent/empty = registry-only
  // local workspace; PG is RAG-only and chat degrades honestly until set.
  databaseUrl: z.string().trim().min(1).optional().default(""),
  rootPath: z.string().optional(),
});

const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().trim().min(1).max(50).optional(),
  databaseUrl: z.string().nullable().optional(),
  rootPath: z.string().optional(),
  // Dual-boot: "default" = dual-write w/ DB first-class; "local" = DB writes paused.
  storagePreference: z.enum(["default", "local"]).optional(),
});

const testDatabaseSchema = z.object({
  databaseUrl: z.string().min(1, "Database URL is required"),
});

const screenLockPinSchema = z.object({
  pin: z.string().min(1, "PIN is required"),
  currentPin: z.string().optional(),
});

const clearScreenLockPinSchema = z.object({
  currentPin: z.string().optional(),
}).optional();

function resolveRequestDb(request: FastifyRequest) {
  const req = request as any;
  // ponytail: fail closed on tenant DB errors; global fallback only when no workspace was requested.
  if (req.dbError) {
    const err: any = new Error(req.dbError);
    err.statusCode = 503;
    err.code = "WORKSPACE_DB_OFFLINE";
    throw err;
  }
  if (req.db) return req.db;
  try {
    return getDb();
  } catch {
    // Dual-boot honesty: single-DB settings/budget have no local tier —
    // surface degraded-with-suggestion instead of a raw 500 throw.
    const degraded: any = new Error(localModeDegraded("Workspace settings").message);
    degraded.statusCode = 503;
    degraded.code = "LOCAL_MODE_DEGRADED";
    degraded.suggestion =
      "Connect a database to this workspace (Workspace Overview → Database) to enable budgets and shared settings. Chat, channels, and files keep working locally.";
    throw degraded;
  }
}

export async function workspaceRoutes(app: FastifyInstance) {
  // ─── Workspace BYODB & Registry Endpoints ─────────────────────────

  // GET /api/workspaces - List all registered workspaces
  app.get("/api/workspaces", async (request, reply) => {
    try {
      const descriptors = await listWorkspaces();
      return descriptors;
    } catch (err: any) {
      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: err?.message || "Failed to list workspaces",
      });
    }
  });

  // POST /api/workspaces - Create workspace (DB-optional per local-first §17-18)
  app.post<{ Body: z.infer<typeof createWorkspaceSchema> }>(
    "/api/workspaces",
    { schema: { body: createWorkspaceSchema }, bodyLimit: 8_192, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { name, icon, rootPath } = request.body;
      const databaseUrl = (request.body.databaseUrl ?? "").trim();
      const hasDb = databaseUrl.length > 0;

      if (hasDb) {
        // 1. Validate DB URL structure
        try {
          parseWorkspaceDatabaseUrl(databaseUrl);
        } catch (err: any) {
          return reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: `Invalid workspace database URL: ${err?.message ?? err}`,
          });
        }

        // 2. Test database connection
        try {
          await testWorkspaceDatabaseConnection(databaseUrl);
        } catch (err: any) {
          return reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: `Invalid workspace database URL: ${err?.message ?? err}`,
          });
        }

        // 3. Auto-provision Drizzle schema migrations (serialized per target DB —
        // concurrent migrates wedge each other in DDL locks and abort partial).
        await withProvisionLock(databaseUrl, async () => {
          try {
            // ponytail: cold 16-migration run measures ~14s; 15s wedged fresh
            // workspaces into partial schema + partial seeds. 90s keeps margin
            // under the client's 120s fetch timeout.
            await provisionWorkspaceDatabase(databaseUrl, 90_000);
          } catch (err: any) {
            // In mock / offline test scenarios, don't hard-fail if migrations can't run
            request.log.warn({ err }, "Notice: provisionWorkspaceDatabase did not complete schema");
          }
        });
      }

      // 4. Generate workspace ID and sandbox directory
      const id = "ws_" + randomUUID().replace(/-/g, "").slice(0, 12);
      // ponytail: sandbox defaults under WORKSPACE_DIR (desktop: roaming app-data —
      // process.cwd() may point at a tree where file creation stalls for the host
      // process, which wedged creation with zero error and zero DB trace).
      const sandboxBase = process.env.WORKSPACE_DIR?.trim() || path.join(process.cwd(), "sandbox");
      const resolvedSandbox = rootPath || path.join(sandboxBase, id);

      // 5. Save to local workspaces.json registry FIRST so getWorkspaceDb(id)
      // resolves the new workspace pool (not global) for seeding.
      const record: WorkspaceRecord = {
        id,
        name,
        icon: icon || "💼",
        databaseUrl,
        rootPath: resolvedSandbox,
        screenLockPinHash: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveWorkspaceRecord(record);
      // ponytail: bounded mkdir — a stalled filesystem must degrade to
      // DB-backed creation, never wedge the request (filesystem lazily bootstraps).
      try {
        await Promise.race([
          fs.mkdir(resolvedSandbox, { recursive: true }),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error("sandbox mkdir timed out")), 10_000);
            t.unref?.();
          }),
        ]);
      } catch (err: any) {
        request.log.warn({ err }, "Notice: sandbox directory deferred, filesystem will bootstrap on first use");
      }

      // 6. Seed presets: attached database when one was given, else local
      // files (default category + #general + default-assistant) so a
      // registry-only workspace is immediately chattable (§2 portal flow).
      let dbMeta = { configured: false, host: "", database: "", port: null as number | null };
      if (!hasDb) {
        try {
          const { localCreateCategory } = await import("../channels/channel-local-store.js");
          const { localCreateChannel } = await import("../channels/channel-local-store.js");
          const { localSeedDefaultAgent } = await import("../agents/agent-local-store.js");
          const cat = await localCreateCategory({ name: "General", workspaceId: id, createdBy: "system", position: 0 });
          await localCreateChannel({ name: "general", type: "standard", createdBy: "system", categoryId: cat.id, workspaceId: id, position: 0 });
          await localSeedDefaultAgent();
        } catch (err: any) {
          request.log.warn({ err }, "Notice: local preset seeding skipped or deferred");
        }
      }
      if (hasDb) {
        await withProvisionLock(databaseUrl, async () => {
          try {
            const wsDbResult = await getWorkspaceDb(id);
            if (wsDbResult?.db) {
              await seedWorkspacePresets(wsDbResult.db, id);
            }
          } catch (err: any) {
            request.log.warn({ err }, "Notice: preset seeding skipped or deferred");
          }
        });

        // 7. Mirror to DB workspaces row if DB is reachable
        try {
          const parsed = parseWorkspaceDatabaseUrl(databaseUrl);
          dbMeta = {
            configured: true,
            host: parsed.host,
            port: parsed.port,
            database: parsed.database,
          };
          const { db } = await getWorkspaceDb(id);
          await db.insert(workspaces).values({
            id,
            name,
            ownerId: "system",
            rootPath: resolvedSandbox,
            metadata: { icon: icon || "💼", database: dbMeta },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch {}
      }

      // 8. Dual-boot pairing for fresh DB attaches (existing-DB content
      // matrix: pair/import/push/converge/conflict). Registry record already
      // saved above so evaluation can read it.
      let pairing: any = null;
      if (hasDb) {
        const { evaluateDbPairing } = await import("../shared/core/workspace-sync.js");
        pairing = await evaluateDbPairing(id).catch((err: any) => {
          request.log.warn({ err }, "Notice: DB pairing evaluation deferred");
          return null;
        });
      }

      const descriptor = await getWorkspaceDescriptor(id);
      return reply.status(201).send({
        ...descriptor,
        metadata: { database: dbMeta },
        pairing,
      });
    }
  );

  // GET /api/workspaces/:id - Get workspace details
  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params;
    const descriptor = await getWorkspaceDescriptor(id);
    if (descriptor) {
      return {
        ...descriptor,
        metadata: { database: descriptor.database },
      };
    }
    // Fallback probe against DB
    try {
      const db = resolveRequestDb(request);
      const row = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, id),
      });
      if (row) {
        return {
          id: row.id,
          name: row.name,
          icon: row.icon || "💼",
          screenLockEnabled: typeof row.screenLockPinHash === "string" && row.screenLockPinHash.length > 0,
          database: {
            configured: !!(row.metadata as any)?.database?.configured,
            host: (row.metadata as any)?.database?.host || "",
            database: (row.metadata as any)?.database?.database || "",
            port: (row.metadata as any)?.database?.port ?? null,
          },
          metadata: row.metadata,
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString(),
        };
      }
    } catch {}

    return reply.status(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Workspace ${id} not found`,
    });
  });

  // PATCH /api/workspaces/:id - Update workspace or database connection
  app.patch<{ Params: { id: string }; Body: z.infer<typeof patchWorkspaceSchema> }>(
    "/api/workspaces/:id",
    { schema: { body: patchWorkspaceSchema }, bodyLimit: 8_192, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, icon, databaseUrl, rootPath, storagePreference } = request.body;

      const record = await getWorkspaceRecord(id);
      let updatedDbMeta: any = undefined;

      if (databaseUrl === null) {
        // Disconnect DB
        await closeWorkspaceDatabase(id);
        if (record) {
          record.databaseUrl = "";
          record.dbSync = null;
          if (name !== undefined) record.name = name;
          if (icon !== undefined) record.icon = icon;
          if (rootPath !== undefined) record.rootPath = rootPath;
          if (storagePreference !== undefined) record.storagePreference = storagePreference;
          await saveWorkspaceRecord(record);
        }
        try {
          const db = resolveRequestDb(request);
          await db.update(workspaces).set({
            metadata: {},
            updatedAt: new Date(),
          }).where(eq(workspaces.id, id));
        } catch {}

        const descriptor = await getWorkspaceDescriptor(id);
        return {
          ...(descriptor || { id, name: record?.name ?? name ?? id, icon: record?.icon ?? icon ?? "💼" }),
          metadata: {},
        };
      }

      if (typeof databaseUrl === "string" && databaseUrl.trim()) {
        const trimmedUrl = databaseUrl.trim();
        parseWorkspaceDatabaseUrl(trimmedUrl);
        await testWorkspaceDatabaseConnection(trimmedUrl);
        await withProvisionLock(trimmedUrl, async () => {
          try {
            await provisionWorkspaceDatabase(trimmedUrl, 90_000);
          } catch {}
        });
        await closeWorkspaceDatabase(id);
        if (record) {
          record.databaseUrl = trimmedUrl;
        }
        const parsed = parseWorkspaceDatabaseUrl(trimmedUrl);
        updatedDbMeta = {
          configured: true,
          host: parsed.host,
          port: parsed.port,
          database: parsed.database,
        };
      }

      if (record) {
        if (name !== undefined) record.name = name;
        if (icon !== undefined) record.icon = icon;
        if (rootPath !== undefined) record.rootPath = rootPath;
        if (storagePreference !== undefined) record.storagePreference = storagePreference;
        await saveWorkspaceRecord(record);
      }

      try {
        const db = resolveRequestDb(request);
        const updatePayload: Record<string, any> = { updatedAt: new Date() };
        if (name !== undefined) updatePayload.name = name;
        if (icon !== undefined) updatePayload.icon = icon;
        if (rootPath !== undefined) updatePayload.rootPath = rootPath;
        if (updatedDbMeta) updatePayload.metadata = { database: updatedDbMeta };
        await db.update(workspaces).set(updatePayload).where(eq(workspaces.id, id));
      } catch {}

      // Dual-boot: a fresh attach (or URL change) evaluates pairing inline —
      // pair, import, push, converge, or quarantine on conflict. Attach is
      // already a long op (provision ~14s); pairing rides along. State is
      // also visible any time via GET db-sync.
      let pairing: any = null;
      if (typeof databaseUrl === "string" && databaseUrl.trim()) {
        const { evaluateDbPairing } = await import("../shared/core/workspace-sync.js");
        pairing = await evaluateDbPairing(id).catch((err: any) => {
          request.log.warn({ err }, "Notice: DB pairing evaluation deferred");
          return null;
        });
        if (pairing?.action === "conflict") {
          request.log.warn({ pairing }, "Workspace database conflict quarantined; serving local only");
        }
      }

      const descriptor = await getWorkspaceDescriptor(id);
      return {
        ...(descriptor || { id, name: record?.name ?? name ?? id, icon: record?.icon ?? icon ?? "💼" }),
        metadata: updatedDbMeta ? { database: updatedDbMeta } : undefined,
        pairing,
      };
    }
  );

  // DELETE /api/workspaces/:id - Disconnect and delete workspace
  app.delete<{ Params: { id: string }; Querystring: { flush?: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { flush } = request.query;

      const record = await getWorkspaceRecord(id);
      if (flush === "true" && record?.databaseUrl) {
        try {
          await resetWorkspaceDatabase(record.databaseUrl);
        } catch (err: any) {
          request.log.warn({ err }, "Notice: Failed to flush workspace database tables");
        }
      }

      await closeWorkspaceDatabase(id);
      await removeWorkspaceRecord(id);
      // ponytail: best-effort sandbox rm; remote PG untouched unless ?flush=true above.
      if (record?.rootPath) {
        try {
          await fs.rm(record.rootPath, { recursive: true, force: true });
        } catch (err: any) {
          request.log.warn({ err }, "Notice: sandbox cleanup skipped");
        }
      }

      try {
        const db = resolveRequestDb(request);
        await db.delete(workspaces).where(eq(workspaces.id, id));
      } catch {}

      return { success: true, message: "Workspace deleted successfully" };
    }
  );

  // POST /api/workspaces/database/test - Test connection without creating workspace
  app.post<{ Body: z.infer<typeof testDatabaseSchema> }>(
    "/api/workspaces/database/test",
    { schema: { body: testDatabaseSchema }, bodyLimit: 8_192, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { databaseUrl } = request.body;
      try {
        parseWorkspaceDatabaseUrl(databaseUrl);
      } catch (err: any) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: `Invalid workspace database URL: ${err?.message ?? err}`,
        });
      }

      try {
        const result = await testWorkspaceDatabaseConnection(databaseUrl);
        return { success: true, host: result.host, port: result.port, database: result.database };
      } catch (err: any) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: err?.message || "Connection failed",
        });
      }
    }
  );

  // ─── Screen Lock Endpoints ────────────────────────────────────────

  // GET /api/workspaces/:id/screen-lock - Get lock status
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/screen-lock", async (request, reply) => {
    const { id } = request.params;
    try {
      const status = await getScreenLockStatus(id);
      return status;
    } catch (err: any) {
      return reply.status(404).send({
        statusCode: 404,
        error: "Not Found",
        message: err?.message || "Workspace not found",
      });
    }
  });

  // POST /api/workspaces/:id/screen-lock - Set or update screen lock PIN
  app.post<{ Params: { id: string }; Body: z.infer<typeof screenLockPinSchema> }>(
    "/api/workspaces/:id/screen-lock",
    { schema: { body: screenLockPinSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const { pin, currentPin } = request.body;
      try {
        const status = await setScreenLockPin(id, pin, currentPin);
        return status;
      } catch (err: any) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: err?.message || "Failed to set screen lock PIN",
        });
      }
    }
  );

  // DELETE /api/workspaces/:id/screen-lock - Clear screen lock PIN
  app.delete<{ Params: { id: string }; Body?: z.infer<typeof clearScreenLockPinSchema> }>(
    "/api/workspaces/:id/screen-lock",
    async (request, reply) => {
      const { id } = request.params;
      const currentPin = (request.body as any)?.currentPin;
      try {
        const status = await clearScreenLockPin(id, currentPin);
        return status;
      } catch (err: any) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: err?.message || "Failed to clear screen lock PIN",
        });
      }
    }
  );

  // ─── Dual-Boot Sync Endpoints ─────────────────────────────────────

  const dbSyncActionSchema = z.object({
    action: z.enum(["resolve", "sync-now", "rebuild-rag"]),
    choice: z.enum(["flush-local", "flush-db", "change-db"]).optional(),
  });

  // GET /api/workspaces/:id/db-sync - Pairing state + backfill backlog
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/db-sync", async (request, reply) => {
    const { id } = request.params;
    const { tierContextFor: tierCtx } = await import("../workspace/workspace-gate.js");
    const { resolveTier, isUrlReachable } = await import("../shared/config/database.js");
    const { outboxBacklog } = await import("../shared/core/workspace-sync.js");
    const { OUTBOX_NOTICE_THRESHOLD } = await import("../shared/core/outbox.js");
    const record = await getWorkspaceRecord(id);
    if (!record) {
      return reply.status(404).send({ statusCode: 404, error: "Not Found", message: `Workspace ${id} not found` });
    }
    const ctx = await tierCtx(id);
    const { tier, url } = resolveTier(ctx);
    const backlog = await outboxBacklog(id).catch(() => 0);
    return {
      workspaceId: id,
      storagePreference: record.storagePreference === "local" ? "local" : "default",
      tier,
      dbConfigured: Boolean(url),
      dbReachable: isUrlReachable(url),
      dbSync: record.dbSync ?? null,
      backlog,
      backlogNotice: backlog >= OUTBOX_NOTICE_THRESHOLD,
      suggestion: !url
        ? "Connect a database to enable dual-boot sync and semantic memory."
        : undefined,
    };
  });

  // POST /api/workspaces/:id/db-sync - Resolve conflict / sync now / rebuild RAG
  app.post<{ Params: { id: string }; Body: z.infer<typeof dbSyncActionSchema> }>(
    "/api/workspaces/:id/db-sync",
    { schema: { body: dbSyncActionSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const { action, choice } = request.body;
      const record = await getWorkspaceRecord(id);
      if (!record) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: `Workspace ${id} not found` });
      }
      const sync = await import("../shared/core/workspace-sync.js");
      try {
        if (action === "resolve") {
          if (!choice) {
            return reply.status(400).send({
              statusCode: 400, error: "Bad Request",
              message: "choice is required: flush-local | flush-db | change-db",
            });
          }
          return await sync.resolveDbConflict(id, choice);
        }
        if (action === "sync-now") {
          return await sync.drainOutbox(id);
        }
        return await sync.rebuildWorkspaceRag(id);
      } catch (err: any) {
        const { isConnectionError } = await import("../shared/config/database.js");
        if (isConnectionError(err)) {
          return reply.status(503).send({
            statusCode: 503, error: "Service Unavailable", code: "WORKSPACE_DB_OFFLINE",
            message: err?.message || "Database unreachable; still serving local files.",
            suggestion: "Check the database connection, or continue working locally — pending writes will backfill on recovery.",
          });
        }
        return reply.status(500).send({ statusCode: 500, error: "Internal Server Error", message: err?.message || "Sync action failed" });
      }
    }
  );

  // ─── Workspace Settings & Budget (Tenant Bound) ───────────────────

  // GET /api/workspace/settings - Retrieve general configurations
  app.get("/api/workspace/settings", async (request, reply) => {
    const db = resolveRequestDb(request);
    const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) {
      return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
    }
    return settings;
  });

  // PUT /api/workspace/settings - Update general configurations
  app.put<{ Body: z.infer<typeof updateSettingsSchema> }>(
    "/api/workspace/settings",
    { schema: { body: updateSettingsSchema } },
    async (request, reply) => {
      const db = resolveRequestDb(request);
      const [settings] = await db
        .update(workspaceSettings)
        .set({
          ...request.body,
          updatedAt: new Date(),
        })
        .where(eq(workspaceSettings.id, "default"))
        .returning();
      if (!settings) {
        return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
      }
      return settings;
    }
  );

  // GET /api/workspace/budget - Retrieve token budgets
  app.get("/api/workspace/budget", async (request, reply) => {
    const db = resolveRequestDb(request);
    const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) {
      return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
    }
    return {
      globalSoftCap: settings.globalSoftCap,
      perProviderBudget: settings.perProviderBudget,
    };
  });

  // PUT /api/workspace/budget - Update token budgets and provider limits
  app.put<{ Body: z.infer<typeof budgetUpdateSchema> }>(
    "/api/workspace/budget",
    { schema: { body: budgetUpdateSchema } },
    async (request, reply) => {
      const db = resolveRequestDb(request);
      const now = new Date();
      const nowIso = now.toISOString();
      const updatedSettings: Record<string, any> = {
        updatedAt: now,
      };

      if (request.body.globalSoftCap !== undefined) {
        updatedSettings.globalSoftCap = request.body.globalSoftCap;
      }

      if (request.body.perProviderBudget !== undefined) {
        const entries = Object.entries(request.body.perProviderBudget);
        if (entries.length > 0) {
          let merged: any = workspaceSettings.perProviderBudget;
          for (const [provider, budget] of entries) {
            const value = sql`jsonb_build_object('softCap', ${budget.softCap}::integer, 'used', COALESCE(${budget.used ?? null}::integer, (${workspaceSettings.perProviderBudget} -> ${provider}::text ->> 'used')::integer, 0), 'resetPeriod', ${budget.resetPeriod}, 'lastResetAt', COALESCE(${(budget.lastResetAt || null) as string | null}::text, ${workspaceSettings.perProviderBudget} -> ${provider}::text ->> 'lastResetAt', ${nowIso}))`;
            merged = sql`${merged} || jsonb_build_object(${provider}, ${value})`;
          }
          updatedSettings.perProviderBudget = merged;
        }
      }

      const [res] = await db
        .update(workspaceSettings)
        .set(updatedSettings)
        .where(eq(workspaceSettings.id, "default"))
        .returning();
      if (!res) {
        return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
      }

      return res;
    }
  );

  // POST /api/workspace/budget/reset - Reset all provider token usage to 0
  app.post("/api/workspace/budget/reset", async (request, reply) => {
    const db = resolveRequestDb(request);
    const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) {
      return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
    }

    const currentBudget = settings.perProviderBudget as Record<string, any>;
    const resetBudget = { ...currentBudget };

    for (const provider of Object.keys(resetBudget)) {
      resetBudget[provider] = {
        ...resetBudget[provider],
        used: 0,
        lastResetAt: new Date().toISOString(),
      };
    }

    const [res] = await db
      .update(workspaceSettings)
      .set({
        perProviderBudget: resetBudget,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSettings.id, "default"))
      .returning();

    return res;
  });

  // POST /api/workspace/database - Single-DB hot-reload (legacy escape hatch)
  app.post<{ Body: { databaseUrl: string } }>(
    "/api/workspace/database",
    async (request, reply) => {
      const allowMutation = process.env.ENABLE_DB_CONFIG_MUTATION === "true";
      const adminToken = process.env.WORKSPACE_ADMIN_TOKEN;
      const providedToken = (request.headers["x-admin-token"] as string) || (request.headers["authorization"] as string)?.replace(/^Bearer\s+/i, "");

      if (!allowMutation || !adminToken) {
        return reply.status(403).send({
          success: false,
          error: "Forbidden",
          message: "Database configuration mutation is disabled. Set ENABLE_DB_CONFIG_MUTATION=true and WORKSPACE_ADMIN_TOKEN to enable (admin only).",
        });
      }
      if (providedToken !== adminToken) {
        return reply.status(401).send({ success: false, error: "Unauthorized", message: "Invalid admin token." });
      }

      const { databaseUrl: newUrl } = request.body;

      try {
        const parsed = new URL(newUrl);
        if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
          return reply.status(400).send({ success: false, error: "Bad Request", message: "DATABASE_URL must be a postgres:// URL" });
        }
      } catch {
        return reply.status(400).send({ success: false, error: "Bad Request", message: "Invalid DATABASE_URL format" });
      }

      const oldUrl = env.DATABASE_URL;
      try {
        await closeDatabaseConnection();
        request.log.warn({ adminTokenProvided: !!providedToken }, "[SECURITY] Admin requested DATABASE_URL hot-reload");
        env.DATABASE_URL = newUrl;
        process.env.DATABASE_URL = newUrl;

        const db = getDb();
        await db.select().from(workspaceSettings).limit(1);

        return {
          success: true,
          message: "Database connection verified (NOT persisted). Manually update .env and restart to persist.",
        };
      } catch (error) {
        await closeDatabaseConnection();
        env.DATABASE_URL = oldUrl;
        process.env.DATABASE_URL = oldUrl;
        return reply.status(400).send({
          success: false,
          error: "Bad Request",
          message: `Database connection verification failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  );
}

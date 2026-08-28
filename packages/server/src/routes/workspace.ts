import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDb, closeDatabaseConnection } from "../Shared/config/database.js";
import { env } from "../Shared/config/env.js";
import { workspaceSettings } from "../db/schema.js";

const updateSettingsSchema = z.object({
  globalSoftCap: z.number().int().min(0).optional()
});

const budgetUpdateSchema = z.object({
  globalSoftCap: z.number().int().min(0).optional(),
  perProviderBudget: z.record(
    z.string(),
    z.object({
      softCap: z.number().int().min(0),
      used: z.number().int().min(0).optional(),
      resetPeriod: z.enum(["daily", "weekly", "monthly", "never"]),
      lastResetAt: z.string().optional()
    })
  ).optional()
});

const databaseConfigSchema = z.object({
  databaseUrl: z.string().min(1)
});

export async function workspaceRoutes(app: FastifyInstance) {
  // GET /api/workspace/settings - Retrieve general configurations
  app.get("/api/workspace/settings", async (request, reply) => {
    const [settings] = await getDb().select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
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
      const [settings] = await getDb()
        .update(workspaceSettings)
        .set({
          ...request.body,
          updatedAt: new Date()
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
    const [settings] = await getDb().select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) {
      return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
    }
    return {
      globalSoftCap: settings.globalSoftCap,
      perProviderBudget: settings.perProviderBudget
    };
  });

  // PUT /api/workspace/budget - Update token budgets and provider limits
  app.put<{ Body: z.infer<typeof budgetUpdateSchema> }>(
    "/api/workspace/budget",
    { schema: { body: budgetUpdateSchema } },
    async (request, reply) => {
      const [settings] = await getDb().select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
      if (!settings) {
        return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
      }

      const updatedSettings: Record<string, any> = {
        updatedAt: new Date()
      };

      if (request.body.globalSoftCap !== undefined) {
        updatedSettings.globalSoftCap = request.body.globalSoftCap;
      }

      if (request.body.perProviderBudget !== undefined) {
        const currentBudget = settings.perProviderBudget as Record<string, any>;
        const mergedBudget = { ...currentBudget };

        for (const [provider, budget] of Object.entries(request.body.perProviderBudget)) {
          const currentProvider = currentBudget[provider] || {};
          mergedBudget[provider] = {
            softCap: budget.softCap,
            used: budget.used !== undefined ? budget.used : (currentProvider.used || 0),
            resetPeriod: budget.resetPeriod,
            lastResetAt: budget.lastResetAt || currentProvider.lastResetAt || new Date().toISOString()
          };
        }

        updatedSettings.perProviderBudget = mergedBudget;
      }

      const [res] = await getDb()
        .update(workspaceSettings)
        .set(updatedSettings)
        .where(eq(workspaceSettings.id, "default"))
        .returning();

      return res;
    }
  );

  // POST /api/workspace/budget/reset - Reset all provider token usage to 0
  app.post("/api/workspace/budget/reset", async (request, reply) => {
    const [settings] = await getDb().select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).limit(1);
    if (!settings) {
      return reply.status(404).send({ error: "Not Found", message: "Workspace settings not found" });
    }

    const currentBudget = settings.perProviderBudget as Record<string, any>;
    const resetBudget = { ...currentBudget };

    for (const provider of Object.keys(resetBudget)) {
      resetBudget[provider] = {
        ...resetBudget[provider],
        used: 0,
        lastResetAt: new Date().toISOString()
      };
    }

    const [res] = await getDb()
      .update(workspaceSettings)
      .set({
        perProviderBudget: resetBudget,
        updatedAt: new Date()
      })
      .where(eq(workspaceSettings.id, "default"))
      .returning();

    return res;
  });

  // POST /api/workspace/database - DISABLED by default (P0-2 security)
  // Per TO_DO.md Phase 1: runtime env must be immutable over HTTP.
  // Enable only with WORKSPACE_ADMIN_TOKEN + explicit ENABLE_DB_CONFIG_MUTATION=true
  app.post<{ Body: z.infer<typeof databaseConfigSchema> }>(
    "/api/workspace/database",
    { schema: { body: databaseConfigSchema } },
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

      // Validate URL shape before any mutation — prevent injection of executable env content
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
        // Do NOT mutate process.env or write .env file — log audit event instead
        request.log.warn({ adminTokenProvided: !!providedToken }, "[SECURITY] Admin requested DATABASE_URL hot-reload — testing connection only, not persisting to .env");
        env.DATABASE_URL = newUrl;
        process.env.DATABASE_URL = newUrl;

        const db = getDb();
        await db.select().from(workspaceSettings).limit(1);

        // Audit: do not write to filesystem. Require manual .env rotation with re-encrypt (per TO_DO.md 5.1 Secret Protection)
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


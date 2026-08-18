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

  // POST /api/workspace/database - Dynamic database connection hot-reload and verify
  app.post<{ Body: z.infer<typeof databaseConfigSchema> }>(
    "/api/workspace/database",
    { schema: { body: databaseConfigSchema } },
    async (request, reply) => {
      const { databaseUrl: newUrl } = request.body;
      const oldUrl = env.DATABASE_URL;

      try {
        await closeDatabaseConnection();
        env.DATABASE_URL = newUrl;
        process.env.DATABASE_URL = newUrl;

        const db = getDb();
        await db.select().from(workspaceSettings).limit(1);

        const envPath = path.resolve(process.cwd(), ".env");
        let envContent = "";
        try {
          envContent = await fs.readFile(envPath, "utf8");
        } catch {
        }

        const lines = envContent.split(/\r?\n/);
        let urlUpdated = false;
        const newLines = lines.map((line) => {
          if (line.trim().startsWith("DATABASE_URL=")) {
            urlUpdated = true;
            return `DATABASE_URL="${newUrl}"`;
          }
          return line;
        });

        if (!urlUpdated) {
          newLines.push(`DATABASE_URL="${newUrl}"`);
        }

        await fs.writeFile(envPath, newLines.join("\n"), "utf8");

        return {
          success: true,
          message: "Database connection hot-reload verified successfully and saved to configuration."
        };
      } catch (error) {
        await closeDatabaseConnection();
        env.DATABASE_URL = oldUrl;
        process.env.DATABASE_URL = oldUrl;

        return reply.status(400).send({
          success: false,
          error: "Bad Request",
          message: `Database connection verification failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  );
}


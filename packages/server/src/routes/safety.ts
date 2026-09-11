import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../shared/config/database.js";
import { channelSettings, workspaceSafetySettings, approvalGrants } from "../db/schema.js";

const fsPolicySchema = z.object({
  requireApprovalFor: z.array(z.enum(["write", "delete", "execute"])).default(["delete", "execute"]),
  autoAllowPaths: z.array(z.string()).default([]),
  blockPaths: z.array(z.string()).default([]),
});

const channelSafetySchema = z.object({
  fsPolicy: fsPolicySchema.optional(),
  safetySettings: z.object({
    defaultApprovalScope: z.enum(["once", "session", "channel", "workspace", "global"]).default("session"),
    allowInheritCategoryMount: z.boolean().default(true),
  }).optional(),
});

const workspaceSafetySchema = z.object({
  fsPolicy: fsPolicySchema.optional(),
  approvalDefaults: z.object({
    defaultScope: z.enum(["once", "session", "channel", "workspace", "global"]).default("session"),
    allowGlobalAlwaysAllow: z.boolean().default(false),
  }).optional(),
});

const grantsQuerySchema = z.object({
  workspaceId: z.string().optional(),
  channelId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function safetyRoutes(app: FastifyInstance) {
  // Channel safety
  app.get<{ Params: { id: string } }>("/api/channels/:id/safety", async (request, reply) => {
    const db = getDb();
    const row = await db.query.channelSettings.findFirst({ where: eq(channelSettings.channelId, request.params.id) });
    if (!row) return { channelId: request.params.id, fsPolicy: { requireApprovalFor: ["delete","execute"], autoAllowPaths: [], blockPaths: [] }, safetySettings: { defaultApprovalScope: "session", allowInheritCategoryMount: true } };
    return row;
  });

  app.put<{ Params: { id: string }; Body: z.infer<typeof channelSafetySchema> }>("/api/channels/:id/safety", { schema: { body: channelSafetySchema } }, async (request, reply) => {
    const db = getDb();
    const existing = await db.query.channelSettings.findFirst({ where: eq(channelSettings.channelId, request.params.id) });
    const payload: any = { channelId: request.params.id, updatedAt: new Date() };
    if (request.body.fsPolicy) payload.fsPolicy = request.body.fsPolicy;
    if (request.body.safetySettings) payload.safetySettings = request.body.safetySettings;
    if (!existing) {
      const [inserted] = await db.insert(channelSettings).values({
        channelId: request.params.id,
        fsPolicy: payload.fsPolicy ?? { requireApprovalFor: ["delete","execute"], autoAllowPaths: [], blockPaths: [] },
        safetySettings: payload.safetySettings ?? { defaultApprovalScope: "session", allowInheritCategoryMount: true },
        updatedAt: new Date(),
      }).returning();
      return inserted;
    }
    const [updated] = await db.update(channelSettings).set(payload).where(eq(channelSettings.channelId, request.params.id)).returning();
    return updated;
  });

  // Workspace safety
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/safety", async (request, reply) => {
    const db = getDb();
    const row = await db.query.workspaceSafetySettings.findFirst({ where: eq(workspaceSafetySettings.workspaceId, request.params.id) });
    if (!row) return { workspaceId: request.params.id, fsPolicy: { requireApprovalFor: ["delete","execute"], autoAllowPaths: [], blockPaths: [] }, approvalDefaults: { defaultScope: "session", allowGlobalAlwaysAllow: false } };
    return row;
  });

  app.put<{ Params: { id: string }; Body: z.infer<typeof workspaceSafetySchema> }>("/api/workspaces/:id/safety", { schema: { body: workspaceSafetySchema } }, async (request, reply) => {
    const db = getDb();
    const existing = await db.query.workspaceSafetySettings.findFirst({ where: eq(workspaceSafetySettings.workspaceId, request.params.id) });
    const payload: any = { workspaceId: request.params.id, updatedAt: new Date() };
    if (request.body.fsPolicy) payload.fsPolicy = request.body.fsPolicy;
    if (request.body.approvalDefaults) payload.approvalDefaults = request.body.approvalDefaults;
    if (!existing) {
      const [inserted] = await db.insert(workspaceSafetySettings).values({
        workspaceId: request.params.id,
        fsPolicy: payload.fsPolicy ?? { requireApprovalFor: ["delete","execute"], autoAllowPaths: [], blockPaths: [] },
        approvalDefaults: payload.approvalDefaults ?? { defaultScope: "session", allowGlobalAlwaysAllow: false },
        updatedAt: new Date(),
      }).returning();
      return inserted;
    }
    const [updated] = await db.update(workspaceSafetySettings).set(payload).where(eq(workspaceSafetySettings.workspaceId, request.params.id)).returning();
    return updated;
  });

  // Grants management
  app.get<{ Querystring: z.infer<typeof grantsQuerySchema> }>("/api/approvals/grants", { schema: { querystring: grantsQuerySchema } }, async (request) => {
    const db = getDb();
    const workspaceId = request.query?.workspaceId as string | undefined;
    const channelId = request.query?.channelId as string | undefined;
    const limit = Math.min(200, request.query?.limit ?? 100);
    const filters = [];
    if (workspaceId) filters.push(eq(approvalGrants.workspaceId, workspaceId));
    if (channelId) filters.push(eq(approvalGrants.channelId, channelId));
    const rows = await db.query.approvalGrants.findMany({ where: filters.length ? and(...filters) : undefined, limit });
    return { grants: rows };
  });

  app.delete<{ Params: { id: string } }>("/api/approvals/grants/:id", async (request, reply) => {
    const db = getDb();
    const row = await db.query.approvalGrants.findFirst({ where: eq(approvalGrants.id, request.params.id) });
    if (!row) return reply.status(404).send({ error: "Not Found", message: "Grant not found" });
    await db.delete(approvalGrants).where(eq(approvalGrants.id, request.params.id));
    return { success: true };
  });
}

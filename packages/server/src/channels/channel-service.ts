import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, isDatabaseConfigured } from "../shared/config/database.js";
import { categories, channels } from "../db/schema.js";
import type { CreateChannelBody, UpdateChannelBody } from "./channel-validators.js";
import {
  localCategoryExists,
  localCreateCategory,
  localCreateChannel,
  localDeleteChannel,
  localGetCategory,
  localGetChannel,
  localListCategories,
  localListCategoriesWithChannels,
  localListChannels,
  localRemoveCategory,
  localUpdateCategory,
  localUpdateChannel,
} from "./channel-local-store.js";

/** C3 local-first: file truth when no DATABASE_URL is configured. */
function useLocalDb(dbOverride?: any): boolean {
  return !dbOverride && !isDatabaseConfigured();
}

export async function categoryExists(categoryId: string, dbOverride?: any): Promise<boolean> {
  if (useLocalDb(dbOverride)) return localCategoryExists(categoryId);
  const db = dbOverride || getDb();
  const category = await db.query.categories.findFirst({
    where: eq(categories.id, categoryId),
  });
  return Boolean(category);
}

export async function getCategoryById(id: string, dbOverride?: any): Promise<any | null> {
  if (useLocalDb(dbOverride)) return localGetCategory(id);
  const db = dbOverride || getDb();
  return db.query.categories.findFirst({ where: eq(categories.id, id) });
}

export async function listCategories(opts?: { limit?: number; offset?: number; workspaceId?: string | null; db?: any }) {
  if (useLocalDb(opts?.db)) return localListCategoriesWithChannels(opts);
  const db = opts?.db || getDb();
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const offset = Math.max(0, opts?.offset ?? 0);
  return db.query.categories.findMany({
    with: {
      channels: {
        orderBy: (table: any, { asc }: any) => [asc(table.position)],
        limit: 100,
      },
    },
    orderBy: (table: any, { asc }: any) => [asc(table.position)],
    limit,
    offset,
  });
}

export async function createCategory(
  body: { name: string; workspaceId?: string | null; ownedByAgentId?: string | null; embeddingProfileId?: string | null; createdBy: string; position?: number },
  dbOverride?: any,
) {
  if (useLocalDb(dbOverride)) return localCreateCategory(body as any);
  const db = dbOverride || getDb();
  const id = randomUUID();
  const [res] = await db
    .insert(categories)
    .values({
      id,
      name: body.name,
      workspaceId: body.workspaceId ?? null,
      ownedByAgentId: body.ownedByAgentId ?? null,
      embeddingProfileId: body.embeddingProfileId ?? null,
      createdBy: body.createdBy,
      position: body.position ?? 0,
    })
    .returning();
  return res;
}

export async function updateCategory(
  id: string,
  patch: { name?: string; ownedByAgentId?: string | null; embeddingProfileId?: string | null; position?: number; folderPath?: string | null },
  dbOverride?: any,
) {
  if (useLocalDb(dbOverride)) return localUpdateCategory(id, patch);
  const db = dbOverride || getDb();
  const updateData: Partial<typeof categories.$inferInsert> = {};
  if (patch.name !== undefined) updateData.name = patch.name;
  if (patch.ownedByAgentId !== undefined) updateData.ownedByAgentId = patch.ownedByAgentId;
  if (patch.embeddingProfileId !== undefined) updateData.embeddingProfileId = patch.embeddingProfileId;
  if (patch.position !== undefined) updateData.position = patch.position;
  if (patch.folderPath !== undefined) updateData.folderPath = patch.folderPath;
  const [updated] = await db.update(categories).set(updateData).where(eq(categories.id, id)).returning();
  return updated ?? null;
}

export async function removeCategory(id: string, dbOverride?: any): Promise<boolean> {
  if (useLocalDb(dbOverride)) return localRemoveCategory(id);
  const db = dbOverride || getDb();
  const { withTransaction } = await import("../shared/config/database.js");
  const deleted = await withTransaction(async (tx: any) => {
    await tx.delete(channels).where(eq(channels.categoryId, id));
    return tx.delete(categories).where(eq(categories.id, id)).returning();
  });
  return deleted.length > 0;
}

export async function listChannels(opts?: { limit?: number; cursor?: string | null; db?: any }) {
  if (useLocalDb(opts?.db)) return localListChannels(opts);
  const db = opts?.db || getDb();
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  // Keyset on (position,id); old numeric offset cursors still accepted via offset fallback.
  let offset: number | undefined;
  let keyset: ReturnType<typeof and> | undefined;
  if (opts?.cursor) {
    const raw = String(opts.cursor);
    const sep = raw.indexOf(":");
    if (sep > 0) {
      const pos = Number(raw.slice(0, sep));
      const id = raw.slice(sep + 1);
      if (Number.isFinite(pos) && id) {
        keyset = and(isNull(channels.archivedAt), sql`(${channels.position}, ${channels.id}) > (${pos}, ${id})`) as any;
      }
    } else {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) offset = Math.floor(parsed);
    }
  }
  return db.query.channels.findMany({
    where: (keyset as any) ?? isNull(channels.archivedAt),
    orderBy: (table: any, { asc }: any) => [asc(table.position), asc(table.id)],
    limit,
    ...(offset ? { offset } : {}),
  });
}

export async function createChannel(body: CreateChannelBody, dbOverride?: any, workspaceId?: string | null) {
  if (useLocalDb(dbOverride)) return localCreateChannel({ ...(body as any), workspaceId });
  const db = dbOverride || getDb();
  const [categoryOk, existingSameName] = await Promise.all([
    body.categoryId ? categoryExists(body.categoryId, db) : Promise.resolve(true),
    db.query.channels.findFirst({
      where: (table: any, { and, eq, isNull }: any) => and(
        eq(table.name, body.name.trim().toLowerCase()),
        body.categoryId ? eq(table.categoryId, body.categoryId) : isNull(table.categoryId)
      )
    }),
  ]);
  if (body.categoryId && !categoryOk) {
    return { error: "category", categoryId: body.categoryId } as const;
  }
  if (existingSameName) {
    return { error: "duplicate_name", name: body.name } as const;
  }

  const id = randomUUID();
  const [res] = await db
    .insert(channels)
    .values({
      id,
      categoryId: body.categoryId ?? null,
      name: body.name,
      type: body.type,
      createdBy: body.createdBy,
      position: body.position,
    })
    .returning();
  return { channel: res } as const;
}

export async function getChannel(id: string, dbOverride?: any) {
  if (useLocalDb(dbOverride)) return localGetChannel(id);
  const db = dbOverride || getDb();
  return db.query.channels.findFirst({
    where: eq(channels.id, id),
  });
}

export async function updateChannel(id: string, body: UpdateChannelBody, dbOverride?: any) {
  if (useLocalDb(dbOverride)) return localUpdateChannel(id, body as any);
  const db = dbOverride || getDb();
  const [existing, categoryOk] = await Promise.all([
    getChannel(id, db),
    body.categoryId ? categoryExists(body.categoryId, db) : Promise.resolve(true),
  ]);
  if (!existing) return { notFound: true } as const;

  if (body.categoryId && !categoryOk) {
    return { error: "category", categoryId: body.categoryId } as const;
  }

  const updateData: Partial<typeof channels.$inferInsert> = {};
  if (body.categoryId !== undefined) updateData.categoryId = body.categoryId;
  if ((body as any).folderPath !== undefined) updateData.folderPath = (body as any).folderPath;
  if (body.name !== undefined) updateData.name = body.name;
  if (body.position !== undefined) updateData.position = body.position;
  if (body.type !== undefined) {
    updateData.type = body.type;
    updateData.archivedAt = body.type === "archived" ? new Date() : null;
  }

  const [updated] = await db
    .update(channels)
    .set(updateData)
    .where(eq(channels.id, id))
    .returning();

  return { channel: updated } as const;
}

export async function deleteChannel(id: string, dbOverride?: any) {
  if (useLocalDb(dbOverride)) return localDeleteChannel(id);
  const db = dbOverride || getDb();
  const existing = await getChannel(id, db);
  if (!existing) return { notFound: true } as const;

  if (existing.categoryId === null && existing.name.toLowerCase() === "general") {
    return { conflictGeneral: true } as const;
  }

  const deleted = await db
    .delete(channels)
    .where(eq(channels.id, id))
    .returning();
  if (deleted.length === 0) return { notFound: true } as const;
  return { deleted: true } as const;
}

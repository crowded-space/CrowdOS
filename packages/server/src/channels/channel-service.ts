import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../shared/config/database.js";
import { categories, channels } from "../db/schema.js";
import type { CreateChannelBody, UpdateChannelBody } from "./channel-validators.js";

export async function categoryExists(categoryId: string, dbOverride?: any): Promise<boolean> {
  const db = dbOverride || getDb();
  const category = await db.query.categories.findFirst({
    where: eq(categories.id, categoryId),
  });
  return Boolean(category);
}

export async function listChannels(opts?: { limit?: number; cursor?: string | null; db?: any }) {
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

export async function createChannel(body: CreateChannelBody, dbOverride?: any) {
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
  const db = dbOverride || getDb();
  return db.query.channels.findFirst({
    where: eq(channels.id, id),
  });
}

export async function updateChannel(id: string, body: UpdateChannelBody, dbOverride?: any) {
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

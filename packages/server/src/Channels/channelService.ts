import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../Shared/config/database.js";
import { categories, channels } from "../db/schema.js";
import type { CreateChannelBody, UpdateChannelBody } from "./channelValidators.js";

export async function categoryExists(categoryId: string): Promise<boolean> {
  const db = getDb();
  const category = await db.query.categories.findFirst({
    where: eq(categories.id, categoryId),
  });
  return Boolean(category);
}

export async function listChannels() {
  const db = getDb();
  return db.query.channels.findMany({
    orderBy: (table, { asc }) => [asc(table.position)],
  });
}

export async function createChannel(body: CreateChannelBody) {
  const db = getDb();
  if (body.categoryId && !(await categoryExists(body.categoryId))) {
    return { error: "category", categoryId: body.categoryId } as const;
  }

  // Duplicate name validation within same category scope
  const existingSameName = await db.query.channels.findFirst({
    where: (table, { and, eq, isNull }) => and(
      eq(table.name, body.name.trim().toLowerCase()),
      body.categoryId ? eq(table.categoryId, body.categoryId) : isNull(table.categoryId)
    )
  });
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

export async function getChannel(id: string) {
  const db = getDb();
  return db.query.channels.findFirst({
    where: eq(channels.id, id),
  });
}

export async function updateChannel(id: string, body: UpdateChannelBody) {
  const db = getDb();
  const existing = await getChannel(id);
  if (!existing) return { notFound: true } as const;

  if (body.categoryId && !(await categoryExists(body.categoryId))) {
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

export async function deleteChannel(id: string) {
  const db = getDb();
  const existing = await getChannel(id);
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

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, dualWrite, isSchemaMismatchError, isNoDatabaseError } from "../shared/config/database.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { categories, channels, channelSettings } from "../db/schema.js";
import type { CreateChannelBody, UpdateChannelBody } from "./channel-validators.js";
import { fsMountsSchema } from "./channel-validators.js";
import type { FsMountsBody } from "./channel-validators.js";
import {
  localGetChannelSettings,
  localUpsertChannelSettings,
  localCategoryExists,
  localCreateCategory,
  localCreateChannel,
  localDeleteChannel,
  localGetCategory,
  localGetChannel,
  localListCategoriesWithChannels,
  localChannelListSnapshot,
  localListChannels,
  localRemoveCategory,
  localUpdateCategory,
  localUpdateChannel,
} from "./channel-local-store.js";

// Dual-boot reads: explicit handle pins PG exactly (tests/seeds/replay).
// Otherwise local-first-miss→PG for gets (local wins, PG covers legacy rows)
// and merged unions for lists (dedupe by id, local wins). Writes dual-write
// (PG then local mirror, outbox on PG outage) unless preference forces local.

/** Null on any PG failure (sync throw or rejection): local tier must never 500 on a dead database. */
async function pgCatchNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// CHN-007: optional workspace scope. Unscoped keeps legacy behavior for
// existing callers; scoped rejects cross-workspace parent references.
export async function categoryExists(categoryId: string, dbOverride?: any, workspaceId?: string | null): Promise<boolean> {
  if (dbOverride) {
  try {
    const category = await dbOverride.query.categories.findFirst({
      where: eq(categories.id, categoryId),
    });
    if (!category) return false;
    if (workspaceId && (category as any).workspaceId && (category as any).workspaceId !== workspaceId) return false;
    return true;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; categoryExists served locally`);
  }
  }
  const local = await localCategoryExists(categoryId).catch(() => false);
  if (local && !workspaceId) return true;
  if (local && workspaceId) {
    try {
      const { localListCategoriesWithChannels } = await import("./channel-local-store.js");
      const cats = await (localListCategoriesWithChannels as (o: unknown) => Promise<any[]> )({ workspaceId });
      if (cats.some((c) => c.id === categoryId)) return true;
    } catch {}
  }
  if (workspaceId) {
    const tenant = await pgCatchNull(() => resolveCategoryForRead(categoryId, workspaceId));
    if (tenant) return true;
    // A scoped miss stays scoped: the global pool must not rescue a category
    // that does not belong to this workspace.
    return false;
  }
  const found = await pgCatchNull(() =>
    getDb().query.categories.findFirst({ where: eq(categories.id, categoryId) }),
  );
  if (!found) return false;
  return true;
}

async function resolveCategoryForRead(categoryId: string, workspaceId?: string | null) {
  if (!workspaceId) {
    return getDb().query.categories.findFirst({ where: eq(categories.id, categoryId) });
  }
  const { dbForWorkspace } = await import("../shared/config/database.js");
  try {
    const db = await dbForWorkspace(workspaceId);
    return db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
  } catch (err) {
    // Local-only workspace: no tenant database exists, so behave exactly
    // like a miss on the replica leg and let the local tier decide.
    if (isNoDatabaseError(err)) return null;
    throw err;
  }
}

export async function getCategoryById(id: string, dbOverride?: any): Promise<any | null> {
  if (dbOverride) {
    try {
      return await dbOverride.query.categories.findFirst({ where: eq(categories.id, id) });
    } catch (err) {
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[channels] tenant PG schema missing; getCategoryById served locally`);
    }
  }
  return (await localGetCategory(id)) ?? (await pgCatchNull(() => getDb().query.categories.findFirst({ where: eq(categories.id, id) })));
}

export async function listCategories(opts?: { limit?: number; offset?: number; workspaceId?: string | null; db?: any }) {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const offset = Math.max(0, opts?.offset ?? 0);
  if (opts?.db) {
  try {
    return await opts.db.query.categories.findMany({
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
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; serving local categories`);
  }
  }
  const [pgCats, localCats] = await Promise.all([
    pgCatchNull(() =>      getDb().query.categories.findMany({
        with: {
          channels: {
            orderBy: (table: any, { asc }: any) => [asc(table.position)],
            limit: 100,
          },
        },
        orderBy: (table: any, { asc }: any) => [asc(table.position)],
        limit,
        offset,
      }),
    ).then((rows) => rows ?? []),
    localListCategoriesWithChannels(opts),
  ]);
  const byId = new Map<string, any>();
  for (const c of pgCats) byId.set(c.id, c);
  for (const c of localCats) byId.set(c.id, c);
  return [...byId.values()]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .slice(offset, offset + limit);
}

export async function createCategory(
  body: { name: string; workspaceId?: string | null; ownedByAgentId?: string | null; embeddingProfileId?: string | null; createdBy: string; position?: number },
  dbOverride?: any,
) {
  if (!dbOverride && !(body.workspaceId && String(body.workspaceId).trim())) {
    // Tenant guard (QA audit 2026-09-23): a headerless POST used to fall
    // through to the default scope and silently misfile the row. Fail
    // loudly here so the route never reports success for a misfiled write.
    throw new Error("createCategory: workspaceId is required (refusing to write to the default scope)");
  }
  const id = randomUUID();
  const now = new Date();
  const pgValues = {
    id,
    name: body.name,
    workspaceId: body.workspaceId ?? null,
    ownedByAgentId: body.ownedByAgentId ?? null,
    embeddingProfileId: body.embeddingProfileId ?? null,
    createdBy: body.createdBy,
    position: body.position ?? 0,
    createdAt: now,
  };
  if (dbOverride) {
  try {
    const [res] = await dbOverride.insert(categories).values(pgValues).returning();
    return res;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; createCategory served locally`);
  }
  }
  const ctx = await tierContextFor(body.workspaceId ?? null);
  // CHN-006: pre-check so a duplicate never reaches dualWrite (which would
  // run the PG leg even when local returns a guard union).
  if (body.workspaceId) {
    try {
      const { localListCategoriesWithChannels } = await import("./channel-local-store.js");
      const cats = await (localListCategoriesWithChannels as (o: unknown) => Promise<any[]> )({ workspaceId: body.workspaceId });
      if (cats.some((c) => String(c.name).trim().toLowerCase() === String(body.name).trim().toLowerCase())) {
        return { error: "duplicate_name", name: body.name } as const;
      }
    } catch {}
  }
  return dualWrite({
    ctx,
    entity: "category",
    op: "upsert",
    id,
    row: { ...pgValues, folderPath: null, createdAt: now.toISOString() },
    pgWrite: async () => {
      const db = getDb();
      await db.insert(categories).values(pgValues);
    },
    localWrite: () => localCreateCategory({ ...(body as any), id }),
  });
}

export async function updateCategory(
  id: string,
  patch: {
    name?: string;
    ownedByAgentId?: string | null;
    embeddingProfileId?: string | null;
    position?: number;
    folderPath?: string | null;
    /** Canon virtual mount set (inherit/override chain). */
    fsMounts?: FsMountsBody;
  },
  dbOverride?: any,
) {
  if (dbOverride) {
  try {
    const db = dbOverride;
    const updateData: Partial<typeof categories.$inferInsert> = {};
    if (patch.name !== undefined) updateData.name = patch.name;
    if (patch.ownedByAgentId !== undefined) updateData.ownedByAgentId = patch.ownedByAgentId;
    if (patch.embeddingProfileId !== undefined) updateData.embeddingProfileId = patch.embeddingProfileId;
    if (patch.position !== undefined) updateData.position = patch.position;
    if (patch.folderPath !== undefined) updateData.folderPath = patch.folderPath;
    if (patch.fsMounts !== undefined) updateData.fsMounts = patch.fsMounts;
    const [updated] = await db.update(categories).set(updateData).where(eq(categories.id, id)).returning();
    return updated ?? null;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; updateCategory ${id} served locally`);
  }
  }
  const existing = await getCategoryById(id);
  if (!existing) return null;
  const ctx = await tierContextFor(existing.workspaceId ?? null);
  const full = { ...existing, ...patch };
  return dualWrite({
    ctx,
    entity: "category",
    op: "upsert",
    id,
    row: full,
    pgWrite: async () => {
      const db = getDb();
      const updateData: Partial<typeof categories.$inferInsert> = {};
      if (patch.name !== undefined) updateData.name = patch.name;
      if (patch.ownedByAgentId !== undefined) updateData.ownedByAgentId = patch.ownedByAgentId;
      if (patch.embeddingProfileId !== undefined) updateData.embeddingProfileId = patch.embeddingProfileId;
      if (patch.position !== undefined) updateData.position = patch.position;
      if (patch.folderPath !== undefined) updateData.folderPath = patch.folderPath;
      if (patch.fsMounts !== undefined) updateData.fsMounts = patch.fsMounts;
      await db.update(categories).set(updateData).where(eq(categories.id, id));
    },
    localWrite: () => localUpdateCategory(id, patch),
  });
}

export async function removeCategory(id: string, dbOverride?: any): Promise<boolean> {
  if (dbOverride) {
  try {
    const { withTransaction } = await import("../shared/config/database.js");
    const deleted = await withTransaction(async (tx: any) => {
      await tx.delete(channels).where(eq(channels.categoryId, id));
      return tx.delete(categories).where(eq(categories.id, id)).returning();
    });
    return deleted.length > 0;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; removeCategory ${id} served locally`);
  }
  }
  const existing = await getCategoryById(id);
  if (!existing) return false;
  const ctx = await tierContextFor(existing.workspaceId ?? null);
  return dualWrite({
    ctx,
    entity: "category",
    op: "delete",
    id,
    row: null,
    pgWrite: async () => {
      const { withTransaction } = await import("../shared/config/database.js");
      const db = getDb();
      await withTransaction(async (tx: any) => {
        await tx.delete(channels).where(eq(channels.categoryId, id));
        await tx.delete(categories).where(eq(categories.id, id));
      });
    },
    localWrite: () => localRemoveCategory(id),
  });
}

const MAX_NUMERIC_CHANNEL_OFFSET = 10_000;
const CHANNEL_DB_PAGE_SIZE = 200;
const CHANNEL_OFFSET_LIMIT_MESSAGE =
  `Numeric channel offsets are limited to ${MAX_NUMERIC_CHANNEL_OFFSET}; use a position:id cursor for deeper pages.`;

class ChannelOffsetLimitError extends RangeError {
  constructor() {
    super(CHANNEL_OFFSET_LIMIT_MESSAGE);
    this.name = "ChannelOffsetLimitError";
  }
}

function compareChannelOrder(a: any, b: any): number {
  const positionDelta = (a.position ?? 0) - (b.position ?? 0);
  if (positionDelta !== 0) return positionDelta;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function mergeChannelRows(pgRows: any[], localRows: any[], cursor: string | null): any[] {
  const byId = new Map<string, any>();
  for (const r of pgRows) byId.set(r.id, r);
  for (const r of localRows) byId.set(r.id, r);
  const merged = [...byId.values()].sort(compareChannelOrder);
  if (cursor) {
    const sep = cursor.indexOf(":");
    if (sep > 0) {
      const pos = Number(cursor.slice(0, sep));
      const cid = cursor.slice(sep + 1);
      if (Number.isFinite(pos) && cid) {
        return merged.filter((r) => (r.position ?? 0) > pos || ((r.position ?? 0) === pos && r.id > cid));
      }
    }
  }
  return merged;
}

function channelKeysetCursor(cursor?: string | null): { position: number; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf(":");
  if (sep <= 0) return null;
  const position = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  return Number.isFinite(position) && id ? { position, id } : null;
}

function channelNumericOffset(cursor?: string | null): number | null {
  if (!cursor) return null;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

export async function listChannels(opts?: { limit?: number; cursor?: string | null; workspaceId?: string | null; db?: any }) {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const cursor = opts?.cursor ?? null;
  const keysetCursor = channelKeysetCursor(cursor);
  const numericOffset = channelNumericOffset(cursor);
  if (opts?.db) {
    const db = opts.db;
    // §30 tenant scope: a named workspace serves scoped + legacy-global rows;
    // no header keeps the legacy unscoped read (default folder / all rows).
    const wsFilter =
      opts.workspaceId && opts.workspaceId.trim()
        ? or(eq(channels.workspaceId, opts.workspaceId), isNull(channels.workspaceId))
        : undefined;
    let keyset: ReturnType<typeof and> | undefined;
    if (keysetCursor) {
      keyset = and(
        isNull(channels.archivedAt),
        sql`(${channels.position}, ${channels.id}) > (${keysetCursor.position}, ${keysetCursor.id})`,
      ) as any;
    }
    // Unprovisioned tenant schema (stale BYODB): the replica cannot
    // answer, so fall through to the local-first union below instead of 500.
    try {
      return await db.query.channels.findMany({
      where: and(
        ...[
          keyset ?? isNull(channels.archivedAt),
          ...(wsFilter ? [wsFilter] : []),
        ] as any[],
      ) as any,
      orderBy: (table: any, { asc }: any) => [asc(table.position), asc(table.id)],
      limit,
      ...(numericOffset ? { offset: numericOffset } : {}),
      });
    } catch (err) {
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[channels] tenant PG schema missing; serving local list`);
    }
  }
  // Direct DB callers retain PostgreSQL OFFSET behavior. Only an in-memory
  // union needs the cap to bound its merge window; schema fallback reaches it.
  if (numericOffset !== null && numericOffset > MAX_NUMERIC_CHANNEL_OFFSET) {
    throw new ChannelOffsetLimitError();
  }
  // Legacy offsets remain available through 10,000. Larger result pages
  // should use `(position, id)` cursors instead of growing an in-memory merge.
  const targetCount = numericOffset === null ? limit : numericOffset + limit;
  const localSnapshot = await localChannelListSnapshot({
    limit: targetCount,
    cursor: keysetCursor ? cursor : null,
    workspaceId: opts?.workspaceId ?? null,
  });
  // One Local file read supplies both the visible page and shadow IDs. Check
  // only this bounded PG candidate batch; no IDs become SQL bind parameters.
  const localIdSnapshot = localSnapshot.ids;
  const localRows = localSnapshot.rows;
  const pgRows: any[] = [];
  let scanCursor = keysetCursor;

  while (true) {
    const batch = await pgCatchNull(() => getDb().query.channels.findMany({
      where: and(
        ...[
          isNull(channels.archivedAt),
          ...(opts?.workspaceId && opts.workspaceId.trim()
            ? [or(eq(channels.workspaceId, opts.workspaceId), isNull(channels.workspaceId))]
            : []),
          ...(scanCursor
            ? [sql`(${channels.position}, ${channels.id}) > (${scanCursor.position}, ${scanCursor.id})`]
            : []),
        ] as any[],
      ) as any,
      orderBy: (table: any, { asc }: any) => [asc(table.position), asc(table.id)],
      limit: CHANNEL_DB_PAGE_SIZE,
    })).then((rows) => rows ?? []);

    if (batch.length === 0) break;
    const candidateIds = new Set(batch.map((row: any) => row.id as string));
    const shadowedIds = new Set([...candidateIds].filter((id) => localIdSnapshot.has(id)));
    pgRows.push(...batch.filter((row: any) => !shadowedIds.has(row.id)));

    const lastScanned = batch[batch.length - 1];
    const nextCursor = { position: Number(lastScanned.position), id: String(lastScanned.id) };
    if (
      !Number.isFinite(nextCursor.position) ||
      !nextCursor.id ||
      (scanCursor && compareChannelOrder(nextCursor, scanCursor) <= 0)
    ) {
      throw new Error("Channel list query did not advance its keyset cursor");
    }
    scanCursor = nextCursor;

    const candidates = mergeChannelRows(pgRows, localRows, keysetCursor ? cursor : null);
    if (
      candidates.length >= targetCount &&
      compareChannelOrder(scanCursor, candidates[targetCount - 1]) >= 0
    ) {
      break;
    }
    if (batch.length < CHANNEL_DB_PAGE_SIZE) break;
  }

  const merged = mergeChannelRows(pgRows, localRows, keysetCursor ? cursor : null);
  return numericOffset === null
    ? merged.slice(0, limit)
    : merged.slice(numericOffset, numericOffset + limit);
}

export async function createChannel(body: CreateChannelBody, dbOverride?: any, workspaceId?: string | null) {
  const categoryId = (body as any).categoryId ?? null;
  // Tenant resolution moved BEFORE the guards (QA audit 2026-09-23): the
  // owning workspace is the explicit scope, else the parent category's
  // workspace, else fail closed so a row can never land in default.
  const wsResolved: string | null = (workspaceId && String(workspaceId).trim())
    ? String(workspaceId).trim()
    : (categoryId ? ((await getCategoryById(categoryId).catch(() => null)) as { workspaceId?: string | null } | null)?.workspaceId ?? null : null);
  if (dbOverride) {
  try {
    const db = dbOverride;
    const [categoryOk, existingSameName] = await Promise.all([
      categoryId ? categoryExists(categoryId, db) : Promise.resolve(true),
      db.query.channels.findFirst({
        // CHN-002/003 (db-handle parity): compare lower(name) on both sides and
        // skip archived rows, matching the service path. Workspace scoping of
        // this legacy path is still open (CHN-013).
        where: (table: any, { and, eq, isNull, sql }: any) => and(
          sql`lower(${table.name}) = ${body.name.trim().toLowerCase()}`,
          categoryId ? eq(table.categoryId, categoryId) : isNull(table.categoryId),
          isNull(table.archivedAt),
        )
      }),
    ]);
    if (categoryId && !categoryOk) {
      return { error: "category", categoryId } as const;
    }
    if (existingSameName) {
      return { error: "duplicate_name", name: body.name } as const;
    }
    const id = randomUUID();
    const [res] = await db
      .insert(channels)
      .values({
        id,
        categoryId,
        workspaceId: workspaceId ?? null,
        name: body.name,
        type: body.type,
        createdBy: body.createdBy,
        position: body.position,
      })
      .returning();
    return { channel: res } as const;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; createChannel served locally`);
  }
  }

  // Union-aware guards across both tiers.
  // CHN-007: scope the parent-category check to the resolved workspace.
  if (categoryId && !(await categoryExists(categoryId, undefined, wsResolved))) {
    return { error: "category", categoryId } as const;
  }
  if (!(wsResolved && String(wsResolved).trim())) {
    // Tenant guard (QA audit 2026-09-23): resolve the owning workspace
    // BEFORE the guards; a headerless create must never land in default.
    return { error: "category", categoryId: categoryId || "(missing workspace scope)" } as const;
  }
  const ws = wsResolved as string;
  const dupCheck = await Promise.all([
    (async () => {
      // Dup guard is workspace-scoped (§30): two workspaces may each own a
      // null-category channel with the same name; an unscoped scan would
      // report a cross-workspace false duplicate.
      const rows = await localListChannels({ limit: 200, workspaceId: ws });
      return rows.some(
        (r: any) =>
          String(r.name).trim().toLowerCase() === body.name.trim().toLowerCase() &&
          (r.categoryId ?? null) === categoryId,
      );
    })(),
    pgCatchNull(() =>      getDb().query.channels.findFirst({
        // CHN-002: compare lower(name) on BOTH sides. Rows store the name
        // verbatim, so eq(name, lower(input)) missed case variants.
        // CHN-003: archived rows are reusable names on both tiers, so the PG
        // guard must skip them exactly like the local scan (localListChannels
        // filters archivedAt === null) and localCreateChannel do.
        where: (table: any, { and, eq, isNull, sql }: any) => and(
          sql`lower(${table.name}) = ${body.name.trim().toLowerCase()}`,
          categoryId ? eq(table.categoryId, categoryId) : isNull(table.categoryId),
          eq(table.workspaceId, ws),
          isNull(table.archivedAt),
        ),
      }),
    ).then((r) => Boolean(r)),
  ]).catch(() => [false, false]);
  if (dupCheck[0] || dupCheck[1]) {
    return { error: "duplicate_name", name: body.name } as const;
  }

  const id = randomUUID();
  // Canon: categories and channels live inside one workspace folder, so a
  // channel created under a category belongs to that category's workspace
  // unless the caller named one explicitly. Deriving it here keeps the two
  // rows in the same folder instead of splitting them across scopes.
  const ctx = await tierContextFor(ws);
  const pgValues = {
    id,
    categoryId,
    workspaceId: ws,
    name: body.name,
    type: body.type,
    createdBy: body.createdBy,
    position: body.position,
  };
  return dualWrite({
    ctx,
    entity: "channel",
    op: "upsert",
    id,
    row: { ...pgValues, folderPath: null, createdAt: new Date().toISOString(), archivedAt: null, archivedReason: null },
    pgWrite: async () => {
      const db = getDb();
      await db.insert(channels).values(pgValues);
    },
    localWrite: () =>
      localCreateChannel({ ...(body as any), id, categoryId, workspaceId: ws }),
  });
}

export async function getChannel(id: string, dbOverride?: any) {
  if (dbOverride) {
    try {
      return await dbOverride.query.channels.findFirst({
      where: eq(channels.id, id),
    });
    } catch (err) {
      // Unprovisioned tenant schema (stale BYODB): answer from local.
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[channels] tenant PG schema missing; getChannel ${id} served locally`);
    }
  }
  return (await localGetChannel(id)) ?? (await pgCatchNull(() => getDb().query.channels.findFirst({ where: eq(channels.id, id) })));
}

export async function updateChannel(id: string, body: UpdateChannelBody, dbOverride?: any) {
  if (dbOverride) {
  try {
    const db = dbOverride;
    const [existing, categoryOk] = await Promise.all([
      getChannel(id, db),
      (body as any).categoryId ? categoryExists((body as any).categoryId, db) : Promise.resolve(true),
    ]);
    if (!existing) return { notFound: true } as const;
    if ((body as any).categoryId && !categoryOk) {
      return { error: "category", categoryId: (body as any).categoryId } as const;
    }
    const updateData: Partial<typeof channels.$inferInsert> = {};
    if ((body as any).categoryId !== undefined) updateData.categoryId = (body as any).categoryId;
    if ((body as any).folderPath !== undefined) updateData.folderPath = (body as any).folderPath;
    if ((body as any).fsMounts !== undefined) updateData.fsMounts = (body as any).fsMounts;
    if ((body as any).name !== undefined) updateData.name = (body as any).name;
    if ((body as any).position !== undefined) updateData.position = (body as any).position;
    if ((body as any).type !== undefined) {
      updateData.type = (body as any).type;
      updateData.archivedAt = (body as any).type === "archived" ? new Date() : null;
    }
    const [updated] = await db
      .update(channels)
      .set(updateData)
      .where(eq(channels.id, id))
      .returning();
    return { channel: updated } as const;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; updateChannel ${id} served locally`);
  }
  }

  const existing = await getChannel(id);
  if (!existing) return { notFound: true } as const;
  const patch = body as any;
  if (patch.categoryId && !(await categoryExists(patch.categoryId))) {
    return { error: "category", categoryId: patch.categoryId } as const;
  }
  // CHN-001: renames need the same duplicate-name guard as creates.
  // Without it a rename silently collides into an existing (name, category).
  if (typeof patch.name === "string" && patch.name.trim() && patch.name.trim() !== (existing as any).name) {
    const targetCat = patch.categoryId !== undefined ? patch.categoryId : (existing as any).categoryId ?? null;
    const ws = (existing as any).workspaceId ?? null;
    const [localRows, pgClash] = await Promise.all([
      localListChannels({ limit: 200, workspaceId: ws }),
      // Tier parity: the local scan only sees local rows, so a PG-only
      // (legacy) duplicate would let the rename through in dual mode.
      pgCatchNull(() =>
        getDb().query.channels.findFirst({
          where: (table: any, { and, eq, isNull, ne, sql }: any) => and(
            sql`lower(${table.name}) = ${patch.name.trim().toLowerCase()}`,
            targetCat ? eq(table.categoryId, targetCat) : isNull(table.categoryId),
            isNull(table.archivedAt),
            ne(table.id, id),
          ),
        }),
      ).then((r) => Boolean(r)),
    ]);
    const localClash = localRows.some(
      (r: any) => r.id !== id && String(r.name).trim().toLowerCase() === patch.name.trim().toLowerCase() && (r.categoryId ?? null) === targetCat,
    );
    if (localClash || pgClash) return { error: "duplicate_name", name: patch.name } as const;
  }
  const ctx = await tierContextFor(existing.workspaceId ?? null);
  // EVT-04: channel mutation may change ownership — drop the memoized
  // events workspace so the next record re-resolves.
  try {
    const { eventsGate } = await import("../events/events-gate.js");
    (eventsGate as unknown as { invalidateChannelWorkspace?: (id: string) => void }).invalidateChannelWorkspace?.(id);
  } catch {}
  const full = { ...existing };
  if (patch.categoryId !== undefined) full.categoryId = patch.categoryId;
  if (patch.folderPath !== undefined) full.folderPath = patch.folderPath;
  if (patch.name !== undefined) full.name = patch.name;
  if (patch.position !== undefined) full.position = patch.position;
  if (patch.type !== undefined) {
    full.type = patch.type;
    full.archivedAt = patch.type === "archived" ? new Date().toISOString() : null;
  }
  return dualWrite({
    ctx,
    entity: "channel",
    op: "upsert",
    id,
    row: full,
    pgWrite: async () => {
      const db = getDb();
      const updateData: Partial<typeof channels.$inferInsert> = {};
      if (patch.categoryId !== undefined) updateData.categoryId = patch.categoryId;
      if (patch.folderPath !== undefined) updateData.folderPath = patch.folderPath;
      if (patch.fsMounts !== undefined) updateData.fsMounts = patch.fsMounts;
      if (patch.name !== undefined) updateData.name = patch.name;
      if (patch.position !== undefined) updateData.position = patch.position;
      if (patch.type !== undefined) {
        updateData.type = patch.type;
        updateData.archivedAt = patch.type === "archived" ? new Date() : null;
      }
      await db.update(channels).set(updateData).where(eq(channels.id, id));
    },
    localWrite: () => localUpdateChannel(id, patch),
  });
}

// ─── Channel settings (§6-8 pins) ─────────────────────────────────────
// Local-first: local row wins, PG covers legacy rows. Writes land locally
// always and PG best-effort (never 500 on a dead database).
//
// §30 isolation: settings are keyed by the (channelId, workspaceId) PAIR.
// A bare channel id is not a unique key across workspaces — two workspaces can
// each own a channel with the same id — so every read and write resolves the
// workspace scope first. The scope comes from the caller when known, else from
// the channel row itself, else the documented "default" unscoped placeholder.
const PINNED_RUNTIMES = new Set(["conversational", "agentic", "swarm", "coding", "research"]);

/** Unscoped placeholder used across this codebase ("?? default"). */
const DEFAULT_WORKSPACE_SCOPE = "default";

export interface ChannelSettingsPatch {
  pinnedRuntime?: string | null;
  activeAgentId?: string | null;
  defaultAgentId?: string | null;
}

/**
 * Resolve the workspace scope for a channel's settings. Prefers the caller's
 * explicit scope, then the channel row's own workspaceId (server truth), then
 * the documented default. Never throws — a failed lookup degrades to default.
 */
async function settingsWorkspaceScope(channelId: string, explicit?: string | null): Promise<string> {
  if (explicit && explicit.trim()) return explicit;
  try {
    const channel = await getChannel(channelId);
    const ws = (channel as { workspaceId?: string | null } | null | undefined)?.workspaceId;
    if (ws && ws.trim()) return ws;
  } catch {
    // fall through to the default scope
  }
  // CHN-010: the default fallback is now LOUD. A temporarily-unreadable
  // channel row used to silently misfile pins into the default scope.
  console.warn(`[channels] settings scope for ${channelId} unresolved; using default scope`);
  return DEFAULT_WORKSPACE_SCOPE;
}

export async function getChannelSettings(channelId: string, dbOverride?: any, workspaceId?: string | null) {
  const scope = await settingsWorkspaceScope(channelId, workspaceId);
  // CHN-011: an explicit handle pins PG first (was: local won even with a
  // db override, unlike every other op). Local stays the fallback.
  if (dbOverride) {
    const row = await dbOverride.query.channelSettings.findFirst({
      where: and(eq(channelSettings.channelId, channelId), eq(channelSettings.workspaceId, scope)),
    }).catch(() => null);
    if (row) return row;
  }
  const local = await localGetChannelSettings(channelId, scope);
  if (local) return local;
  if (dbOverride) return null;
  const pg = await pgCatchNull(() =>
    getDb().query.channelSettings.findFirst({
      where: and(eq(channelSettings.channelId, channelId), eq(channelSettings.workspaceId, scope)),
    }),
  );
  if (pg) return { channelId: pg.channelId, workspaceId: pg.workspaceId, pinnedRuntime: pg.pinnedRuntime, activeAgentId: pg.activeAgentId, defaultAgentId: pg.defaultAgentId, updatedAt: pg.updatedAt };
  return null;
}

export async function updateChannelSettings(channelId: string, patch: ChannelSettingsPatch, dbOverride?: any, workspaceId?: string | null) {
  if (patch.pinnedRuntime !== undefined && patch.pinnedRuntime !== null && !PINNED_RUNTIMES.has(patch.pinnedRuntime)) {
    return { error: "pinned_runtime", pinnedRuntime: patch.pinnedRuntime } as const;
  }
  const scope = await settingsWorkspaceScope(channelId, workspaceId);
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.pinnedRuntime !== undefined) values.pinnedRuntime = patch.pinnedRuntime;
  if (patch.activeAgentId !== undefined) values.activeAgentId = patch.activeAgentId;
  if (patch.defaultAgentId !== undefined) values.defaultAgentId = patch.defaultAgentId;
  const scopeWhere = (table: typeof channelSettings) =>
    and(eq(table.channelId, channelId), eq(table.workspaceId, scope));
  if (dbOverride) {
  try {
    const db = dbOverride;
    const existing = await db.query.channelSettings.findFirst({ where: scopeWhere(channelSettings) });
    if (!existing) {
      const [inserted] = await db.insert(channelSettings).values({ channelId, workspaceId: scope, ...values } as any).returning();
      return { settings: inserted } as const;
    }
    const [updated] = await db.update(channelSettings).set(values as any).where(scopeWhere(channelSettings)).returning();
    return { settings: updated } as const;
  } catch (err) {
    if (!isSchemaMismatchError(err)) throw err;
    console.warn(`[channels] tenant PG schema missing; updateChannelSettings served locally`);
  }
  }
  // CHN-032/CHN-008: settings now run through dualWrite like every other
  // write — local commit FIRST, PG replica second, and a failed replica leg
  // is queued on the outbox (replayed by CHN-009) with dualWrite's warn.
  // Was: PG attempted first, local second, no queue, no convergence path.
  const ctx = await tierContextFor(scope);
  // Partial patch semantics: only supplied pins ride the PG leg (and the
  // outbox row), so an unspecified pin is never nulled in PG. Absent keys
  // insert as NULL, exactly like the pre-dualWrite upsert did.
  const pgSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.pinnedRuntime !== undefined) pgSet.pinnedRuntime = patch.pinnedRuntime;
  if (patch.activeAgentId !== undefined) pgSet.activeAgentId = patch.activeAgentId;
  if (patch.defaultAgentId !== undefined) pgSet.defaultAgentId = patch.defaultAgentId;
  const replicaRow: Record<string, unknown> = {
    channelId,
    workspaceId: scope,
    ...pgSet,
    updatedAt: new Date().toISOString(),
  };
  const settings = await dualWrite({
    ctx,
    entity: "channelSettings",
    op: "upsert",
    id: channelId,
    row: replicaRow,
    pgWrite: async () => {
      const db = getDb();
      // Column-split ownership: fs_policy/safety_settings belong to the
      // safety routes — the pin upsert must never clobber them.
      await db
        .insert(channelSettings)
        .values({ channelId, workspaceId: scope, ...pgSet } as any)
        .onConflictDoUpdate({
          target: [channelSettings.channelId, channelSettings.workspaceId],
          set: pgSet as any,
        });
    },
    localWrite: () => localUpsertChannelSettings(channelId, patch, scope),
  });
  return { settings } as const;
}

export async function deleteChannel(id: string, dbOverride?: any) {
  if (dbOverride) {
    try {
    const db = dbOverride;
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
    } catch (err) {
      // Unprovisioned tenant schema: fall through to the local-first path.
      if (!isSchemaMismatchError(err)) throw err;
      console.warn(`[channels] tenant PG schema missing; deleteChannel ${id} served locally`);
    }
  }
  const existing = await getChannel(id);
  if (!existing) return { notFound: true } as const;
  if (existing.categoryId === null && String(existing.name).toLowerCase() === "general") {
    return { conflictGeneral: true } as const;
  }
  const ctx = await tierContextFor(existing.workspaceId ?? null);
  return dualWrite({
    ctx,
    entity: "channel",
    op: "delete",
    id,
    row: null,
    pgWrite: async () => {
      const db = getDb();
      await db.delete(channels).where(eq(channels.id, id));
    },
    localWrite: () => localDeleteChannel(id),
  });
}

// ─── Local workspace seeding (gate port for routes/workspace.ts) ────────
// CHN-020: Workspace provisioning used to dynamic-import channel-local-store
// directly, making this domain's internals a de-facto cross-domain API. This
// port owns the seed shape; the route switches to it in the integration step.

/**
 * Seed the default category + #general channel into a LOCAL workspace folder.
 * Idempotent: an existing (name, category) pair returns the existing rows
 * instead of duplicating, so repeated provisioning never piles up rows.
 */
export async function seedLocalChannelPresets(workspaceId: string): Promise<{ category: any; channel: any }> {
  if (!workspaceId || !String(workspaceId).trim()) {
    throw new Error("seedLocalChannelPresets: workspaceId is required");
  }
  const ws = String(workspaceId).trim();
  let category = (await localListCategoriesWithChannels({ workspaceId: ws }))
    .find((c: any) => String(c.name).trim().toLowerCase() === "general") ?? null;
  if (!category) {
    category = await localCreateCategory({ name: "General", workspaceId: ws, createdBy: "system", position: 0 });
  }
  const channel =
    (await localGetChannelByName("general", category.id, ws)) ??
    (await (async () => {
      const created = await localCreateChannel({
        name: "general",
        type: "standard",
        createdBy: "system",
        categoryId: category.id,
        workspaceId: ws,
        position: 0,
      });
      // A concurrent seed may have won the race: fall back to the row.
      if ((created as any).channel) return (created as any).channel;
      return await localGetChannelByName("general", category.id, ws);
    })());
  return { category, channel };
}

/** First non-archived local row with this (lowercased) name, or null. */
async function localGetChannelByName(
  name: string,
  categoryId: string | null,
  workspaceId: string,
): Promise<any | null> {
  const rows = await localListChannels({ limit: 200, workspaceId });
  return (
    rows.find(
      (r: any) =>
        String(r.name).trim().toLowerCase() === name.trim().toLowerCase() &&
        (r.categoryId ?? null) === categoryId,
    ) ?? null
  );
}

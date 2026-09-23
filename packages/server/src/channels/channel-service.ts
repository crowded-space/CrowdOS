import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, dualWrite } from "../shared/config/database.js";
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

export async function categoryExists(categoryId: string, dbOverride?: any): Promise<boolean> {
  if (dbOverride) {
    const category = await dbOverride.query.categories.findFirst({
      where: eq(categories.id, categoryId),
    });
    return Boolean(category);
  }
  if (await localCategoryExists(categoryId)) return true;
  const found = await pgCatchNull(() =>
    getDb().query.categories.findFirst({ where: eq(categories.id, categoryId) }),
  );
  return Boolean(found);
}

export async function getCategoryById(id: string, dbOverride?: any): Promise<any | null> {
  if (dbOverride) return dbOverride.query.categories.findFirst({ where: eq(categories.id, id) });
  return (await localGetCategory(id)) ?? (await pgCatchNull(() => getDb().query.categories.findFirst({ where: eq(categories.id, id) })));
}

export async function listCategories(opts?: { limit?: number; offset?: number; workspaceId?: string | null; db?: any }) {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  const offset = Math.max(0, opts?.offset ?? 0);
  if (opts?.db) {
    return opts.db.query.categories.findMany({
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
    const [res] = await dbOverride.insert(categories).values(pgValues).returning();
    return res;
  }
  const ctx = await tierContextFor(body.workspaceId ?? null);
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
    const db = dbOverride;
    const updateData: Partial<typeof categories.$inferInsert> = {};
    if (patch.name !== undefined) updateData.name = patch.name;
    if (patch.ownedByAgentId !== undefined) updateData.ownedByAgentId = patch.ownedByAgentId;
    if (patch.embeddingProfileId !== undefined) updateData.embeddingProfileId = patch.embeddingProfileId;
    if (patch.position !== undefined) updateData.position = patch.position;
    if (patch.folderPath !== undefined) updateData.folderPath = patch.folderPath;
    const [updated] = await db.update(categories).set(updateData).where(eq(categories.id, id)).returning();
    return updated ?? null;
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
      await db.update(categories).set(updateData).where(eq(categories.id, id));
    },
    localWrite: () => localUpdateCategory(id, patch),
  });
}

export async function removeCategory(id: string, dbOverride?: any): Promise<boolean> {
  if (dbOverride) {
    const { withTransaction } = await import("../shared/config/database.js");
    const deleted = await withTransaction(async (tx: any) => {
      await tx.delete(channels).where(eq(channels.categoryId, id));
      return tx.delete(categories).where(eq(categories.id, id)).returning();
    });
    return deleted.length > 0;
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

function mergeChannelLists(pgRows: any[], localRows: any[], limit: number, cursor: string | null): any[] {
  const byId = new Map<string, any>();
  for (const r of pgRows) byId.set(r.id, r);
  for (const r of localRows) byId.set(r.id, r);
  const merged = [...byId.values()].sort((a, b) => {
    const pos = (a.position ?? 0) - (b.position ?? 0);
    if (pos !== 0) return pos;
    return a.id < b.id ? -1 : 1;
  });
  if (cursor) {
    const sep = cursor.indexOf(":");
    if (sep > 0) {
      const pos = Number(cursor.slice(0, sep));
      const cid = cursor.slice(sep + 1);
      if (Number.isFinite(pos) && cid) {
        const idx = merged.findIndex(
          (r) => (r.position ?? 0) > pos || ((r.position ?? 0) === pos && r.id > cid),
        );
        return (idx === -1 ? [] : merged.slice(idx)).slice(0, limit);
      }
    }
    const parsed = Number(cursor);
    if (Number.isFinite(parsed) && parsed >= 0) return merged.slice(Math.floor(parsed), Math.floor(parsed) + limit);
  }
  return merged.slice(0, limit);
}

export async function listChannels(opts?: { limit?: number; cursor?: string | null; db?: any }) {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 200));
  if (opts?.db) {
    const db = opts.db;
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
  const [pgRows, localRows] = await Promise.all([
    pgCatchNull(() =>      getDb().query.channels.findMany({
        where: isNull(channels.archivedAt),
        orderBy: (table: any, { asc }: any) => [asc(table.position), asc(table.id)],
        limit: 200,
      }),
    ).then((rows) => rows ?? []),
    localListChannels({ limit: 200 }),
  ]);
  return mergeChannelLists(pgRows, localRows, limit, opts?.cursor ?? null);
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
    const db = dbOverride;
    const [categoryOk, existingSameName] = await Promise.all([
      categoryId ? categoryExists(categoryId, db) : Promise.resolve(true),
      db.query.channels.findFirst({
        where: (table: any, { and, eq, isNull }: any) => and(
          eq(table.name, body.name.trim().toLowerCase()),
          categoryId ? eq(table.categoryId, categoryId) : isNull(table.categoryId)
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
  }

  // Union-aware guards across both tiers.
  if (categoryId && !(await categoryExists(categoryId))) {
    return { error: "category", categoryId } as const;
  }
  if (!(wsResolved && String(wsResolved).trim())) {
    // Tenant guard (QA audit 2026-09-23): resolve the owning workspace
    // BEFORE the guards; a headerless create must never land in default.
    return { error: "category", categoryId: categoryId || "(missing workspace scope)" } as const;
  }
  const dupCheck = await Promise.all([
    (async () => {
      const rows = await localListChannels({ limit: 200 });
      return rows.some(
        (r: any) =>
          String(r.name).trim().toLowerCase() === body.name.trim().toLowerCase() &&
          (r.categoryId ?? null) === categoryId,
      );
    })(),
    pgCatchNull(() =>      getDb().query.channels.findFirst({
        where: (table: any, { and, eq, isNull }: any) => and(
          eq(table.name, body.name.trim().toLowerCase()),
          categoryId ? eq(table.categoryId, categoryId) : isNull(table.categoryId)
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
  const ws = wsResolved as string;
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
    return dbOverride.query.channels.findFirst({
      where: eq(channels.id, id),
    });
  }
  return (await localGetChannel(id)) ?? (await pgCatchNull(() => getDb().query.channels.findFirst({ where: eq(channels.id, id) })));
}

export async function updateChannel(id: string, body: UpdateChannelBody, dbOverride?: any) {
  if (dbOverride) {
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
  }

  const existing = await getChannel(id);
  if (!existing) return { notFound: true } as const;
  const patch = body as any;
  if (patch.categoryId && !(await categoryExists(patch.categoryId))) {
    return { error: "category", categoryId: patch.categoryId } as const;
  }
  const ctx = await tierContextFor(existing.workspaceId ?? null);
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
  return DEFAULT_WORKSPACE_SCOPE;
}

export async function getChannelSettings(channelId: string, dbOverride?: any, workspaceId?: string | null) {
  const scope = await settingsWorkspaceScope(channelId, workspaceId);
  const local = await localGetChannelSettings(channelId, scope);
  if (local || dbOverride) {
    if (local) return local;
    const row = await dbOverride.query.channelSettings.findFirst({
      where: and(eq(channelSettings.channelId, channelId), eq(channelSettings.workspaceId, scope)),
    });
    return row ?? null;
  }
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
    const db = dbOverride;
    const existing = await db.query.channelSettings.findFirst({ where: scopeWhere(channelSettings) });
    if (!existing) {
      const [inserted] = await db.insert(channelSettings).values({ channelId, workspaceId: scope, ...values } as any).returning();
      return { settings: inserted } as const;
    }
    const [updated] = await db.update(channelSettings).set(values as any).where(scopeWhere(channelSettings)).returning();
    return { settings: updated } as const;
  }
  await pgCatchNull(async () => {
    const db = getDb();
    const existing = await db.query.channelSettings.findFirst({ where: scopeWhere(channelSettings) });
    if (!existing) {
      await db.insert(channelSettings).values({ channelId, workspaceId: scope, ...values } as any);
    } else {
      await db.update(channelSettings).set(values as any).where(scopeWhere(channelSettings));
    }
  });
  const settings = await localUpsertChannelSettings(channelId, patch, scope);
  return { settings } as const;
}

export async function deleteChannel(id: string, dbOverride?: any) {
  if (dbOverride) {
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
